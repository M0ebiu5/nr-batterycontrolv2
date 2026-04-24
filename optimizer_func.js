// ============================================================
// Battery Controller v2 - Cost Optimization Algorithm
// ============================================================
// Battery: 30 kWh, charger max 3500W, min SOC 3%
// States: 1=charge from grid, 3=compensate load, 4=max discharge
// Grid fee: +13 ct/kWh, reduced 20% in months 4-9 between 10:00-16:00
// Hard rule: NEVER feed in at negative market prices (we'd pay the grid)
// ============================================================

const BATTERY_CAPACITY_KWH = 30;
const MAX_CHARGE_W = 3500;
const MAX_DISCHARGE_W = 3500;
const AVG_LOAD_W = 700;
const MIN_SOC_PCT = 3;
const INTERVAL_HOURS = 0.25; // 15 minutes
const PV_PEAK_W = 5000;
const BASE_GRID_FEE = 13; // ct/kWh
const TIMEZONE = 'Europe/Berlin';

// Timezone-aware time extraction (all logic must use local Berlin time, not UTC)
const _tzFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour: 'numeric', minute: 'numeric', month: 'numeric', hour12: false
});
function berlinTime(timeMs) {
    const parts = _tzFmt.formatToParts(new Date(timeMs));
    const get = type => parseInt(parts.find(p => p.type === type).value);
    return { hour: get('hour'), minute: get('minute'), month: get('month') };
}

// --- Parse inputs ---
// influxdb in nodes return arrays of {time, field1, field2, ...}
const raw = msg.payload;
const weather = msg.weather || {};

function lastVal(arr, field) {
    if (!arr || !arr.length) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i][field] !== null && arr[i][field] !== undefined) return arr[i][field];
    }
    return null;
}

function toTimeSeries(arr, field) {
    if (!arr || !arr.length) return [];
    return arr.filter(r => r[field] !== null && r[field] !== undefined).map(r => ({
        time: typeof r.time === 'number' ? r.time : new Date(r.time).getTime(),
        value: r[field]
    }));
}

// Current SOC
let currentSoc = lastVal(raw.soc, 'soc');
if (currentSoc === null) currentSoc = 50; // fallback

// Current AC load
let currentLoad = lastVal(raw.acload, 'acload');
if (currentLoad === null) currentLoad = AVG_LOAD_W;

// Current battery power
let currentPower = lastVal(raw.power, 'power');

// Current actual PV power from inverter
let currentPvPower = lastVal(raw.pv_now, 'pv_now');
if (currentPvPower === null) currentPvPower = 0;

// Price forecast
const prices = toTimeSeries(raw.prices, 'marketprice');

// Solar forecast (sunshine minutes per hour)
const solarMinutes = toTimeSeries(raw.solar, 'sunshineDurationInMinutes');

// Load history for hourly pattern
const loadHistory = toTimeSeries(raw.load_history, 'avg_load');

// Build hourly load pattern (0-23h). Query returns one row per hour
// over the last N days; aggregate across days per hour-of-day using
// median so a single spike day (EV charge, heater, etc.) can't poison
// the forecast. Fall back to AVG_LOAD_W for hours with <3 samples.
const hourlyLoad = new Array(24).fill(AVG_LOAD_W);
const loadByHour = new Array(24).fill(null).map(() => []);
for (const lh of loadHistory) {
    if (lh.value > 0) loadByHour[berlinTime(lh.time).hour].push(lh.value);
}
for (let h = 0; h < 24; h++) {
    const vals = loadByHour[h];
    if (vals.length < 3) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    hourlyLoad[h] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// PV history for hourly production profile, filtered by similar calendar period
const pvHistoryRaw = raw.pv_history || [];

// Filter to ±15 days of current day-of-year (same season from previous years).
// Use Date.now() (not `new Date()`) so this respects time mocks in tests:
// `new Date()` bypasses a mocked Date.now and reads V8's wall clock directly.
const nowDate = new Date(Date.now());
const dayOfYear = Math.floor((nowDate.getTime() - new Date(nowDate.getFullYear(), 0, 0).getTime()) / 86400000);
const pvHistoryFiltered = pvHistoryRaw.filter(r => {
    const t = typeof r.time === 'number' ? new Date(r.time) : new Date(r.time);
    const doy = Math.floor((t.getTime() - new Date(t.getFullYear(), 0, 0).getTime()) / 86400000);
    const diff = Math.abs(doy - dayOfYear);
    return Math.min(diff, 365 - diff) <= 15;
});

// Build per-day profiles: { dateStr: { peak, hours: {h: avgPv} } }
const pvDays = {};
for (const r of pvHistoryFiltered) {
    if (r.avg_pv === null && r.max_pv === null) continue;
    const t = typeof r.time === 'number' ? new Date(r.time) : new Date(r.time);
    const dateStr = t.toISOString().slice(0, 10);
    const h = berlinTime(t.getTime()).hour;
    if (!pvDays[dateStr]) pvDays[dateStr] = { peak: 0, hours: {} };
    if (r.avg_pv > 0) pvDays[dateStr].hours[h] = r.avg_pv;
    if (r.max_pv > pvDays[dateStr].peak) pvDays[dateStr].peak = r.max_pv;
}


// Estimate today's expected peak from sunshine forecast
// sunRatio ~1 = full sun → peak ~PV_PEAK_W, sunRatio ~0.3 = cloudy → peak ~1500W
const midDaySunRatio = solarMinutes.length > 0
    ? Math.max(...solarMinutes.map(s => s.value)) / 60
    : (weather.solarradiation > 0 ? Math.min(weather.solarradiation / 1000, 1) : 0.5);
const expectedPeak = midDaySunRatio * PV_PEAK_W;

// Select days with similar peak (within 30% of expected)
const tolerance = Math.max(expectedPeak * 0.3, 500);
const matchingDates = Object.keys(pvDays).filter(d =>
    Math.abs(pvDays[d].peak - expectedPeak) <= tolerance && pvDays[d].peak > 200
);

// Build hourly PV profile from matching days, fallback to all days
const hourlyPv = new Array(24).fill(0);
const baselineMatched = matchingDates.length >= 3;
const sourceDates = baselineMatched ? matchingDates : Object.keys(pvDays);
// What sunshine ratio does the baseline represent? If we matched today's
// peak, the baseline reflects midDaySunRatio. If we fell back to ALL days
// (which happens whenever today's forecast is cloudy enough that <3 historical
// days match — including fully-cloudy days with midDaySunRatio ≈ 0), the
// baseline represents typical/sunny days, so the reference is ~1.
const baselineRefRatio = baselineMatched ? Math.max(midDaySunRatio, 0.1) : 1;
const pvByHour = new Array(24).fill(null).map(() => []);
for (const d of sourceDates) {
    for (const [h, val] of Object.entries(pvDays[d].hours)) {
        pvByHour[parseInt(h)].push(val);
    }
}
for (let h = 0; h < 24; h++) {
    if (pvByHour[h].length > 0) {
        hourlyPv[h] = pvByHour[h].reduce((a, b) => a + b, 0) / pvByHour[h].length;
    }
}


if (prices.length === 0) {
    node.warn('No price data available');
    msg.payload = { error: 'No price data available' };
    return msg;
}

// --- Helper functions ---
const now = Date.now();
const sunRise = weather.sunRise ? new Date(weather.sunRise).getTime() : null;
const sunSet = weather.sunSet ? new Date(weather.sunSet).getTime() : null;

function isDaylight(timeMs) {
    if (!sunRise || !sunSet) {
        const h = berlinTime(timeMs).hour;
        return h >= 5 && h <= 18;
    }
    const rise = berlinTime(sunRise);
    const set = berlinTime(sunSet);
    const cur = berlinTime(timeMs);
    const mins = cur.hour * 60 + cur.minute;
    return mins >= (rise.hour * 60 + rise.minute) && mins <= (set.hour * 60 + set.minute);
}

function getSunshineRatio(timeMs) {
    // Find nearest sunshine forecast (hourly data)
    let best = null;
    let bestDist = Infinity;
    for (const sm of solarMinutes) {
        const dist = Math.abs(sm.time - timeMs);
        if (dist < bestDist) {
            bestDist = dist;
            best = sm;
        }
    }
    if (best && bestDist < 2 * 3600 * 1000) {
        return Math.min(best.value / 60, 1); // 0-1 ratio
    }
    // Fallback: use current solar radiation from weather
    if (weather.solarradiation > 0 && isDaylight(timeMs)) {
        return Math.min(weather.solarradiation / 1000, 1);
    }
    return 0;
}

// Strict version: returns the forecast sunshine ratio for the slot, or null
// if the hourly forecast doesn't actually cover this time. Unlike
// getSunshineRatio, it does NOT fall back to the current weather station
// solarradiation — that reading only describes the current moment and would
// silently apply to every slot (wrong). Callers use null to mean "no forecast
// adjustment available" rather than "forecast says zero".
function getSunshineForecast(timeMs) {
    let best = null;
    let bestDist = Infinity;
    for (const sm of solarMinutes) {
        const dist = Math.abs(sm.time - timeMs);
        if (dist < bestDist) {
            bestDist = dist;
            best = sm;
        }
    }
    if (best && bestDist < 90 * 60 * 1000) {
        return Math.min(Math.max(best.value / 60, 0), 1);
    }
    return null;
}

function estimatePvPower(timeMs) {
    if (!isDaylight(timeMs)) return 0;
    const now = Date.now();
    const hoursAhead = (timeMs - now) / (3600 * 1000);
    const h = berlinTime(timeMs).hour;
    const basePvRaw = hourlyPv[h] || 0;

    // Scale the historical-profile baseline by the per-slot sunshine
    // forecast. The raw hourlyPv profile is built from historical days
    // matching today's PEAK sunshine, but (a) on a fully cloudy day the
    // matching filter falls back to ALL days (sunny baseline), and (b) even
    // on a matched day the morning/afternoon forecast can differ from the
    // peak hour. Without this scaling, when PAC=0 AND solarradiation=0 the
    // function falls through to the raw sunny baseline.
    let basePv = basePvRaw;
    const slotForecast = getSunshineForecast(timeMs);
    if (slotForecast !== null && basePvRaw > 0) {
        basePv = basePvRaw * Math.min(slotForecast / baselineRefRatio, 1.2);
    }

    // Correct with real-time data for all remaining daylight slots today:
    // 1. Actual inverter PV power (PAC) — most accurate
    // 2. Solar radiation from weather station — good proxy when PAC unavailable
    // Weather conditions persist, so apply correction broadly with gradual fade.
    if (hoursAhead >= -0.5 && hoursAhead < 8) {
        const currentH = berlinTime(now).hour;
        const basePvNow = hourlyPv[currentH] || 1;
        let scaleFactor = null;

        // Prefer actual PV power from inverter
        if (currentPvPower > 0 && basePvNow > 0) {
            scaleFactor = currentPvPower / basePvNow;
        }
        // Fall back to solar radiation ratio (W/m² vs clear-sky ~1000 W/m²)
        if (scaleFactor === null && weather.solarradiation > 0) {
            const sunRatio = Math.min(weather.solarradiation / 1000, 1);
            scaleFactor = sunRatio / Math.max(getSunshineRatio(now), 0.1);
            scaleFactor = Math.max(0.1, Math.min(scaleFactor, 2.5));
        }

        if (scaleFactor !== null) {
            if (basePvRaw <= 0) return hoursAhead < 0.5 ? (currentPvPower || 0) : 0;
            // Blend: full correction now, fades to 30% correction at +8h
            // Near-term (< 1h): 100% scaled, then gradual taper
            const blend = hoursAhead <= 0 ? 1.0
                : hoursAhead < 1 ? 1.0
                : Math.max(0.3, 1 - (hoursAhead - 1) / 10); // 1.0 at 1h, 0.3 at 8h
            // `scaled` uses the RAW hour baseline * scaleFactor so the PAC
            // correction magnitude is preserved; we blend against the
            // forecast-adjusted basePv (so weaker forecast means weaker far
            // slots even when current PAC is strong).
            const scaled = basePvRaw * scaleFactor;
            return Math.min(basePv * (1 - blend) + scaled * blend, PV_PEAK_W);
        }
    }

    if (basePv <= 0) return 0;

    // Historical profile with rain adjustment for further-out slots
    let rainFactor = 1;
    if (weather.rainrate > 0) rainFactor = 0.3;

    return Math.min(basePv * rainFactor, PV_PEAK_W);
}

function getGridFee(timeMs) {
    const bt = berlinTime(timeMs);
    let fee = BASE_GRID_FEE;
    // 20% reduction in months 4-9, between 10:00-16:00 local time
    if (bt.month >= 4 && bt.month <= 9 && bt.hour >= 10 && bt.hour < 16) {
        fee = fee * 0.8;
    }
    return fee;
}

function getEffectivePrice(marketPrice, timeMs) {
    // Total cost when charging from grid
    return marketPrice + getGridFee(timeMs);
}

function getLoadEstimate(timeMs) {
    const h = berlinTime(timeMs).hour;
    return hourlyLoad[h] || AVG_LOAD_W;
}

function socToKwh(soc) {
    return (soc / 100) * BATTERY_CAPACITY_KWH;
}

function kwhToSoc(kwh) {
    return (kwh / BATTERY_CAPACITY_KWH) * 100;
}

// --- Main optimization ---
// Strategy: plan-based price optimization
//
// Phase 1: Build schedule with PV/load estimates
// Phase 2: Simulate SOC with PV+load only → find energy gaps and surpluses
// Phase 3: Assign grid charging to cheapest slots where energy is needed
// Phase 4: Assign feed-in to most expensive slots where surplus exists or
//          battery capacity is needed for upcoming PV

// Build the schedule array aligned to price data
let schedule = [];

// First pass: compute effective prices and PV estimates
for (const p of prices) {
    const t = p.time;
    const marketPrice = p.value;
    const effPrice = getEffectivePrice(marketPrice, t);
    const pvPower = estimatePvPower(t);
    const loadEst = getLoadEstimate(t);
    const netPv = pvPower - loadEst; // positive = surplus, negative = deficit
    
    schedule.push({
        time: t,
        timeStr: new Date(t).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
        marketPrice: marketPrice,
        effectivePrice: effPrice,
        gridFee: getGridFee(t),
        pvPower: Math.round(pvPower),
        loadEst: Math.round(loadEst),
        netPv: Math.round(netPv),
        state: null,
        predictedSoc: null,
        reason: '',
        acPowerSetPoint: 0
    });
}

// Reserve SOC for the "unplanned window" past the last price slot. The
// next optimizer run will be blind beyond its own horizon until fresh
// prices publish (~24h cadence), so reserve enough to carry through.
// The reserve is weighted by the forecast: sunny tomorrow → low reserve
// (night gap dominates); cloudy/bad forecast → reserve climbs because
// PV never offsets load in the walk. Phase 3 picks up the higher socNeeded
// and plans extra grid charging at the cheapest in-horizon slots.
let _postSchedLoadKwh = 0;
if (schedule.length > 0) {
    const lastSlotEnd = schedule[schedule.length - 1].time + INTERVAL_HOURS * 3600 * 1000;
    // Cover the "blind window" — midnight until the next day's prices
    // publish around 13:00-14:00. Not a full 24h: once new prices arrive,
    // the next optimizer run has full visibility and can plan freely.
    const RESERVE_HOURS = 14;
    const MAX_RESERVE_KWH = 6; // ~20% SOC cap on a 30 kWh battery

    // Fallback PV ratio for walk hours past the forecast window. Average
    // the daylight forecast ratios from the tail of the schedule. <4 tail
    // samples → 0.5 (neutral; not "sunny" default because that would hide
    // bad-weather reserves when the forecast window is short).
    let tomorrowPvRatio = 0.5;
    {
        const tail = [];
        for (let i = schedule.length - 1; i >= 0 && tail.length < 16; i--) {
            const s = schedule[i];
            if (!isDaylight(s.time)) continue;
            const fc = getSunshineForecast(s.time);
            if (fc !== null) tail.push(fc);
        }
        if (tail.length >= 4) {
            tomorrowPvRatio = tail.reduce((a, b) => a + b, 0) / tail.length;
        }
    }

    for (let h = 0; h < RESERVE_HOURS; h++) {
        const t = lastSlotEnd + h * 3600000;
        const loadW = getLoadEstimate(t);
        let pvW = 0;
        if (isDaylight(t)) {
            const basePvRaw = hourlyPv[berlinTime(t).hour] || 0;
            const slotForecast = getSunshineForecast(t);
            const ratio = slotForecast !== null ? slotForecast : tomorrowPvRatio;
            pvW = basePvRaw * Math.min(ratio / Math.max(baselineRefRatio, 0.1), 1.2);
        }
        _postSchedLoadKwh += Math.max(0, loadW - pvW) / 1000; // 1-hour step
    }

    if (_postSchedLoadKwh > MAX_RESERVE_KWH) _postSchedLoadKwh = MAX_RESERVE_KWH;
}

// Compute price statistics for thresholds
const allPrices = schedule.map(s => s.marketPrice);
const avgPrice = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
const minPrice = Math.min(...allPrices);
const maxPrice = Math.max(...allPrices);
const priceRange = maxPrice - minPrice;

// Price range is used for feed-in candidate filtering

// --- Pre-emptive discharge: empty battery before sunny day with negative prices ---
// After ~13:00 tomorrow's prices are known. If tomorrow has strong solar AND
// low/negative prices during solar hours, we should discharge tonight at the
// highest available prices to create free capacity for tomorrow's PV.
let preemptiveDischargeSlots = new Set();
let targetSocForSunrise = null;

(function computePreemptiveDischarge() {
    if (schedule.length < 8) return;

    // Find the glut day = the current or next daylight period. Previously
    // this required a night→day transition, which silently disabled
    // preemptive for any cron run after sunrise on the glut day itself
    // (because tomorrow's prices haven't published yet, so the schedule
    // contains no second sunrise to match). The right glut day to plan
    // for is whatever daylight period is currently in front of us.
    let nextSunriseIdx = -1;
    for (let k = 0; k < schedule.length; k++) {
        if (schedule[k].time < now - 1800000) continue;
        if (isDaylight(schedule[k].time)) {
            nextSunriseIdx = k;
            break;
        }
    }
    if (nextSunriseIdx < 0) return;

    const sunriseTime = schedule[nextSunriseIdx].time;

    // Collect glut day's daylight slots (contiguous from nextSunriseIdx)
    const nextDayDaylightSlots = [];
    for (let k = nextSunriseIdx; k < schedule.length; k++) {
        if (isDaylight(schedule[k].time)) {
            nextDayDaylightSlots.push(schedule[k]);
        } else if (nextDayDaylightSlots.length > 0) {
            break;
        }
    }
    if (nextDayDaylightSlots.length === 0) return;

    // Check tomorrow's daylight prices: count negative/very low price slots
    let negPriceSlots = 0;
    let veryLowSlots = 0;
    for (const s of nextDayDaylightSlots) {
        if (s.marketPrice <= 0) negPriceSlots++;
        if (s.marketPrice < 3) veryLowSlots++;
    }

    // Need at least 1h of negative prices OR 2h of very low prices during daylight
    if (negPriceSlots < 4 && veryLowSlots < 8) return;

    // Estimate tomorrow's PV surplus. Use pvPower from schedule if available (has forecast),
    // otherwise estimate conservatively from today's pattern.
    let totalSurplusKwh = 0;
    let hasForecastPv = false;
    for (const s of nextDayDaylightSlots) {
        if (s.pvPower > 200) hasForecastPv = true;
        const pvEst = s.pvPower > 0 ? s.pvPower : estimatePvPower(s.time);
        const surplusW = Math.max(0, pvEst - s.loadEst);
        totalSurplusKwh += surplusW * INTERVAL_HOURS / 1000;
    }

    // If no PV forecast exists but prices are negative during daylight,
    // that itself signals solar overproduction — estimate conservatively.
    if (!hasForecastPv && negPriceSlots >= 4) {
        // Negative daylight prices = strong solar expected.
        // Conservative estimate: 3kW avg surplus for neg-price hours.
        totalSurplusKwh = Math.max(totalSurplusKwh, negPriceSlots * INTERVAL_HOURS * 3);
    }

    if (totalSurplusKwh < 3) return;

    // Target SOC at sunrise: free capacity = expected PV surplus.
    // Floor is conditional: 20% when neg-prices confirm the glut (external
    // signal, not just forecast), else 35% — forecast alone isn't trusted
    // enough to drain deeper, and a higher floor protects the morning peak
    // if PV underperforms.
    const capacityNeededPct = kwhToSoc(totalSurplusKwh);
    const socFloor = negPriceSlots >= 4 ? 20 : 35;
    targetSocForSunrise = Math.max(socFloor, 100 - capacityNeededPct);
    // Negative daylight prices = solar glut ahead. PV-surplus estimate can
    // underestimate (forecast noise, fallback paths); the neg-price signal
    // is the authoritative cue that capacity will be needed. Force ≤20%.
    if (negPriceSlots >= 4) {
        targetSocForSunrise = Math.min(targetSocForSunrise, 20);
    }

    // Drain deadline: the sunrise AFTER the glut day's sunset. The drain
    // must be complete by then; the glut day itself (morning peak +
    // mid-day trough + evening peak) is INSIDE the eligibility window
    // and competes for slot picks on price.
    //
    // Why not just "next sunrise"? When the optimizer runs pre-dawn on
    // the glut day, "next sunrise" is the start of the glut day — only
    // hours away — and the morning price peak (which is technically
    // "during" the glut day's daylight) gets excluded. Today's PV will
    // refill any SOC drained at the morning peak, so the drain is free
    // revenue. The post-glut sunrise is the right deadline.
    let postGluteSunsetSeen = false;
    let drainDeadlineTime = null;
    for (let k = nextSunriseIdx + 1; k < schedule.length; k++) {
        if (!isDaylight(schedule[k].time)) {
            postGluteSunsetSeen = true;
        } else if (postGluteSunsetSeen) {
            drainDeadlineTime = schedule[k].time;
            break;
        }
    }
    if (drainDeadlineTime === null) {
        // Schedule doesn't extend past the glut day — fall back to
        // schedule end (next planning cycle, with fresher data, will
        // continue from there).
        drainDeadlineTime = schedule[schedule.length - 1].time + INTERVAL_HOURS * 3600 * 1000;
    }

    const eveningSlots = schedule.filter(s =>
        s.time >= now - 1800000 && s.time < drainDeadlineTime
    );
    if (eveningSlots.length === 0) return;

    // Project SOC under PV+load only (no preemptive drain) across the window.
    // Track overflow (curtailed PV above 100%) — that energy is also drainable
    // if we make room for it. Without PV in this calc, drain need is
    // under-estimated whenever the window includes daylight hours.
    let projSocAtSunrise = currentSoc;
    let overflowPct = 0;
    for (const s of eveningSlots) {
        const netKwh = (s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000;
        projSocAtSunrise += kwhToSoc(netKwh);
        if (projSocAtSunrise > 100) {
            overflowPct += projSocAtSunrise - 100;
            projSocAtSunrise = 100;
        }
        if (projSocAtSunrise < MIN_SOC_PCT) projSocAtSunrise = MIN_SOC_PCT;
    }
    const extraDrainNeeded = projSocAtSunrise + overflowPct - targetSocForSunrise;
    if (extraDrainNeeded <= 3) return;

    // Sort by market price descending: discharge at the highest prices first.
    // Skip negative-price slots entirely — never feed to grid when we'd pay.
    const sortedEvening = [...eveningSlots]
        .filter(s => s.marketPrice > 0)
        .sort((a, b) => b.marketPrice - a.marketPrice);

    let extraDrainAccum = 0;
    for (const s of sortedEvening) {
        if (extraDrainAccum >= extraDrainNeeded) break;
        const slotExtraDrain = kwhToSoc(MAX_DISCHARGE_W * INTERVAL_HOURS / 1000);
        preemptiveDischargeSlots.add(s.time);
        extraDrainAccum += slotExtraDrain;
    }

    node.warn(`Preemptive ACTIVE: target=${targetSocForSunrise.toFixed(1)}%, sunrise=${new Date(sunriseTime).toISOString()}, extraDrain=${extraDrainNeeded.toFixed(1)}%, slots=${preemptiveDischargeSlots.size}, surplus=${totalSurplusKwh.toFixed(1)}kWh, negSlots=${negPriceSlots}`);
})();

// Remove past slots, only keep current and future
schedule = schedule.filter(s => s.time >= now - 900000);

const maxChargeEnergy = MAX_CHARGE_W * INTERVAL_HOURS / 1000; // 0.875 kWh per slot
const maxDischargeEnergy = MAX_DISCHARGE_W * INTERVAL_HOURS / 1000;

// ================================================================
// PHASE 2: Simulate SOC with PV + load only (no grid interaction)
// Identify where deficits and surpluses occur
// ================================================================
let passiveSoc = currentSoc;
for (let i = 0; i < schedule.length; i++) {
    const s = schedule[i];
    const pvW = s.pvPower;
    const loadW = s.loadEst;
    const netPvW = pvW - loadW;
    const netEnergy = netPvW * INTERVAL_HOURS / 1000;
    passiveSoc = Math.max(MIN_SOC_PCT, Math.min(100, passiveSoc + kwhToSoc(netEnergy)));
    s._passiveSoc = passiveSoc;
}

// ================================================================
// PHASE 3: Plan charging at cheapest slots and feed-in at most expensive
// ================================================================

// Mark each slot with a planned action: 'charge', 'feedin', or null (compensate)
for (const s of schedule) s._plan = null;

// --- 3a. (removed) Never feed in at negative prices, regardless of magnitude ---

// --- 3b. Force-assign preemptive discharge slots ---
for (const s of schedule) {
    if (preemptiveDischargeSlots.has(s.time)) {
        s._plan = 'feedin_preemptive';
    }
}

// --- 3c. Plan charging: horizon-wide cheapest-slot selection ---
// Iteratively simulate the SOC trajectory across the whole schedule.
// Whenever a slot falls below MIN_SOC+5, pick the cheapest unplanned
// upstream slot — across the WHOLE horizon, including PV-surplus slots —
// and mark it as 'charge'. Grid charging and PV-to-battery are additive
// (Phase 4 state=1 branch), so a cheap mid-day surplus slot is a valid
// candidate for covering an evening deficit. If committing a candidate
// doesn't actually raise SOC at the deficit slot (the extra charge was
// clamped away by a full-battery stretch in between), revert and try the
// next cheapest.
{
    const minTargetSoc = MIN_SOC_PCT + 5;

    function simulateSocTrajectory() {
        let s0 = currentSoc;
        const traj = new Array(schedule.length);
        for (let i = 0; i < schedule.length; i++) {
            const s = schedule[i];
            const pvW = s.pvPower;
            const loadW = s.loadEst;
            if (s._plan === 'charge') {
                // Battery absorbs at most MAX_CHARGE_W total (grid + PV combined).
                s0 += kwhToSoc(maxChargeEnergy);
            } else if (s._plan === 'feedin_preemptive') {
                const drainW = MAX_DISCHARGE_W + loadW - pvW;
                s0 -= kwhToSoc(Math.max(0, drainW) * INTERVAL_HOURS / 1000);
            } else {
                s0 += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
            }
            s0 = Math.max(MIN_SOC_PCT, Math.min(100, s0));
            traj[i] = s0;
        }
        return traj;
    }

    // The final slot must end high enough to survive the post-schedule
    // unplanned window (_postSchedLoadKwh). Every other slot only needs to
    // stay above the plain minTargetSoc floor — PV/charging can refill them.
    const endSlotTarget = minTargetSoc + kwhToSoc(_postSchedLoadKwh);
    const lastIdx = schedule.length - 1;
    function slotTarget(d) {
        return d === lastIdx ? endSlotTarget : minTargetSoc;
    }

    const MAX_CHARGE_PICKS = schedule.length;
    for (let iter = 0; iter < MAX_CHARGE_PICKS; iter++) {
        const traj = simulateSocTrajectory();

        let committed = false;
        // Walk deficits in time order. For each one, try cheapest-first
        // upstream candidates. If none help, move on to the next deficit.
        deficitLoop:
        for (let d = 0; d < schedule.length; d++) {
            if (traj[d] >= slotTarget(d)) continue;

            const eligible = [];
            for (let i = 0; i <= d; i++) {
                const s = schedule[i];
                if (s._plan) continue;
                // Never grid-charge at night during preemptive discharge.
                if (targetSocForSunrise !== null && !isDaylight(s.time) && s.pvPower < 200) continue;
                eligible.push({ idx: i, effPrice: s.effectivePrice });
            }
            eligible.sort((a, b) => a.effPrice - b.effPrice);

            const socBefore = traj[d];
            for (const cand of eligible) {
                schedule[cand.idx]._plan = 'charge';
                const newTraj = simulateSocTrajectory();
                if (newTraj[d] > socBefore + 0.1) {
                    committed = true;
                    break deficitLoop;
                }
                schedule[cand.idx]._plan = null;
            }
        }
        if (!committed) break;
    }
}

// --- 3d. Feed-in planning: discharge at highest prices when we have excess ---
// Excess = SOC above what's needed for upcoming load until next PV surplus.
// Also: free capacity for upcoming PV by discharging before solar hours.

// Simulate forward again with charge plan applied to find available surplus
let simSoc = currentSoc;
for (let i = 0; i < schedule.length; i++) {
    const s = schedule[i];
    const pvW = s.pvPower;
    const loadW = s.loadEst;

    if (s._plan === 'charge') {
        simSoc += kwhToSoc(maxChargeEnergy);
    } else if (s._plan === 'feedin_preemptive') {
        const drainW = MAX_DISCHARGE_W + loadW - pvW;
        simSoc -= kwhToSoc(Math.max(0, drainW) * INTERVAL_HOURS / 1000);
    } else {
        simSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
    }
    simSoc = Math.max(MIN_SOC_PCT, Math.min(100, simSoc));
    s._plannedSoc = simSoc;
}

// --- 3d. Feed-in planning: budget-based with rolling-horizon ---
// The optimizer re-runs every cycle. By tomorrow afternoon we will have actual
// PV data and re-decide for tomorrow evening. So today's planning horizon ends
// at the *next PV refill point* — the slot where passive (PV-load only) SOC
// climbs back to a high level after dipping. Slots beyond that horizon belong
// to the next planning cycle and must NOT compete with today's slots for SOC.
//
// 1) Find the next PV-refill point (horizon end).
// 2) Compute the total SOC budget available for feed-in within the horizon.
// 3) Greedily pick highest-priced unplanned slots within the horizon until
//    the budget is spent.
// 4) Forward-walk the WHOLE schedule to demote infeasible feed-ins and update
//    _plannedSoc for output.

function feedinDrainSoc(slot) {
    const drainW = Math.max(0, MAX_DISCHARGE_W + slot.loadEst - slot.pvPower);
    return kwhToSoc(drainW * INTERVAL_HOURS / 1000);
}

// Find the rolling horizon by walking passive SOC (PV-load only) and
// looking for a dip-and-recover pattern RELATIVE to the running peak:
// flag `dipped` once SOC falls ≥5 points below the max seen so far,
// then close the horizon at the first slot within 3 points of that peak.
// Absolute thresholds (was: <70 / ≥85) missed cases where starting SOC
// was already high enough that the overnight trough never broke 70 —
// horizon would stay at schedule end, budget would collapse to 0, and
// a legitimate evening peak wouldn't be picked for feed-in. Flat or
// cloudy stretches never satisfy the 5-point dip, so horizon still
// falls through to schedule end in those cases (end-floor path).
let horizonIdx = schedule.length;
{
    let testSoc = currentSoc;
    let peakSoc = currentSoc;
    let dipped = false;
    for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i];
        testSoc += kwhToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000);
        testSoc = Math.max(MIN_SOC_PCT, Math.min(100, testSoc));
        if (testSoc > peakSoc) peakSoc = testSoc;
        if (peakSoc - testSoc >= 5) dipped = true;
        if (dipped && peakSoc - testSoc <= 3) {
            horizonIdx = i + 1; // include the refill slot itself
            break;
        }
    }
}

// Project SOC to the horizon WITHOUT any feed-in plans. Track overflow
// (curtailed PV above 100%) separately so the "battery will actually be
// full" case still contributes a feed-in budget.
{
    let projSoc = currentSoc;
    let overflowSoc = 0;
    for (let i = 0; i < horizonIdx; i++) {
        const s = schedule[i];
        const pvW = s.pvPower;
        const loadW = s.loadEst;
        if (s._plan === 'charge') {
            projSoc += kwhToSoc(maxChargeEnergy);
        } else if (s._plan === 'feedin_preemptive') {
            projSoc -= feedinDrainSoc(s);
        } else {
            projSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
        }
        if (projSoc > 100) {
            overflowSoc += projSoc - 100;
            projSoc = 100;
        }
        if (projSoc < MIN_SOC_PCT) projSoc = MIN_SOC_PCT;
    }

    // Continue projection PAST horizonIdx to capture PV curtailment beyond
    // the refill slot. Without this, an evening with SOC≈100% + strong-PV
    // tomorrow has budget=0: overnight drains SOC below 100, morning PV
    // refills to 85% (horizon end), SOC never exceeds 100 in [0, horizonIdx),
    // so overflowSoc=0 and no evening-peak feed-in is planned — even though
    // tomorrow's PV will actually curtail once the battery hits 100.
    // Walk to the end of the first post-horizon daylight period.
    let postHorizonOverflow = 0;
    if (horizonIdx < schedule.length) {
        let extSoc = projSoc;
        let sawDaylight = false;
        for (let i = horizonIdx; i < schedule.length; i++) {
            const s = schedule[i];
            const pvW = s.pvPower;
            const loadW = s.loadEst;
            if (s._plan === 'charge') {
                extSoc += kwhToSoc(maxChargeEnergy);
            } else if (s._plan === 'feedin_preemptive') {
                extSoc -= feedinDrainSoc(s);
            } else {
                extSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
            }
            if (extSoc > 100) {
                postHorizonOverflow += extSoc - 100;
                extSoc = 100;
            }
            if (extSoc < MIN_SOC_PCT) extSoc = MIN_SOC_PCT;
            if (isDaylight(s.time)) sawDaylight = true;
            else if (sawDaylight) break;
        }
    }

    // Budget calculation depends on whether a PV refill lies within the
    // horizon AND whether that refill is "free" (driven by solar glut).
    //
    // * NO refill (horizon = full schedule, e.g. evening with no PV left):
    //   anything above the overnight reserve is genuinely "unused" SOC and
    //   can be sold at the best prices, plus any projected curtailment.
    //
    // * REFILL ahead, EXPENSIVE (needs grid charging): pre-refill prices
    //   aren't competitive with the post-refill peak the NEXT planning
    //   cycle will see. Budget = overflow only so we don't sell SOC we'd
    //   otherwise carry cheaply into tomorrow's peak.
    //
    // * REFILL ahead, FREE (daylight + low/neg marketPrice + PV surplus):
    //   SOC held past the refill gets replaced by PV for nothing, so pre-
    //   refill peaks at any positive price are pure profit. Expand budget
    //   against end-of-schedule floor.
    const horizonIsRefill = horizonIdx < schedule.length;
    let freeRefillAhead = false;
    if (horizonIsRefill) {
        for (let i = 0; i < horizonIdx; i++) {
            const s = schedule[i];
            if (isDaylight(s.time) && s.marketPrice < 3 && s.pvPower > s.loadEst) {
                freeRefillAhead = true;
                break;
            }
        }
    }
    let feedinBudgetSoc;
    if (horizonIsRefill && !freeRefillAhead) {
        feedinBudgetSoc = overflowSoc + postHorizonOverflow;
    } else {
        const endFloorSoc = kwhToSoc(_postSchedLoadKwh) + MIN_SOC_PCT + 8;
        feedinBudgetSoc = Math.max(0, projSoc + overflowSoc - endFloorSoc);
    }

    // Greedy: pick highest-priced positive-price unplanned slots WITHIN the
    // horizon until budget spent. Slots beyond horizon are not eligible —
    // they belong to the next planning cycle.
    const candidates = schedule
        .slice(0, horizonIdx)
        .map((s, idx) => ({ idx, s }))
        .filter(({ s }) => !s._plan && s.marketPrice > 0)
        .sort((a, b) => b.s.marketPrice - a.s.marketPrice);

    // Round-trip economic check: non-overflow feed-in must beat the
    // cheapest effective price at which we could replace the drained SOC.
    // Otherwise we'd sell at evening price and buy back at morning+gridFee
    // on the next cycle — a net loss. Overflow SOC (curtailment) is
    // exempt: that energy is lost anyway, so any positive revenue wins.
    const minReplacementEffPrice = schedule
        .filter(s => !s._plan)
        .reduce((m, s) => Math.min(m, s.effectivePrice), Infinity);

    let usedBudget = 0;
    for (const { s } of candidates) {
        const drain = feedinDrainSoc(s);
        if (drain <= 0) continue;
        if (usedBudget + drain > feedinBudgetSoc) break; // stop at first overflow
        // Overflow portion is free revenue; beyond that, require economic viability.
        const isOverflowOnly = usedBudget + drain <= overflowSoc;
        if (!isOverflowOnly && s.marketPrice <= minReplacementEffPrice) break;
        s._plan = 'feedin_surplus';
        usedBudget += drain;
    }
    // Rationale for `break` (not `continue`): candidates are sorted by
    // marketPrice DESC. If the current slot doesn't fit, falling through to
    // cheaper-but-smaller slots would replace a potentially big high-priced
    // slot with a small low-priced one — strictly worse revenue. Leave the
    // remaining budget unused; it'll carry over into the next planning cycle
    // or, if curtailment actually happens, Phase 4's runtime "battery full"
    // branch handles it.
}

// Forward-validate: walk schedule in time order, demoting any feed-in that
// would dip SOC below MIN+5 at its slot. Recompute _plannedSoc along the way.
{
    let walkSoc = currentSoc;
    for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i];
        const pvW = s.pvPower;
        const loadW = s.loadEst;
        if (s._plan === 'charge') {
            walkSoc += kwhToSoc(maxChargeEnergy);
        } else if (s._plan === 'feedin_preemptive' || s._plan === 'feedin_surplus') {
            const drain = feedinDrainSoc(s);
            if (walkSoc - drain < MIN_SOC_PCT + 5) {
                // Local infeasibility — demote to compensate
                s._plan = null;
                walkSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
            } else {
                walkSoc -= drain;
            }
        } else {
            walkSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
        }
        walkSoc = Math.max(MIN_SOC_PCT, Math.min(100, walkSoc));
        s._plannedSoc = walkSoc;
    }
}

// (Phase 3e removed: the legacy "free capacity for upcoming PV" loop iterated
// per high-PV slot and greedily marked any unplanned earlier slot as feed-in,
// which would drain SOC at LOW mid-day prices — exactly the wrong choice when
// the evening peak is hours away. The Phase 3d budget already prioritises the
// highest-priced slots within the rolling horizon, and Phase 4's runtime
// "Battery full + PV surplus" branch (mp > 0) handles any actual full-battery
// curtailment situation. Pre-planning capacity feed-in is no longer needed.)

// (Phase 3f removed: the budget-based Phase 3d already guarantees end-of-schedule
// SOC ≥ MIN_SOC + post-schedule overnight load + safety margin, so no further
// revocation pass is needed.)

// ================================================================
// PHASE 4: Execute plan with accurate SOC tracking
// ================================================================
let soc = currentSoc;

for (let i = 0; i < schedule.length; i++) {
    const slot = schedule[i];
    const t = slot.time;
    const mp = slot.marketPrice;
    const ep = slot.effectivePrice;
    const pvW = slot.pvPower;
    const loadW = slot.loadEst;
    const plan = slot._plan;

    let state, reason, setPoint;

    // Hard guard: any feedin_* plan at mp < 0 → compensate instead (never pay grid)
    if (plan && plan.startsWith('feedin') && mp < 0) {
        state = 3; setPoint = -AVG_LOAD_W;
        reason = `Skip feed-in at ${mp.toFixed(1)}ct (neg price), compensate instead`;
    }
    else if (plan === 'feedin_preemptive' && soc > targetSocForSunrise + 3) {
        // Preemptive discharge for tomorrow's solar (only fires when mp >= 0 due to guard above)
        if (soc > targetSocForSunrise + kwhToSoc(maxDischargeEnergy)) {
            state = 4; setPoint = -MAX_DISCHARGE_W;
            reason = `Pre-emptive discharge at ${mp.toFixed(1)}ct, target ${targetSocForSunrise.toFixed(0)}% for solar`;
        } else {
            state = 3; setPoint = -AVG_LOAD_W;
            reason = `Pre-emptive compensate at ${mp.toFixed(1)}ct, near target ${targetSocForSunrise.toFixed(0)}%`;
        }
    }
    else if (plan === 'charge') {
        // Planned cheapest-slot charging
        state = 1; setPoint = MAX_CHARGE_W;
        reason = `Planned charge at ${ep.toFixed(1)}ct (cheapest available)`;
    }
    else if ((plan === 'feedin_surplus' || plan === 'feedin_capacity')
             && soc > MIN_SOC_PCT + kwhToSoc(maxDischargeEnergy) + 5) {
        // Planned feed-in — already validated in Phase 3 with price-aware revocation
        state = 4; setPoint = -MAX_DISCHARGE_W;
        const tag = plan === 'feedin_capacity' ? 'free capacity for PV' : 'surplus energy';
        reason = `Planned feed-in at ${mp.toFixed(1)}ct (${tag})`;
    }
    // Strong PV surplus: let solar charge battery
    else if (pvW - loadW > 1000 && soc < 95) {
        state = 3; setPoint = -AVG_LOAD_W;
        reason = `Strong PV surplus ${(pvW - loadW)}W, solar charges battery`;
    }
    // PV surplus but battery nearly full: feed in only if price > 0
    else if (pvW - loadW > 500 && soc >= 95 && mp > 0) {
        state = 4; setPoint = -MAX_DISCHARGE_W;
        reason = `Battery full ${soc.toFixed(0)}%, PV surplus, feed-in at ${mp.toFixed(1)}ct`;
    }
    // PV surplus, battery full, but price ≤ 0: curtail instead of paying to feed in
    else if (pvW - loadW > 500 && soc >= 95) {
        state = 3; setPoint = -AVG_LOAD_W;
        reason = `Battery full ${soc.toFixed(0)}%, PV surplus but price ${mp.toFixed(1)}ct ≤ 0, curtail`;
    }
    // Default: compensate or charge based on future need
    else {
        // Look ahead: how much SOC do we need from battery for remaining slots + overnight?
        let futureNeedKwh = 0;
        for (let j = i + 1; j < schedule.length; j++) {
            const net = (schedule[j].loadEst - schedule[j].pvPower) * INTERVAL_HOURS / 1000;
            if (net > 0) futureNeedKwh += net;
            if (schedule[j]._plan === 'charge') futureNeedKwh -= maxChargeEnergy;
        }
        futureNeedKwh += _postSchedLoadKwh;
        const socNeeded = kwhToSoc(futureNeedKwh) + MIN_SOC_PCT + 5;

        if (soc > socNeeded) {
            state = 3; setPoint = -AVG_LOAD_W;
            reason = `Compensate load, SOC ${soc.toFixed(0)}% > ${socNeeded.toFixed(0)}% needed`;
        } else if (targetSocForSunrise !== null && !isDaylight(t)) {
            // Preemptive active at night — never charge from grid, just compensate
            state = 3; setPoint = -AVG_LOAD_W;
            reason = `Compensate (no grid charge during preemptive), SOC ${soc.toFixed(0)}%`;
        } else if (ep > 0) {
            // Price is positive — just compensate, don't pay to charge
            state = 3; setPoint = -AVG_LOAD_W;
            reason = `Compensate (price ${ep.toFixed(1)}ct > 0, SOC ${soc.toFixed(0)}%)`;
        } else {
            // Not enough SOC for future load and price <= 0 — charge now
            state = 1; setPoint = MAX_CHARGE_W;
            reason = `Charge at ${ep.toFixed(1)}ct, SOC ${soc.toFixed(0)}% < ${socNeeded.toFixed(0)}% needed`;
        }
    }

    // === Update SOC prediction ===
    let socDelta = 0;

    if (state === 1) {
        // Battery absorbs at most MAX_CHARGE_W total (grid + PV combined).
        socDelta += kwhToSoc(maxChargeEnergy);
    } else if (state === 3) {
        // Compensate: PV covers load first, surplus charges battery, deficit drains battery
        const netPvW = pvW - loadW;
        socDelta += kwhToSoc(netPvW * INTERVAL_HOURS / 1000);
    } else if (state === 4) {
        // Max discharge: battery feeds grid at max rate + covers load, PV offsets some
        const drainW = MAX_DISCHARGE_W + loadW - pvW;
        socDelta -= kwhToSoc(Math.max(0, drainW) * INTERVAL_HOURS / 1000);
    }

    soc = Math.max(MIN_SOC_PCT, Math.min(100, soc + socDelta));

    // Safety: if SOC hits minimum, override to charge
    // But NEVER charge from grid during preemptive discharge (night before solar day)
    if (soc <= MIN_SOC_PCT && state !== 1
        && !(targetSocForSunrise !== null && !isDaylight(t))) {
        state = 1; setPoint = MAX_CHARGE_W;
        reason = `SOC safety override - must charge`;
        soc = MIN_SOC_PCT + kwhToSoc(maxChargeEnergy);
    }

    slot.state = state;
    slot.predictedSoc = Math.round(soc * 10) / 10;
    slot.reason = reason;
    slot.acPowerSetPoint = setPoint;
}

// === Build output ===
const output = schedule.map(s => ({
    time: s.timeStr,
    state: s.state,
    acPowerSetPoint: s.acPowerSetPoint,
    predictedSoc: s.predictedSoc,
    marketPrice: s.marketPrice,
    effectivePrice: Math.round(s.effectivePrice * 100) / 100,
    pvPower: s.pvPower,
    loadEst: s.loadEst,
    reason: s.reason
}));

// Current action (first slot at or after now)
const currentSlot = output.find(s => new Date(s.time).getTime() >= now - 900000) || output[0];

// Prepare messages
// msg1: full schedule for debug
msg.payload = output;
msg.currentAction = currentSlot;
msg.summary = {
    currentSoc: currentSoc,
    currentLoad: currentLoad,
    priceRange: `${minPrice.toFixed(1)} - ${maxPrice.toFixed(1)} ct/kWh`,
    avgPrice: avgPrice.toFixed(1),
    slotsPlanned: output.length,
    currentState: currentSlot ? currentSlot.state : null,
    currentReason: currentSlot ? currentSlot.reason : 'no data',
    preemptiveDischarge: targetSocForSunrise !== null,
    targetSocSunrise: targetSocForSunrise,
    preemptiveSlots: preemptiveDischargeSlots.size
};

// msg2: write to batterycontrol.plan via influxdb batch node
// Array of {measurement, fields, timestamp}
const msg2 = {
    payload: schedule.map(s => ({
        measurement: 'plan',
        fields: {
            AcPowerSetPoint: s.acPowerSetPoint,
            Soc: s.predictedSoc,
            reason: s.state,
            engdem: parseFloat(socToKwh(s.predictedSoc).toFixed(2)),
            nxd: 0
        },
        timestamp: new Date(s.time)
    }))
};

// msg3: current setpoint for ESS control
var weather7 = global.get("weather7days", "file")
const msg3 = {
    topic: 'mac/ess/cmd',
    payload: {
        state: currentSlot ? currentSlot.state : 3,
        reason: currentSlot ? currentSlot.reason : 'no data',
        val: currentSlot.marketPrice,
        sun: weather7.sun7[0].value,
        slots: output
    }
};

// Persist current schedule into global.pp.prediction (file store) so other
// flows/nodes can read the optimizer's output without subscribing to msgs.
const pp = global.get('pp', 'file') || {};
pp.prediction = output;
global.set('pp', pp, 'file');

return [msg, msg2, msg3];