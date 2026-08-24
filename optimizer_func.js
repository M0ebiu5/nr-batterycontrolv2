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
const MIN_SOC_PCT = 5;
const CHARGE_EFFICIENCY = 0.94; // one-way charge efficiency for the predictedSoc projection only. Energy sent to the pack (grid charge or PV surplus) lands as SOC at ~94% (inverter AC→DC conversion + minor coulombic loss). Empirically calibrated 2026-07-04: predicted SOC ran ~+3–4% above true capacity-weighted BMS SOC during steep daytime charging (morning gain +45.4 predicted vs +42.5 true BMS → 0.936 ratio); overnight discharge already matched within 0.1%, so the factor is applied to charging deltas only. Planning sims are left at 100% (unchanged) — this only tightens the reported projection.
const INTERVAL_HOURS = 0.25; // 15 minutes
const PV_PEAK_W = 5000;
const BASE_GRID_FEE = 13; // ct/kWh
const FEEDIN_MIN_MP_CT = 5; // never feed in below this market price (cycle wear + inverter losses exceed sub-ct revenue)
const MAX_GRID_CHARGE_SOC_PCT = 90; // Phase 3c projection cap: planner refuses to schedule grid-charge slots past 90% SOC. PV-driven fill above this is still allowed at runtime (no curtailment). Drops the most-expensive ~3 picks (typically pre-13:00 morning slots before next-day prices publish), reduces battery wear, preserves headroom for unforecast PV.
const PRESAT_MIN_GAIN_CT = 3; // Phase 3d pass 1: a pre-saturation drain must beat the price the same energy would fetch when Phase 4's runtime branch dumps it during saturation. Guards the pre-drain against becoming a low-price midday sale (see the "never pre-drain at low midday prices to make room for PV" rule): the hurdle is the realistic alternative price, not zero. 3 ct ≈ the observed 10–15 ct dump band vs 17–20 ct pre-saturation prices, so it fires on genuine spreads and stays quiet on near-ties.
const PV_CURTAIL_MIN_SOC = 5;   // a PV-ONLY projection must overflow by at least this much SOC (~1.5 kWh) before the planner accepts "PV will saturate the pack" as real. 0.6% of phantom overflow on a bad-PV day (74 sun-min) once unlocked PV-opportunity pricing and let a 22.39ct evening feed-in pass against a 14ct real grid refill. The same floor now also gates the Phase 3c saturation wall and the Phase 3d free-refill test, so a single forecast wobble cannot rewrite the plan.
const FEEDIN_ROUNDTRIP_MARGIN_CT = 5; // Phase 3d round-trip margin: non-overflow feed-in mp must beat replacementPrice by this much. Raw mp-vs-effective comparison alone ignores inverter round-trip losses (~10%) and battery cycle wear — the 5 ct margin covers ~10% inverter losses + ~1.5 ct cycle wear at the typical 20 ct sell price (net ~1.5 ct/kWh remaining profit). Raised to 10 on 2026-05-19 when the false pvOpportunityPrice ~11ct was being applied across the board — dropping to 5 against pvOpp made thin spreads net losers. After the early pass was fixed to use strict minReplaceEff (no pvOpp bypass for pre-grid-charge slots), the margin/replacement combination became too strict and missed the legitimate 22.39 ct peak (real spread 5.49 ct vs minReplaceEff 16.90). Returned to 5 on 2026-05-19 (later 5).
const CROSSDAY_HOLD_SLACK_CT = 3; // Phase 3d cross-day hold: don't sell tonight's STORED energy when a materially higher stored-energy feed-in peak lies BEYOND the horizon (e.g. tomorrow evening). Tonight's mp must clear (futurePeak − this slack) to sell; otherwise hold the SOC for the better peak (captured next cycle once the horizon advances). The genuinely curtailment-bound portion (pvOnlyOverflow) is still sold tonight — it would be lost to PV curtailment if held. Slack avoids churn on near-ties and covers PV-forecast uncertainty (re-evaluated every 15 min).
const CROSSDAY_HOLD_MAX_AGE_MS = 12 * 3600 * 1000; // how long a cross-day hold floor may be carried once horizonIsRefill flips false (see the carry branch in Phase 3d). Bounded so a floor computed from a stale horizon can't suppress feed-in indefinitely; the peak it was derived from must also still lie in the future.
// Phase 3b-arb (arbitrage grid-charge): on exceptional-delta days, grid-charge cheap slots SPECIFICALLY to resell at a high feed-in peak before the next free PV refill. This deliberately opens the grid→feed-in path that the other phases block — guarded by a high NET hurdle so it only fires when the round-trip is genuinely profitable. Charged slots are tagged _plan='charge', so all existing charge handling (SOC sims, state=1 emit, Phase 3d feed-in budget + round-trip checks) sells the resulting surplus at the peak automatically.
const ARB_MIN_NET_CT = 16;      // required NET profit per kWh after round-trip loss + cycle wear: peakMp*ARB_RT_EFF − chargeEff − ARB_CYCLE_WEAR_CT ≥ this
const ARB_RT_EFF = 0.9;         // inverter+round-trip efficiency applied to sell revenue (~10% loss)
const ARB_CYCLE_WEAR_CT = 1.5;  // battery cycle-wear cost per kWh cycled
const ARB_CHARGE_SOC_PCT = 100; // arbitrage may fill to 100% (energy is dumped within hours; relaxes the normal 90% Phase 3c headroom cap)
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

// Timestamp (ms) of the row lastVal() would return for `field`, or null.
// Needed wherever a reading is only meaningful relative to when it was taken —
// see the feed-in delivery guard, which must not judge a command by a sample
// recorded before that command was issued.
function lastTime(arr, field) {
    if (!arr || !arr.length) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i][field] !== null && arr[i][field] !== undefined) {
            const t = arr[i].time;
            if (t === null || t === undefined) return null;
            const ms = typeof t === 'number' ? t : new Date(t).getTime();
            return isFinite(ms) ? ms : null;
        }
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

// --- BMS-aware SOC/charge guard --------------------------------------------
// currentSoc now comes from the capacity-weighted BMS feed (global.bms, surfaced
// by the "SOC from global" node) rather than the Victron aggregate, which has read
// implausibly (e.g. 71.5% while the packs were really ~84%, then jumping +24% in
// 12 min and grid-charging an almost-full pack). Two safety nets:
//   1. range + physically-impossible-jump rejection      -> socTrust
//   2. per-pack full-stop on CELL VOLTAGE: never grid-charge if ANY pack's max
//      cell ≥ CELL_FULL_V. The packs' reported SOC% is miscalibrated (the small
//      135Ah packs read ~99.8% at only ~3.40 V/cell — mid-plateau — while the
//      310Ah bat_big still has real room), so cell voltage, not SOC%, is the true
//      fullness signal for these LFP packs. Each pack's BMS keeps its own hardware
//      overvoltage cutoff as the hard backstop.
const CELL_FULL_V = 3.50;       // V/cell ceiling that blocks grid-charge
const _nowMs = Date.now();
let maxCellV = lastVal(raw.soc, 'maxCellV');
if (typeof maxCellV !== 'number' || !isFinite(maxCellV)) maxCellV = null;

let socTrust = true;
if (!(typeof currentSoc === 'number' && isFinite(currentSoc) && currentSoc >= 0 && currentSoc <= 100)) {
    socTrust = false;
    const _prev = (global.get('socGuard') || {}).soc;
    currentSoc = (typeof _prev === 'number') ? _prev : 50;
}
const _sg = global.get('socGuard') || {};
if (socTrust && typeof _sg.soc === 'number' && typeof _sg.time === 'number') {
    const _dtH = Math.max(0.001, (_nowMs - _sg.time) / 3600000);
    const _maxJump = (MAX_CHARGE_W / (BATTERY_CAPACITY_KWH * 1000)) * 100 * _dtH * 1.3 + 2;
    if (Math.abs(currentSoc - _sg.soc) > _maxJump) socTrust = false; // implausible jump → distrust
}
global.set('socGuard', { soc: currentSoc, time: _nowMs });

// --- SOC staleness guard ----------------------------------------------------
// A stale SOC never looks absent. `query_soc` already falls back from global.bms
// to global.ess once the BMS feed is more than 30 min old, but global.ess carries
// no timestamp of its own and the collector behind it keeps re-writing its last
// known value, so the reading stays present, in range, and wrong. On 2026-08-16
// the Cerbo dropped off the LAN at 22:57 and global.ess.Soc sat pinned at 90.5%
// for the rest of the night while the packs were really near 53% - every plan
// that night was fiction.
//
// All we have to go on is that the number stops moving. Away from the rails the
// pack is always either covering load or taking charge, so a completely flat SOC
// for two hours is not a real operating point; at ~100% or down on the floor it
// is, and those are exempt.
const SOC_STALE_MIN = 120;
const _bmsCtx = global.get('bms') || {};
const _socSource = (typeof _bmsCtx.weightedSoc === 'number'
    && typeof _bmsCtx.ts === 'number' && _bmsCtx.ts > _nowMs - 1800000) ? 'bms' : 'ess';
// Kept in the file store: a Node-RED restart is exactly what someone does while
// troubleshooting an outage, and losing changedAt there would re-arm the whole
// window and buy the fault another two hours of blind operation.
const _socFresh = global.get('socFresh', 'file') || {};
const _socChangedAt = (_socFresh.soc === currentSoc && typeof _socFresh.changedAt === 'number')
    ? _socFresh.changedAt : _nowMs;
const _socFlatMin = (_nowMs - _socChangedAt) / 60000;
const _atSocRail = currentSoc >= 99 || currentSoc <= MIN_SOC_PCT + 1;
const socStale = _socFlatMin >= SOC_STALE_MIN && !_atSocRail;
let _socWarnedAt = _socFresh.warnedAt || 0;
if (socStale) {
    socTrust = false;   // never grid-charge on a reading we do not believe
    if (_nowMs - _socWarnedAt > 3600000) {
        _socWarnedAt = _nowMs;
        node.warn(`SOC stale: ${currentSoc.toFixed(1)}% (source ${_socSource}) unchanged for `
            + `${Math.round(_socFlatMin)}min - holding state 3, grid-charge and feed-in blocked`);
    }
}
global.set('socFresh', { soc: currentSoc, changedAt: _socChangedAt, warnedAt: _socWarnedAt }, 'file');
// Suppress grid-charge of the LIVE slot when the reading can't be trusted or a pack
// is at the cell-voltage ceiling. (Applied at i===0 only; future slots re-evaluate.)
const gridChargeBlocked = !socTrust || (maxCellV !== null && maxCellV >= CELL_FULL_V);

// Current AC load
let currentLoad = lastVal(raw.acload, 'acload');
if (currentLoad === null) currentLoad = AVG_LOAD_W;

// Current battery power
let currentPower = lastVal(raw.power, 'power');

// Current actual PV power from inverter
let currentPvPower = lastVal(raw.pv_now, 'pv_now');
if (currentPvPower === null) currentPvPower = 0;

// --- Feed-in delivery guard -------------------------------------------------
// The BMS SOC the optimizer trusts can read well above what the packs will
// actually deliver (2026-07-28: BMS 21.1% vs Victron 6.5%, and a -5000 W feed-in
// command produced -526 W of battery power). A commanded feed-in that
// under-delivers is the only reliable signal that the stated SOC isn't real, so
// treat it the way socTrust already gates grid-charge: block feed-in on the LIVE
// slot until the block ages out or SOC recovers materially.
const FEEDIN_DELIVER_MIN_FRAC = 0.4;      // delivered/commanded below this = under-delivery
const FEEDIN_BLOCK_MS = 60 * 60 * 1000;   // hold the block this long...
const FEEDIN_BLOCK_SOC_RECOVER = 5;       // ...or until SOC climbs this many points
const FEEDIN_SAMPLE_MIN_AGE_MS = 60 * 1000; // sample must be this far past the command (inverter ramp)
let feedinGuard = global.get('feedinGuard') || {};
const _prevExpectW = (typeof feedinGuard.expectW === 'number') ? feedinGuard.expectW : 0;
// Only a battery-power sample taken AFTER the command (plus ramp time) says
// anything about whether that command was followed. `ess.Power` is logged
// irregularly — gaps of 18–30 min are normal and no sample landed inside any
// feed-in slot on 2026-08-11 — so LAST(Power) is routinely a pre-command idle
// reading (~300–900 W of plain load compensation). Judged against a ~4 kW
// feed-in command that always looks like under-delivery: five false blocks that
// evening, each suppressing feed-in for the following hour and so skipping the
// best-priced slot in it (19:45 @ 25.42 ct, the day's peak, among them). With no
// fresh sample the guard now abstains — it neither blocks nor clears, and a
// later run inside the 20-min window can still judge the same command.
const _powerSampleMs = lastTime(raw.power, 'power');
const _powerSampleFresh = typeof feedinGuard.commandedAt === 'number'
    && _powerSampleMs !== null
    && _powerSampleMs >= feedinGuard.commandedAt + FEEDIN_SAMPLE_MIN_AGE_MS;
if (_prevExpectW > 0 && typeof feedinGuard.commandedAt === 'number'
    && (_nowMs - feedinGuard.commandedAt) < 20 * 60 * 1000
    && _powerSampleFresh
    && typeof currentPower === 'number' && isFinite(currentPower)) {
    // ess `power` is battery power: positive = charging, negative = discharging.
    const deliveredW = Math.max(0, -currentPower);
    const _sampleAgeMin = (_powerSampleMs - feedinGuard.commandedAt) / 60000;
    if (deliveredW < _prevExpectW * FEEDIN_DELIVER_MIN_FRAC) {
        feedinGuard = { blockedAt: _nowMs, blockedSoc: currentSoc };
        node.warn(`Feed-in under-delivery: ${Math.round(deliveredW)}W of ${Math.round(_prevExpectW)}W commanded (sample +${_sampleAgeMin.toFixed(1)}min) → blocking feed-in (SOC ${currentSoc.toFixed(0)}%)`);
    } else {
        feedinGuard = {}; // delivered as commanded → clear any stale block
    }
    global.set('feedinGuard', feedinGuard);
}
const feedinDeliveryBlocked = typeof feedinGuard.blockedAt === 'number'
    && (_nowMs - feedinGuard.blockedAt) < FEEDIN_BLOCK_MS
    && currentSoc < (feedinGuard.blockedSoc || 0) + FEEDIN_BLOCK_SOC_RECOVER;

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


// Per-day max sunshine ratio from forecast, keyed by Berlin local date.
// Previously this was a single 7-day MAX across all forecast rows, which made
// every day in the horizon share one baseline calibrated to the brightest hour
// anywhere in the window. That caused sunny days to be matched against
// medium-cloud historical days (underestimate) and cloudy days to be matched
// against medium-cloud days too — the brightness signal was lost per-day.
const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });
function berlinDateKey(timeMs) { return _dateFmt.format(new Date(timeMs)); }

const dailySunRatio = {};
for (const sm of solarMinutes) {
    const key = berlinDateKey(sm.time);
    const r = Math.min(Math.max(sm.value / 60, 0), 1);
    if (r > (dailySunRatio[key] || 0)) dailySunRatio[key] = r;
}

// sunRatio ~1 = full sun → peak ~PV_PEAK_W, sunRatio ~0.3 = cloudy → peak ~1500W
// Fallback ratio used when a slot's date has no forecast row (rare: past horizon).
const fallbackSunRatio = weather.solarradiation > 0
    ? Math.min(weather.solarradiation / 1000, 1)
    : 0.5;

// Build a baseline (24h profile + reference ratio) for a given target sun ratio.
// Strategy: take the K historical days whose peak is CLOSEST to the implied
// target peak. Previous strict ±30% window plus 3-match minimum caused every
// medium-cloud ratio to fall back to "all days" (sunny+cloudy mix), so a sunny
// day's forecast couldn't exceed ~67% of all-days avg even with high sunshine.
// Closest-K never falls back: a 0.27 ratio matches the cloudiest K days, a 0.9
// ratio matches the sunniest K days. refRatio reflects the matched set's
// actual peak, anchoring per-slot scaling correctly.
const _PV_BASELINE_K = 5;
function buildPvBaseline(targetSunRatio) {
    const targetPeak = targetSunRatio * PV_PEAK_W;
    const dates = Object.keys(pvDays).filter(d => pvDays[d].peak > 200);
    dates.sort((a, b) => Math.abs(pvDays[a].peak - targetPeak) - Math.abs(pvDays[b].peak - targetPeak));
    const sourceDates = dates.slice(0, _PV_BASELINE_K);
    let refRatio = targetSunRatio;
    if (sourceDates.length > 0) {
        const avgMatchedPeak = sourceDates.reduce((a, d) => a + pvDays[d].peak, 0) / sourceDates.length;
        refRatio = Math.max(avgMatchedPeak / PV_PEAK_W, 0.1);
    }
    const profile = new Array(24).fill(0);
    const byHour = new Array(24).fill(null).map(() => []);
    for (const d of sourceDates) {
        for (const [h, val] of Object.entries(pvDays[d].hours)) {
            byHour[parseInt(h)].push(val);
        }
    }
    for (let h = 0; h < 24; h++) {
        if (byHour[h].length > 0) {
            profile[h] = byHour[h].reduce((a, b) => a + b, 0) / byHour[h].length;
        }
    }
    return { profile, refRatio };
}

// Cache baselines per unique daily ratio (≤7 horizon days, so tiny cache).
const _baselineCache = new Map();
function baselineForRatio(r) {
    const key = r.toFixed(3);
    if (!_baselineCache.has(key)) _baselineCache.set(key, buildPvBaseline(r));
    return _baselineCache.get(key);
}
const fallbackBaseline = baselineForRatio(fallbackSunRatio);

function getDayBaseline(timeMs) {
    const r = dailySunRatio[berlinDateKey(timeMs)];
    return r === undefined ? fallbackBaseline : baselineForRatio(r);
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
    const { profile: hourlyPv, refRatio: baselineRefRatio } = getDayBaseline(timeMs);
    const basePvRaw = hourlyPv[h] || 0;

    // Scale the per-day baseline by the per-slot sunshine forecast. baseline
    // is calibrated to that day's peak sun ratio, but the morning/afternoon
    // forecast can still differ from the peak hour within the same day.
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
        const todayBaseline = getDayBaseline(now).profile;
        const currentH = berlinTime(now).hour;
        const basePvNow = todayBaseline[currentH] || 1;
        let scaleFactor = null;

        // Prefer actual PV power from inverter. Clamped the same way the
        // radiation fallback below is: an unbounded ratio let one sample
        // rescale the WHOLE remaining day. 2026-08-20 under broken cloud the
        // 07:45 run projected 5000W midday and 11 curtailment feed-ins, the
        // 08:00 run projected ~1000W and none (actual PAC 1946W -> 722W in
        // 15 min). pv_now is a 30-min MEDIAN (see the "PV Now" query node), so
        // brief gaps and spikes no longer move it; the clamp bounds the rest.
        if (currentPvPower > 0 && basePvNow > 0) {
            scaleFactor = Math.max(0.1, Math.min(currentPvPower / basePvNow, 2.5));
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
let _reserveDeferred = false;
if (schedule.length > 0) {
    const lastSlotEnd = schedule[schedule.length - 1].time + INTERVAL_HOURS * 3600 * 1000;
    // Defer the multi-day reserve until tomorrow's prices publish (~13:00
    // Berlin EPEX). Before publish, lastSchedTime is only ~24h out; we
    // can't compare today's mid-day grid-charge cost against tomorrow's
    // actual cheapest slots, so reserve picks become a blind bet that the
    // forecast-driven walk overweights vs. real price data. User report
    // 2026-05-19: 25 mid-day grid picks at ~18ct effective fired overnight
    // (run at 01:00 Berlin) against a 48h walk forecasting bad PV — but
    // tomorrow's prices weren't yet visible to confirm the bet. With
    // pricesCoverTomorrow=true the 36h horizon already includes tomorrow's
    // own slots, so the planner naturally picks the cheaper of {today,
    // tomorrow} — no separate post-horizon reserve needed.
    // 2026-05-20: bumped 25h->30h. At 25h an evening run (~20:45 Berlin) saw
    // prices ~27h out — past 25h, so the reserve fired — yet those prices
    // only cover *tomorrow*, not the day-after the reserve actually bets on.
    // Result: ~8 kWh of ~11ct grid-charge committed in tomorrow-morning slots
    // (e.g. 10:30) before the day-after prices publish. 30h defers the reserve
    // until prices extend into the day-after (only true after the next ~13:00
    // publish), while still deferring the overnight/early-morning blind case.
    const pricesCoverTomorrow = (schedule[schedule.length - 1].time - now) > 30 * 3600 * 1000;
    if (!pricesCoverTomorrow) {
        _reserveDeferred = true;
        // Overnight-bridge reserve: the multi-day (day-after) reserve is a blind
        // bet before tomorrow's prices publish, so it's deferred. But the load
        // from schedule-end until the NEXT sunrise is a KNOWN quantity, not a
        // bet. Without it, evening feed-in drains SOC to the bare MIN+8 floor
        // right as the horizon closes mid-night (schedule ends ~23:45 local
        // pre-publish), emptying the battery into the small hours and forcing a
        // morning grid rebuy / selling the marginal ~14ct late-evening tail
        // (user report 2026-05-22: plan ended 23:45 local at ~11% with 5.5h of
        // darkness left). Walk hour-by-hour from schedule-end to the first
        // daylight hour, summing load (PV~=0 overnight), and hold that as the
        // end-of-schedule floor so feed-in stops at the high-value peaks.
        let _bridgeKwh = 0;
        for (let h = 0; h < 18; h++) {
            const t = lastSlotEnd + h * 3600000;
            if (h > 0 && isDaylight(t)) break; // reached next sunrise
            const loadW = getLoadEstimate(t);
            let pvW = 0;
            if (isDaylight(t)) {
                const { profile: hourlyPv, refRatio: baselineRefRatio } = getDayBaseline(t);
                const basePvRaw = hourlyPv[berlinTime(t).hour] || 0;
                const slotForecast = getSunshineForecast(t);
                const ratio = slotForecast !== null ? slotForecast : 0.5;
                pvW = basePvRaw * Math.min(ratio / Math.max(baselineRefRatio, 0.1), 1.2);
            }
            _bridgeKwh += Math.max(0, loadW - pvW) / 1000;
        }
        _postSchedLoadKwh = _bridgeKwh;
    } else {
        // Multi-day post-horizon reserve. The walk weighs PV via
        // getSunshineForecast (7d horizon), so good-weather days don't pad
        // the reserve — only sustained PV deficits do. Needs both a long
        // enough walk (48h) and a high enough cap (21 kWh ≈ 70% SOC) to
        // surface a dead-PV streak; otherwise tonight's feed-in silently
        // drains into a PV desert and forces peak-price grid recharge.
        const RESERVE_HOURS = 48;
        const MAX_RESERVE_KWH = 21; // ~70% SOC cap on a 30 kWh battery; survives multi-day PV deficits

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

        // Net cumulative walk (allows PV surplus to offset prior deficit). The
        // earlier Math.max(0, load-pv) form accumulated deficit-only and never
        // discounted post-schedule sunny days — a 22nd at 694 sun-min would not
        // offset a 21st deficit, so the cap pinned _postSchedLoadKwh near 21 kWh
        // and endFloorSoc forced Phase 3c into ~18 noon grid charges on a bad-PV
        // tomorrow. Track the running running cumulative net and floor at 0 (we
        // can't pre-charge from future PV; max needed reserve is the deepest
        // dip below end-of-schedule SOC across the walk).
        let walkDef = 0;
        let peakWalkDef = 0;
        for (let h = 0; h < RESERVE_HOURS; h++) {
            const t = lastSlotEnd + h * 3600000;
            const loadW = getLoadEstimate(t);
            let pvW = 0;
            if (isDaylight(t)) {
                const { profile: hourlyPv, refRatio: baselineRefRatio } = getDayBaseline(t);
                const basePvRaw = hourlyPv[berlinTime(t).hour] || 0;
                const slotForecast = getSunshineForecast(t);
                const ratio = slotForecast !== null ? slotForecast : tomorrowPvRatio;
                pvW = basePvRaw * Math.min(ratio / Math.max(baselineRefRatio, 0.1), 1.2);
            }
            walkDef += (loadW - pvW) / 1000; // can subtract on surplus hours
            if (walkDef < 0) walkDef = 0; // can't pre-charge from future PV
            if (walkDef > peakWalkDef) peakWalkDef = walkDef;
        }
        _postSchedLoadKwh = peakWalkDef;

        if (_postSchedLoadKwh > MAX_RESERVE_KWH) _postSchedLoadKwh = MAX_RESERVE_KWH;
    }
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
    // Floor is conditional: 30% when neg-prices confirm the glut (external
    // signal, not just forecast), else 40% — forecast alone isn't trusted
    // enough to drain deeper, and a higher floor protects the morning peak
    // if PV underperforms.
    const capacityNeededPct = kwhToSoc(totalSurplusKwh);
    const socFloor = negPriceSlots >= 4 ? 30 : 40;
    targetSocForSunrise = Math.max(socFloor, 100 - capacityNeededPct);
    // Negative daylight prices = solar glut ahead. PV-surplus estimate can
    // underestimate (forecast noise, fallback paths); the neg-price signal
    // is the authoritative cue that capacity will be needed. Force ≤30%.
    if (negPriceSlots >= 4) {
        targetSocForSunrise = Math.min(targetSocForSunrise, 30);
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

    // Round-trip guard: feed-in revenue must beat replacement cost.
    // Replacement = grid charging in the pre-sunrise "dead zone" where
    // PV doesn't cover load — Phase 4 would plan state=1 there.
    // Post-sunrise slots and PV-surplus slots are excluded: PV refills
    // for free; we can't grid-charge during PV glut.
    const replacementSlots = schedule.filter(s =>
        s.time > now && s.time < sunriseTime && s.pvPower < s.loadEst);
    const minReplacementEffPrice = replacementSlots.length
        ? Math.min(...replacementSlots.map(s => s.effectivePrice))
        : Infinity;

    // DP-based pick: maximize Σ(mp × reliefSoc) over slots passing the
    // chronological gate (pre-soc > target+3, matching Phase 4 line 1233)
    // and the round-trip filter (mp > minReplacementEffPrice).
    //
    // Replaces the prior sort-by-mp DESC loop that ignored chronological
    // SOC depletion: the highest-mp slots later in the day were starved
    // by lower-mp earlier picks consuming the SOC budget, so Phase 4's
    // gate demoted them to state=3 — losing the best feed-in revenue.
    //
    // State (slot_idx, soc_bucket); transitions skip vs pick. Reward is
    // mp × (skip_delta - pick_delta) ≈ mp × MAX_DISCHARGE per slot — the
    // physical SOC freed by feeding in vs. holding.
    {
        const sortedChrono = [...eveningSlots].sort((a, b) => a.time - b.time);
        const N = sortedChrono.length;
        if (N > 0) {
            const SOC_QUANT = 0.5;
            const NUM_B = Math.floor(100 / SOC_QUANT) + 1;
            const gate = targetSocForSunrise + 3;

            const skipDelta = sortedChrono.map(s =>
                kwhToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000));
            const pickDelta = sortedChrono.map(s =>
                -kwhToSoc(Math.max(0, MAX_DISCHARGE_W + s.loadEst - s.pvPower) * INTERVAL_HOURS / 1000));
            const reward = sortedChrono.map((s, i) =>
                s.marketPrice > 0 && s.marketPrice > minReplacementEffPrice
                    ? s.marketPrice * (skipDelta[i] - pickDelta[i])
                    : -Infinity);

            const clipSoc = (soc) => Math.max(MIN_SOC_PCT, Math.min(100, soc));
            const bucket = (soc) => Math.round(clipSoc(soc) / SOC_QUANT);

            const V = Array.from({ length: N + 1 }, () => new Float32Array(NUM_B));
            const C = Array.from({ length: N }, () => new Uint8Array(NUM_B));

            for (let i = N - 1; i >= 0; i--) {
                for (let b = 0; b < NUM_B; b++) {
                    const soc = b * SOC_QUANT;
                    const vSkip = V[i+1][bucket(soc + skipDelta[i])];
                    let vPick = -Infinity;
                    if (reward[i] !== -Infinity && soc > gate) {
                        vPick = reward[i] + V[i+1][bucket(soc + pickDelta[i])];
                    }
                    if (vPick > vSkip) { V[i][b] = vPick; C[i][b] = 1; }
                    else { V[i][b] = vSkip; C[i][b] = 0; }
                }
            }

            let walkSoc = currentSoc;
            for (let i = 0; i < N; i++) {
                if (C[i][bucket(walkSoc)] === 1) {
                    preemptiveDischargeSlots.add(sortedChrono[i].time);
                    walkSoc = clipSoc(walkSoc + pickDelta[i]);
                } else {
                    walkSoc = clipSoc(walkSoc + skipDelta[i]);
                }
            }
        }
    }

    node.warn(`Preemptive ACTIVE: target=${targetSocForSunrise.toFixed(1)}%, sunrise=${new Date(sunriseTime).toISOString()}, extraDrain=${extraDrainNeeded.toFixed(1)}%, slots=${preemptiveDischargeSlots.size}, surplus=${totalSurplusKwh.toFixed(1)}kWh, negSlots=${negPriceSlots}, minReplaceEff=${isFinite(minReplacementEffPrice) ? minReplacementEffPrice.toFixed(1) : '∞'}ct`);
})();

// Remove past slots, only keep current and future
schedule = schedule.filter(s => s.time >= now - 900000);

if (schedule.length === 0) {
    node.warn('No current/future price slots (price data is stale — all slots in the past)');
    msg.payload = { error: 'No current/future price data available' };
    return msg;
}

const maxChargeEnergy = MAX_CHARGE_W * INTERVAL_HOURS / 1000; // 0.875 kWh per slot
const maxDischargeEnergy = MAX_DISCHARGE_W * INTERVAL_HOURS / 1000;

// --- Detect a sun-poor next day (user rule: hold stored energy, don't feed in) ---
// On a day whose NEXT daylight period brings little/no usable solar, the battery
// can't refill from PV — so selling stored energy today only to grid-charge it back
// tomorrow is a loss. Rule: when tomorrow is sun-poor, do NOT feed in unless the
// battery is already full; sell only PV overflow that physically can't be stored.
const DARK_DAY_SURPLUS_KWH = 5;   // tomorrow PV-minus-load below this ⇒ "no sun tomorrow"
let tomorrowSunPoor = false;
(function computeTomorrowSunPoor() {
    if (schedule.length < 8) return;
    let i = 0;
    while (i < schedule.length && isDaylight(schedule[i].time)) i++;   // skip today's remaining daylight
    while (i < schedule.length && !isDaylight(schedule[i].time)) i++;  // skip the coming night
    let surplusKwh = 0, count = 0;
    for (; i < schedule.length && isDaylight(schedule[i].time); i++) {
        surplusKwh += Math.max(0, (schedule[i].pvPower || 0) - schedule[i].loadEst) * INTERVAL_HOURS / 1000;
        count++;
    }
    if (count < 8) return;   // not enough of tomorrow's daylight in the horizon to judge
    tomorrowSunPoor = surplusKwh < DARK_DAY_SURPLUS_KWH;
})();

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

// Helper: a slot Phase 4 will runtime profit-charge (state=1, MAX_CHARGE_W)
// because effectivePrice < 0 (paid to import). Skip during preemptive night.
function isProfitChargeSlot(s) {
    return s.effectivePrice < 0
           && !(targetSocForSunrise !== null && !isDaylight(s.time));
}

// --- 3a. (removed) Never feed in at negative prices, regardless of magnitude ---

// --- 3b. Force-assign preemptive discharge slots ---
for (const s of schedule) {
    if (preemptiveDischargeSlots.has(s.time)) {
        s._plan = 'feedin_preemptive';
    }
}

// --- 3b-arb. Arbitrage grid-charge: charge cheap, resell at a high-delta peak ---
// On exceptional-delta days, proactively grid-charge cheap slots to feed in
// MORE energy at a high feed-in peak that lies BEFORE the next free PV refill.
// The energy drained at the peak is replaced by tomorrow's free PV (the refill),
// so the only real cost is the cheap grid charge + round-trip loss + cycle wear.
// Gated by a high NET hurdle (ARB_MIN_NET_CT) so it stays dormant on normal days.
// Pre-marking these as _plan='charge' (before Phase 3c) means: (a) the 3c
// preemptive no-charge gate can't strip them (it only blocks 3c's OWN new picks),
// and (b) Phase 3d sells the resulting surplus at the peak via its existing budget
// + round-trip machinery (the peak mp ≫ the marginal charge cost).
(function arbitrageGridCharge() {
    if (schedule.length < 4) return;

    // Forward bound: the next FREE PV refill (daylight slot where PV > load).
    // Charging before it to sell before it is a clean intraday round-trip —
    // the drained SOC is refilled by free PV, not a future grid recharge.
    // Charging to sell PAST the refill would be a cross-day bet (left to the
    // next cycle once that day's prices/PV firm up).
    let arbHorizonIdx = schedule.length;
    for (let i = 0; i < schedule.length; i++) {
        if (isDaylight(schedule[i].time) && schedule[i].pvPower > schedule[i].loadEst) {
            arbHorizonIdx = i;
            break;
        }
    }
    if (arbHorizonIdx < 2) return; // refill is already upon us; nothing to charge for

    // Best feed-in peak within the bound (positive, above the feed-in floor).
    // Include slots already tagged for feed-in (e.g. preemptive discharge) —
    // those ARE where we resell; only 'charge' slots can't be the sell peak.
    let peakIdx = -1, peakMp = -Infinity;
    for (let i = 0; i < arbHorizonIdx; i++) {
        const s = schedule[i];
        if (s._plan === 'charge') continue;
        if (s.marketPrice > FEEDIN_MIN_MP_CT && s.marketPrice > peakMp) {
            peakMp = s.marketPrice;
            peakIdx = i;
        }
    }
    if (peakIdx < 1) return;

    // Candidate charge slots: unplanned, before the peak, where grid is the real
    // source (pv < load) and importing isn't already free/paid (eff ≥ 0; eff < 0
    // is Phase 4 profit-charge territory). Must clear the NET round-trip hurdle
    // against the peak: peakMp*ARB_RT_EFF − eff − wear ≥ ARB_MIN_NET_CT.
    const cands = [];
    for (let i = 0; i < peakIdx; i++) {
        const s = schedule[i];
        if (s._plan) continue;
        if (s.pvPower >= s.loadEst) continue;
        if (s.effectivePrice < 0) continue;
        const net = peakMp * ARB_RT_EFF - s.effectivePrice - ARB_CYCLE_WEAR_CT;
        if (net < ARB_MIN_NET_CT) continue;
        cands.push({ idx: i, eff: s.effectivePrice, net, prePublish: berlinTime(s.time).hour < 13 });
    }
    if (cands.length === 0) return;
    // Cheapest charge first; prefer post-13:00 (prices published) on ties.
    cands.sort((a, b) => (a.prePublish - b.prePublish) || (a.eff - b.eff));

    // Project SOC at the peak slot, capped at the arbitrage ceiling. Each kept
    // pick must actually raise it (i.e. not be clamped away by a full battery
    // in between) — this bounds total arbitrage charge to real battery room.
    function projPeakSoc() {
        let s0 = currentSoc;
        for (let i = 0; i < peakIdx; i++) { // SOC entering the peak = deliverable energy
            const s = schedule[i];
            if (s._plan === 'charge') {
                s0 += kwhToSoc(maxChargeEnergy);
            } else if (s._plan === 'feedin_preemptive') {
                const drainW = Math.max(0, MAX_DISCHARGE_W + s.loadEst - s.pvPower);
                s0 -= kwhToSoc(drainW * INTERVAL_HOURS / 1000);
            } else if (isProfitChargeSlot(s)) {
                s0 += kwhToSoc(maxChargeEnergy);
            } else {
                s0 += kwhToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000);
            }
            s0 = Math.max(MIN_SOC_PCT, Math.min(ARB_CHARGE_SOC_PCT, s0));
        }
        return s0;
    }

    let picks = 0;
    let before = projPeakSoc();
    for (const c of cands) {
        if (before >= ARB_CHARGE_SOC_PCT - 0.1) break; // battery full at the peak
        schedule[c.idx]._plan = 'charge';
        const after = projPeakSoc();
        if (after > before + 0.1) {
            picks++;
            before = after;
        } else {
            schedule[c.idx]._plan = null; // clamped — didn't add deliverable energy
        }
    }

    if (picks > 0) {
        const cheapest = cands[0];
        node.warn(`Phase 3b-arb: picks=${picks} peakMp=${peakMp.toFixed(1)}ct cheapestEff=${cheapest.eff.toFixed(1)}ct net=${cheapest.net.toFixed(1)}ct peakSoc→${before.toFixed(1)}% (cap ${ARB_CHARGE_SOC_PCT}%)`);
    }
})();

// PV-only saturation walk: SOC with no grid-charge and no feed-in plans at
// all. Two consumers. Phase 3c reads satIdx as a "charge wall" — energy bought
// before the pack saturates is displaced by the PV that then spills, so those
// picks buy at retail what the sun delivers free. Phase 3d reads the overflow
// to decide whether an in-horizon refill is genuinely free. Clamped at 99 (the
// runtime curtailment trigger) rather than at MAX_GRID_CHARGE_SOC_PCT, so the
// walk sees the REAL saturation that the planner's own 90% projection cap hides.
let pvOnlySatIdx = -1;
let pvOnlyOverflowRaw = 0;
let pvOnlyTroughSoc = 0; // SOC that must stay in the pack to reach the saturation
{
    let s0 = currentSoc;
    let trough = currentSoc;
    for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i];
        s0 += kwhToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000);
        if (s0 > 99) {
            if (pvOnlySatIdx < 0) {
                pvOnlySatIdx = i;
                // Depth of the dip between now and the saturation: sell past it
                // and the house buys the difference back at retail overnight.
                pvOnlyTroughSoc = Math.max(0, currentSoc - trough);
            }
            pvOnlyOverflowRaw += s0 - 99;
            s0 = 99;
        }
        if (s0 < MIN_SOC_PCT) s0 = MIN_SOC_PCT;
        if (pvOnlySatIdx < 0 && s0 < trough) trough = s0;
    }
}

// Saturation wall: the index at which PV ALONE fills the pack to the
// curtailment trigger. Only honoured when the projected spill is substantive,
// so one forecast wobble can neither suppress a genuine charge (Phase 3c) nor
// unlock a sale against the multi-day reserve (Phase 3d).
const pvSatWall = pvOnlyOverflowRaw >= PV_CURTAIL_MIN_SOC ? pvOnlySatIdx : -1;

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
            } else if (isProfitChargeSlot(s)) {
                // Phase 4 will profit-charge at MAX_CHARGE_W (grid + PV).
                s0 += kwhToSoc(maxChargeEnergy);
            } else {
                s0 += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
            }
            // Clamp at MAX_GRID_CHARGE_SOC_PCT, not 100: once the projected
            // trajectory hits this cap, additional charge picks raise it by
            // 0 → the "did this pick raise traj[d]?" gate fails → Phase 3c
            // exits. Real PV at runtime can still overshoot to 100; only
            // the planner refuses to schedule grid slots past the cap.
            s0 = Math.max(MIN_SOC_PCT, Math.min(MAX_GRID_CHARGE_SOC_PCT, s0));
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
    let picks = 0;
    let wallBlocked = 0;
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
                // No grid-charge at all during preemptive (confirmed glut day ahead):
                // midday PV refills the battery for free, so defending the MIN+5 floor
                // with pre-PV grid charges at retail is the sell-low/buy-high the user
                // vetoes. Let SOC coast (household draws grid; the Phase 4 safety
                // override is likewise suppressed during preemptive pre-PV). The prior
                // gate keyed on isDaylight (flips at civil sunrise ~05:00 local, hours
                // before PV ramps) then on pvPower<load, but Phase 3c just moved the
                // charge to the next eligible slot each time (user report 2026-05-22:
                // 2 morning charges at ~26ct before a 749 sun-min day). Negative-price
                // profit charging is unaffected — that is Phase 3f, not 3c.
                if (targetSocForSunrise !== null) continue;
                // Don't buy across the saturation wall. A charge placed before
                // pvSatWall cannot carry SOC past it — PV fills the pack to the
                // curtailment trigger there and the bought energy is exactly
                // what spills, so the deficit beyond the wall is no better off
                // and we paid retail for it. User report 2026-08-20: 8 grid
                // slots at 22–28ct effective on the 19th, placed to defend an
                // 80% multi-day-reserve floor, while the 20th's PV saturated
                // the pack by midday and then dumped at 11–15ct. The existing
                // "did this pick raise traj[d]?" gate cannot catch this: the
                // trajectory clamps at MAX_GRID_CHARGE_SOC_PCT (90), so the
                // spill above 99 never appears in it.
                if (pvSatWall >= 0 && i < pvSatWall && d >= pvSatWall) { wallBlocked++; continue; }
                eligible.push({ idx: i, effPrice: s.effectivePrice, prePublish: berlinTime(s.time).hour < 13 });
            }
            // Prefer slots at/after the ~13:00 Berlin price publish. Grid-charging
            // earlier is a blind bet on prices that haven't published yet (user
            // 2026-05-20: "charge after 13:00, no need before — price diff is small").
            // Pre-13:00 slots stay a fallback so a genuine morning deficit is still
            // covered: the sort lists them last, used only if no post-publish slot helps.
            eligible.sort((a, b) => (a.prePublish - b.prePublish) || (a.effPrice - b.effPrice));

            const socBefore = traj[d];
            for (const cand of eligible) {
                schedule[cand.idx]._plan = 'charge';
                const newTraj = simulateSocTrajectory();
                if (newTraj[d] > socBefore + 0.1) {
                    committed = true;
                    picks++;
                    break deficitLoop;
                }
                schedule[cand.idx]._plan = null;
            }
        }
        if (!committed) break;
    }
    const finalTraj = simulateSocTrajectory();
    node.warn(`Phase 3c: picks=${picks} endTarget=${slotTarget(lastIdx).toFixed(1)}% endTraj=${finalTraj[lastIdx].toFixed(1)}% peakTraj=${Math.max(...finalTraj).toFixed(1)}% (cap ${MAX_GRID_CHARGE_SOC_PCT}%)${_reserveDeferred ? ` [multi-day reserve deferred; overnight bridge ${_postSchedLoadKwh.toFixed(1)}kWh]` : ''}${pvSatWall >= 0 ? ` [PV saturation wall at idx=${pvSatWall} (${pvOnlyOverflowRaw.toFixed(1)}% spill), ${wallBlocked} candidate(s) refused]` : ''}`);
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
    } else if (isProfitChargeSlot(s)) {
        simSoc += kwhToSoc(maxChargeEnergy);
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

// Effective SOC relief from feeding in a slot vs. doing state=3 there.
// state=3 net SOC delta = (pv-load)*INTERVAL_HOURS/1000 in kWh → kwhToSoc.
// state=4 net SOC delta = -feedinDrainSoc.
// Relief = state3_delta - feedin_delta = feedinDrainSoc + kwhToSoc((pv-load)*INTERVAL_HOURS/1000).
// Used in Phase 3d budget loop: only this much overflow is actually displaced
// per picked feed-in slot. Using full feedinDrainSoc there over-counts the
// state=3 load-drain the slot would have done anyway, leading to too few
// picks and residual runtime curtailment.
function feedinReliefSoc(slot) {
    const netKwh = (slot.pvPower - slot.loadEst) * INTERVAL_HOURS / 1000;
    return feedinDrainSoc(slot) + kwhToSoc(netKwh);
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

// `replacementPrice` is hoisted so Phase 4's runtime "battery full" branch
// can apply the same round-trip economic check that Phase 3d uses for
// non-overflow feed-in (otherwise the runtime fires opportunistically at
// the first soc≥95 slot regardless of whether the drained SOC will be
// replaced at a higher cost).
let replacementPrice = Infinity;

// First schedule index at which the no-feed-in projection saturates (SOC would
// exceed the runtime curtailment trigger). Hoisted so the Phase 3d budget loop
// can tell PRE-saturation slots (draining there creates headroom that PV then
// refills — real curtailment relief) from POST-saturation ones (draining there
// sells stored energy but does nothing to stop the earlier curtailment).
// -1 = no saturation projected.
let satStartIdx = -1;

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
        } else if (isProfitChargeSlot(s)) {
            projSoc += kwhToSoc(maxChargeEnergy);
        } else {
            projSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
        }
        // Cap at the runtime curtailment trigger (soc≥99), not 100. The budget
        // must keep runtime peak BELOW 99 to prevent the soc≥99 branch from
        // firing — using cap=100 here under-budgets by ~1% and leaves a stray
        // curtailment slot at the edge.
        if (projSoc > 99) {
            if (satStartIdx < 0) satStartIdx = i;
            overflowSoc += projSoc - 99;
            projSoc = 99;
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
            } else if (isProfitChargeSlot(s)) {
                extSoc += kwhToSoc(maxChargeEnergy);
            } else {
                extSoc += kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
            }
            if (extSoc > 99) {
                postHorizonOverflow += extSoc - 99;
                extSoc = 99;
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
    // --- PV-overflow damping (single-spike guard) ---------------------------
    // Every "overflow" quantity below is derived from the PV forecast, and the
    // feed-in budget is derived from those. On 2026-07-28 the forecast spiked
    // (surplus 14.5 → 19.1 → 29.0 kWh in 45 min; midday forecast 5000 W against
    // ~1500 W actual), which inflated the budget enough for the mp-DESC pass to
    // spend past the 18.50ct peak all the way down to 15.81ct — and emptied the
    // pack before that 18.50ct slot arrived. Clamp each quantity to its rolling
    // minimum over the last OVERFLOW_DAMP_SLOTS slots: decreases still apply
    // immediately, increases must persist 30 min before they can unlock feed-in.
    // History is bucketed by 15-min SLOT, not by run: the optimizer is normally
    // driven by cron-plus on the slot boundary, but an off-slot re-trigger (an
    // editor inject fired one at 09:31:21 on 2026-07-28) would otherwise consume
    // a history entry and shrink the window in wall-clock terms. Re-runs within
    // the same slot replace that slot's entry instead of pushing a new one, so
    // the window stays time-based regardless of trigger frequency.
    // Window was 4 (~45 min of persistence) until 2026-08-24. That cost the
    // 08:00 slot that morning: PV-only spill went 0 → 38.0% at 07:45 and stayed
    // above 21% every run after, but the min still saw the wall-free 07:00-07:30
    // runs and reported curtailment-bound 0.0%, so the cross-day hold (21.5ct)
    // blocked everything. The budget unlocked at 08:30 and Phase 3d pass 1 sold
    // 16.82/18.04ct — while the 08:00 slot it had just walked past was 20.50ct.
    // At 2 the same 21.3% budget arrives at 08:00 and that slot is the top
    // pre-wall candidate. A spike still has to survive one further run, so the
    // single-run forecast wobbles this guard exists for stay suppressed: 06:45
    // on both 08-23 (11.6%) and 08-24 (9.7%) were length-1 episodes and do not
    // unlock at 2 either. Replaying the whole 08-20..08-24 log, the only unlock
    // that 2 admits and 4 refuses is 08-21 15:45 (two runs at 5.3/6.8%, barely
    // over PV_CURTAIL_MIN_SOC) — a ~1.6 kWh exemption, cheap against a 3.7ct/kWh
    // miss every strong-PV morning.
    const OVERFLOW_DAMP_SLOTS = 2;
    const OVERFLOW_DAMP_MAX_AGE_MS = 90 * 60 * 1000;
    const _ovfHist = global.get('overflowHist') || {};
    const dampOverflow = (key, value) => {
        if (!(typeof value === 'number' && isFinite(value))) return value;
        const slot = Math.floor(_nowMs / (15 * 60 * 1000));
        // A re-run within the same slot keeps that slot's MINIMUM rather than
        // overwriting it — otherwise a re-trigger reporting a higher value would
        // discard the damping for the slot it lands in.
        const prev = (_ovfHist[key] || []).find(e => e.slot === slot);
        const slotVal = (prev && typeof prev.v === 'number' && isFinite(prev.v))
            ? Math.min(prev.v, value) : value;
        // Entries written before slot-bucketing have no .slot and never match a
        // numeric slot, so they simply age out of the window.
        const hist = (_ovfHist[key] || [])
            .filter(e => (_nowMs - e.t) <= OVERFLOW_DAMP_MAX_AGE_MS && e.slot !== slot);
        hist.push({ t: _nowMs, slot, v: slotVal });
        hist.sort((a, b) => a.t - b.t);
        while (hist.length > OVERFLOW_DAMP_SLOTS) hist.shift();
        _ovfHist[key] = hist;
        global.set('overflowHist', _ovfHist);
        return Math.min(...hist.map(e => e.v));
    };
    overflowSoc = dampOverflow('overflowSoc', overflowSoc);
    postHorizonOverflow = dampOverflow('postHorizonOverflow', postHorizonOverflow);
    // Damped here rather than further down with the replacement-price block so
    // the free-refill test below can consult it. Same value, same single
    // dampOverflow call per run — only the position moved.
    const pvOnlyOverflow = dampOverflow('pvOnlyOverflow', pvOnlyOverflowRaw);
    const pvWillCurtail = pvOnlyOverflow >= PV_CURTAIL_MIN_SOC;

    // A refill that SATURATES the pack is free whatever it costs. The
    // marketPrice<3 test above only recognises the negative-price glut, so on
    // an ordinary sunny day the budget collapsed to "overflow only" and the
    // evening peak went unsold — and the next day's PV then had nowhere to go
    // and was dumped as curtailment at half the price. User report 2026-08-20:
    // 20–22ct held on the evening of the 19th, dumped at 11.4–14.9ct on the
    // 20th. SOC carried past a saturation is replaced by PV that would
    // otherwise spill, so holding it costs the full spread. The end-of-schedule
    // floor in the branch below still bounds how far past the saturation we may
    // drain, and every candidate still has to clear the round-trip check and
    // the cross-day hold — this widens the budget, it does not waive a price test.
    if (pvWillCurtail) freeRefillAhead = true;

    let feedinBudgetSoc;
    if (horizonIsRefill && !freeRefillAhead) {
        feedinBudgetSoc = overflowSoc + postHorizonOverflow;
    } else {
        // The multi-day reserve is what has to still be in the pack when the
        // schedule ENDS. When PV alone refills to the curtailment line at
        // pvSatWall, that reserve is replenished for free at the wall, so
        // energy sold before it never touches the reserve — only the dip
        // between now and the wall has to stay behind. Subtracting the full
        // reserve from a pre-wall projection is what held the 20–22ct evening
        // peak on 2026-08-19 (reserve floor 83% vs projection 75% => budget 0)
        // for energy the next midday then spilled at 11–15ct. With no
        // saturation ahead the reserve stands unchanged — that is the sun-poor
        // case, where the stored energy really is the only thing we have.
        const endFloorSoc = pvSatWall >= 0
            ? MIN_SOC_PCT + 8 + pvOnlyTroughSoc
            : kwhToSoc(_postSchedLoadKwh) + MIN_SOC_PCT + 8;
        feedinBudgetSoc = Math.max(0, projSoc + overflowSoc - endFloorSoc);
    }

    // Greedy: pick highest-priced positive-price unplanned slots WITHIN the
    // horizon until budget spent. Slots beyond horizon are not eligible —
    // they belong to the next planning cycle.
    const candidates = schedule
        .slice(0, horizonIdx)
        .map((s, idx) => ({ idx, s }))
        .filter(({ s }) => !s._plan && s.marketPrice > FEEDIN_MIN_MP_CT)
        .sort((a, b) => b.s.marketPrice - a.s.marketPrice);

    // Pre-publish blind-window guard: when tomorrow's prices aren't loaded
    // yet (~13:00 Berlin EPEX publish) AND tomorrow's PV forecast is low,
    // minReplacementEffPrice can't see tomorrow's cheap-recharge slots —
    // the round-trip filter under-estimates replacement cost. Recurring
    // user-flagged loss: morning sell at 13–15ct → next-day grid-charge
    // at ~15.5ct effective. Block non-overflow feed-in; overflow stays
    // exempt (curtailment energy is free regardless of next-day prices).
    const PV_REFILL_RATIO_THRESH = 0.60;
    const _lastSchedTime = schedule.length ? schedule[schedule.length - 1].time : 0;
    const pricesCoverTomorrow = (_lastSchedTime - now) > 25 * 3600 * 1000;
    const _blindTail = [];
    for (let i = schedule.length - 1; i >= 0 && _blindTail.length < 16; i--) {
        const s = schedule[i];
        if (!isDaylight(s.time)) continue;
        const fc = getSunshineForecast(s.time);
        if (fc !== null) _blindTail.push(fc);
    }
    const _tomorrowPvRatioP3d = _blindTail.length >= 4
        ? _blindTail.reduce((a, b) => a + b, 0) / _blindTail.length
        : 0.5;
    const blindToTomorrow = !pricesCoverTomorrow && _tomorrowPvRatioP3d < PV_REFILL_RATIO_THRESH;

    // Round-trip economic check: non-overflow feed-in must beat the
    // cheapest effective price at which we could replace the drained SOC.
    // Otherwise we'd sell at evening price and buy back at morning+gridFee
    // on the next cycle — a net loss. Overflow SOC (curtailment) is
    // exempt: that energy is lost anyway, so any positive revenue wins.
    // Exclude PV-surplus slots: their cheap effective prices are phantom,
    // we can't grid-charge while PV is filling the battery for free. The
    // real replacement is morning compensate/charge at pv<load slots.
    const minReplacementEffPrice = schedule
        .filter(s => !s._plan && s.pvPower < s.loadEst)
        .reduce((m, s) => Math.min(m, s.effectivePrice), Infinity);

    // PV-refill opportunity cost: when sunny weather is genuinely ahead, the
    // SOC we drain tonight will be replaced by tomorrow's PV. The real cost
    // is the forgone PV-time feed-in revenue, not a hypothetical pre-sunrise
    // grid recharge. Negative-mp PV slots cost 0 (we wouldn't feed in there).
    // Scan the WHOLE schedule (not just [0, horizonIdx)) — the PV refill
    // typically lies PAST horizonIdx since the horizon closes at the refill peak.
    let pvOppSum = 0, pvOppCount = 0;
    let cheapPvRefillAhead = false;
    for (const s of schedule) {
        if (isDaylight(s.time) && s.pvPower > s.loadEst) {
            pvOppSum += Math.max(0, s.marketPrice);
            pvOppCount++;
            if (s.marketPrice < 3) cheapPvRefillAhead = true;
        }
    }
    const pvOpportunityPrice = pvOppCount > 0 ? pvOppSum / pvOppCount : Infinity;
    // Apply the PV-opportunity replacement only when PV ITSELF saturates
    // the battery — i.e. a PV-only walk (no grid-charge plans) overflows.
    // overflowSoc/postHorizonOverflow include _plan='charge' adds, so on
    // weak-PV days where Phase 3c plans aggressive midday grid charging
    // they hit >99 even though PV alone never would, falsely triggering
    // pvOpportunityPrice (~avg pv-time mp, ~14ct) instead of the real
    // grid-recharge cost (~minReplacementEffPrice, ~24ct). Result was
    // sell-low/buy-high: morning peaks 15–16ct feed-in then midday grid
    // refill at 22ct effective = ~6ct/kWh round-trip loss.
    // pvOnlyOverflow / pvWillCurtail are computed with the budget branch above
    // (from the hoisted PV-only walk); PV_CURTAIL_MIN_SOC is a top-level constant.

    // Post-schedule PV overflow walk (48h past schedule end). When the next
    // 48h forecast a strong PV refill (e.g. day-after-tomorrow with 600+
    // sun-min), the energy we feed-in at tomorrow's evening peak is replaced
    // by free post-schedule PV rather than grid recharge. The in-schedule
    // pvOnlyOverflow misses this because the horizon ends before the refill.
    let postSchedPvOverflow = 0;
    if (schedule.length > 0) {
        const lastSlotEnd_3d = schedule[schedule.length - 1].time + INTERVAL_HOURS * 3600 * 1000;
        let walkSoc = projSoc;
        for (let h = 0; h < 48; h++) {
            const t = lastSlotEnd_3d + h * 3600000;
            const loadW = getLoadEstimate(t);
            let pvW = 0;
            if (isDaylight(t)) {
                const { profile: hourlyPv, refRatio: baselineRefRatio } = getDayBaseline(t);
                const basePvRaw = hourlyPv[berlinTime(t).hour] || 0;
                const slotForecast = getSunshineForecast(t);
                const ratio = slotForecast !== null ? slotForecast : 0.5;
                pvW = basePvRaw * Math.min(ratio / Math.max(baselineRefRatio, 0.1), 1.2);
            }
            walkSoc += kwhToSoc((pvW - loadW) / 1000);
            if (walkSoc > 99) { postSchedPvOverflow += walkSoc - 99; walkSoc = 99; }
            if (walkSoc < MIN_SOC_PCT) walkSoc = MIN_SOC_PCT;
        }
    }
    postSchedPvOverflow = dampOverflow('postSchedPvOverflow', postSchedPvOverflow);
    const postSchedPvWillCurtail = postSchedPvOverflow >= PV_CURTAIL_MIN_SOC;

    // Position guard: post-schedule PV only refills energy we feed-in AFTER
    // the last planned grid-charge. A slot before any planned charge is
    // replaced by that grid charge, not by post-schedule PV — applying the
    // looser late-slot economics there would re-create the sell-low/buy-high
    // round trip the strict check blocks.
    let lastPlannedChargeIdx = -1;
    for (let i = schedule.length - 1; i >= 0; i--) {
        if (schedule[i]._plan === 'charge') { lastPlannedChargeIdx = i; break; }
    }

    replacementPrice = (cheapPvRefillAhead || pvWillCurtail)
        ? Math.min(minReplacementEffPrice, pvOpportunityPrice)
        : minReplacementEffPrice;
    const replacementPriceLate = (cheapPvRefillAhead || pvWillCurtail || postSchedPvWillCurtail)
        ? Math.min(minReplacementEffPrice, pvOpportunityPrice)
        : minReplacementEffPrice;
    const eligibleOverflowLate = pvOnlyOverflow + postSchedPvOverflow;

    // Single-pass selection with per-slot replacement logic. Candidates are
    // sorted by mp DESC, so picks happen in best-revenue-first order globally.
    //
    // For each candidate, the replacement source depends on its position
    // relative to the last planned Phase 3c grid-charge:
    //   - AFTER lastPlannedChargeIdx ("late"): post-schedule PV refills it,
    //     so use min(minReplaceEff, pvOpportunityPrice) when post-sched (or
    //     in-horizon) PV will curtail. Overflow budget includes postSchedPvOverflow.
    //   - AT-OR-BEFORE lastPlannedChargeIdx ("early"): the replacement is the
    //     next-cheapest unplanned grid-charge slot (= minReplaceEff). No
    //     pvOpportunity bypass — future PV lies beyond a planned charge wall
    //     and won't actually refill the energy we drain here.
    //
    // Failed round-trip check uses `continue` (not `break`): a high-mp early
    // slot may fail strict check while a lower-mp late slot still passes its
    // looser check. Within the SAME pass-eligibility class (early or late),
    // mp DESC ordering means cheaper-but-lower-mp slots strictly fail the same
    // check, so continue is harmless. usedBudget guard still breaks the loop
    // once the feed-in budget is spent.
    // Early feed-in (before/at the last planned grid-charge) is replaced by
    // EXTENDING tomorrow's grid-charge into its MARGINAL (most-expensive) slots,
    // not the single globally-cheapest unplanned slot. Holding 1 kWh tonight
    // drops the priciest planned charge slot, so the marginal refill cost is the
    // max effective price among planned 'charge' slots. Using minReplaceEff here
    // (e.g. a 12.7 ct summer-discounted midday slot) let tonight's ~18 ct evening
    // peak pass the round-trip check while the real rebuy cost was ~22 ct
    // effective — the "discharge today, charge tomorrow" loss the user flagged.
    const _plannedChargeEffs = schedule.filter(s => s._plan === 'charge').map(s => s.effectivePrice);
    const _marginalChargeEff = _plannedChargeEffs.length ? Math.max(..._plannedChargeEffs) : -Infinity;
    const replacementPriceEarly = Math.max(minReplacementEffPrice, _marginalChargeEff);

    // --- Cross-day feed-in hold (opportunity-cost floor) ---
    // Tonight's candidates only span [0, horizonIdx); a materially higher
    // feed-in peak BEYOND the horizon (tomorrow evening) is invisible to this
    // greedy pass, and the round-trip check only guards grid REBUY cost. When
    // pvWillCurtail is true it even uses pvOpportunityPrice (~PV-time mp, low) as
    // replacement, so tonight's stored energy sells at 14–18ct while tomorrow's
    // 46ct peak is missed (the reported case). Fix: when a refill horizon exists,
    // find the best stored-energy (pv<load) feed-in peak BEYOND the horizon and
    // require tonight's feed-in to clear it (minus slack) to sell — otherwise
    // hold the SOC for that better peak (captured next cycle as the horizon
    // advances). The genuinely curtailment-bound portion (pvOnlyOverflow) is
    // still sold tonight (see the exemption in the loop): that energy would be
    // lost to curtailment if held, so selling it at any price beats wasting it.
    let futurePeakHoldPrice = -Infinity;
    let futurePeakMp = -Infinity;
    let futurePeakTime = null;
    if (horizonIsRefill) {
        for (let i = horizonIdx; i < schedule.length; i++) {
            const s = schedule[i];
            // Only stored-energy slots (pv<load): a high price during a PV
            // surplus is served by PV, not the battery — no reason to hold for it.
            if (s.pvPower < s.loadEst && s.marketPrice > futurePeakMp) {
                futurePeakMp = s.marketPrice;
                futurePeakTime = s.time;
            }
        }
    }
    if (isFinite(futurePeakMp)) {
        futurePeakHoldPrice = futurePeakMp - CROSSDAY_HOLD_SLACK_CT;
        global.set('crossDayHold', { mp: futurePeakMp, peakTime: futurePeakTime, time: _nowMs });
        node.warn(`Cross-day hold: future peak ${futurePeakMp.toFixed(1)}ct beyond horizon → hold tonight stored-energy feed-in below ${futurePeakHoldPrice.toFixed(1)}ct (curtailment-bound ${pvOnlyOverflow.toFixed(1)}% still sells)`);
    } else {
        // horizonIsRefill flips false once the refill point passes (2026-07-28
        // ~06:00), which silently dropped the 20.9ct floor that had protected the
        // stored energy all night and let the morning sell at 15.8–16.8ct. Carry
        // the last floor while the peak it came from is still ahead of us; the
        // next run with a real refill horizon recomputes it from scratch.
        const _cdh = global.get('crossDayHold');
        if (_cdh && typeof _cdh.mp === 'number' && typeof _cdh.peakTime === 'number'
            && _cdh.peakTime > now && (_nowMs - _cdh.time) <= CROSSDAY_HOLD_MAX_AGE_MS) {
            futurePeakHoldPrice = _cdh.mp - CROSSDAY_HOLD_SLACK_CT;
            node.warn(`Cross-day hold (carried): peak ${_cdh.mp.toFixed(1)}ct still ahead → hold stored-energy feed-in below ${futurePeakHoldPrice.toFixed(1)}ct (curtailment-bound ${pvOnlyOverflow.toFixed(1)}% still sells)`);
        }
    }

    let usedBudget = 0;

    // Price the runtime would achieve if we plan nothing and let Phase 4's
    // "battery full" branch dump into whatever slot happens to be current:
    // the mean marketPrice across the projected saturation run (consecutive
    // PV-surplus slots from satStartIdx). This is the price a pre-saturation
    // drain has to beat.
    let satDumpPrice = Infinity;
    if (satStartIdx >= 0) {
        const satRun = [];
        for (let i = satStartIdx; i < horizonIdx; i++) {
            const s = schedule[i];
            if (s.pvPower <= s.loadEst) break;
            if (typeof s.marketPrice === 'number') satRun.push(s.marketPrice);
        }
        if (satRun.length) satDumpPrice = satRun.reduce((a, b) => a + b, 0) / satRun.length;
    }

    const planSlot = (s, idx, budgetCap) => {
        const relief = feedinReliefSoc(s);
        if (relief <= 0) return false;
        if (usedBudget >= budgetCap) return 'full';
        const isLate = idx > lastPlannedChargeIdx;
        const slotReplacementPrice = isLate ? replacementPriceLate : replacementPriceEarly;
        const slotEligibleOverflow = isLate ? eligibleOverflowLate : pvOnlyOverflow;
        // Curtailment ("overflow") energy only physically exists in slots where
        // PV actually exceeds load and the battery is at cap. Feeding the early
        // overflow budget into a PV<=load slot (e.g. tonight's evening peak,
        // PV=0) drains STORED energy that a later grid-charge then replaces at
        // retail — the "discharge today, charge tomorrow" round-trip loss. So an
        // early (pre-grid-charge) slot is overflow-exempt only when it is itself
        // a real PV-surplus slot; otherwise it must pass the round-trip check.
        // Late slots (after the last planned grid-charge) keep the existing
        // next-day-PV-refill exemption via isLate.
        const isOverflowOnly = usedBudget + relief <= slotEligibleOverflow
            && (isLate || s.pvPower > s.loadEst);
        // Cross-day hold: don't sell STORED energy tonight below a materially
        // higher future peak. Exempt only the genuinely curtailment-bound
        // portion (within pvOnlyOverflow — real in-schedule PV curtailment that
        // would be lost if held), NOT the postSched-inclusive isOverflowOnly
        // budget (post-schedule overflow is speculative and days past the peak).
        const genuineOverflowExempt = (usedBudget + relief <= pvOnlyOverflow)
            && (isLate || s.pvPower > s.loadEst);
        if (!genuineOverflowExempt && s.marketPrice < futurePeakHoldPrice) return false;
        if (!isOverflowOnly && (blindToTomorrow || s.marketPrice <= slotReplacementPrice + FEEDIN_ROUNDTRIP_MARGIN_CT)) return false;
        s._plan = 'feedin_surplus';
        usedBudget += relief;
        return true;
    };

    // --- Pass 1: pre-saturation headroom ------------------------------------
    // The mp-DESC pass below spends the overflow budget on the highest-priced
    // slots in the horizon regardless of WHEN they fall. On a strong-PV day the
    // evening peak outbids every daytime slot, so the whole budget lands after
    // the battery has already sat at 100% for hours — and the PV that overflowed
    // in between was either curtailed outright or dumped by Phase 4's runtime
    // branch at whatever the midday price happened to be (10–15 ct in the
    // 2026-07-07..08-05 sample, against 17–20 ct pre-saturation prices on the
    // same days). Selling at 20:00 cannot relieve a 14:00 curtailment: only a
    // drain BEFORE saturation creates headroom that the PV then refills.
    //
    // So reserve the in-horizon overflow for pre-saturation slots first, ranked
    // by price among those. Gated on beating the projected dump price by
    // PRESAT_MIN_GAIN_CT so this can never degrade into the low-price midday
    // pre-drain that trades evening-peak SOC for cheap daytime revenue — the
    // hurdle is the price the energy would otherwise fetch, not zero.
    if (satStartIdx >= 0 && isFinite(satDumpPrice)) {
        const presatCap = Math.min(feedinBudgetSoc, Math.max(0, overflowSoc));
        const presat = candidates.filter(({ idx, s }) =>
            idx < satStartIdx && s.marketPrice >= satDumpPrice + PRESAT_MIN_GAIN_CT);
        let picked = 0;
        for (const { s, idx } of presat) {
            const r = planSlot(s, idx, presatCap);
            if (r === 'full') break;
            if (r) picked++;
        }
        if (picked > 0) {
            node.warn(`Phase 3d pre-saturation: ${picked} slot(s) before idx=${satStartIdx} `
                + `(dump would fetch ${satDumpPrice.toFixed(1)}ct, hurdle ${(satDumpPrice + PRESAT_MIN_GAIN_CT).toFixed(1)}ct, `
                + `cap ${presatCap.toFixed(1)}%)`);
        }
    }

    // --- Pass 2: original global mp-DESC allocation --------------------------
    for (const { s, idx } of candidates) {
        if (s._plan) continue;
        if (planSlot(s, idx, feedinBudgetSoc) === 'full') break;
    }
    // Rationale for `break` (not `continue`): candidates are sorted by
    // marketPrice DESC. If the current slot doesn't fit, falling through to
    // cheaper-but-smaller slots would replace a potentially big high-priced
    // slot with a small low-priced one — strictly worse revenue. Leave the
    // remaining budget unused; it'll carry over into the next planning cycle
    // or, if curtailment actually happens, Phase 4's runtime "battery full"
    // branch handles it.
}

// --- 3d.2. Saturation cluster pre-pick ---
// Even when projected SOC peaks below 100% (no formal overflow) but stays
// at ≥95% across a run of PV-surplus slots, the runtime "battery full"
// fallback would otherwise fire at the FIRST slot crossing 95% — which is
// often a price dip, not the cluster's best mp. This pass walks the passive
// projection (`_plannedSoc` set in the simSoc loop above), identifies
// consecutive (soc≥95 + PV>load+500) clusters Phase 3d didn't already
// commit, and marks the highest-mp slot per cluster as `feedin_saturation`
// — but only if mp beats `replacementPrice` (otherwise no feed-in is
// economically justified anywhere in the cluster).
{
    let i = 0;
    while (i < schedule.length) {
        const s = schedule[i];
        const inCluster = s._plannedSoc >= 95 && (s.pvPower - s.loadEst) > 500;
        if (!inCluster) { i++; continue; }
        let j = i;
        while (j + 1 < schedule.length
               && schedule[j+1]._plannedSoc >= 95
               && (schedule[j+1].pvPower - schedule[j+1].loadEst) > 500) {
            j++;
        }
        let bestIdx = -1, bestMp = -Infinity;
        for (let k = i; k <= j; k++) {
            const sk = schedule[k];
            if (sk._plan) continue;
            if (sk.marketPrice <= FEEDIN_MIN_MP_CT) continue;
            if (sk.marketPrice <= replacementPrice) continue;
            if (sk.marketPrice > bestMp) { bestMp = sk.marketPrice; bestIdx = k; }
        }
        if (bestIdx >= 0) {
            schedule[bestIdx]._plan = 'feedin_saturation';
            node.warn(`Saturation cluster [${i}..${j}]: pick idx=${bestIdx} mp=${bestMp.toFixed(2)}ct (replacement ${replacementPrice.toFixed(1)}ct)`);
        }
        i = j + 1;
    }
}

// --- 3e. Pre-discharge for upcoming profit-charge windows ---
// When consecutive ep<0 slots will saturate the battery and curtail
// paid-to-import, plan feed-in BEFORE each window at the highest-mp
// unplanned earlier slots. Round-trip is mp_discharge + |min_ep_in_window|
// minus cycle wear; threshold is mp > minEp + cycle_wear (typically
// negative for deep neg-eff, so any mp > 0 passes).
{
    const PROFIT_CHARGE_CYCLE_WEAR_CT = 3;

    // Walk schedule, simulate SOC including profit-charge to find each
    // saturated profit-charge stretch and its overflow.
    let walkSoc = currentSoc;
    let stretchStart = -1;
    let stretchOverflow = 0;
    let stretchMinEp = Infinity;
    const stretches = [];

    function closeStretch(endIdx) {
        if (stretchStart >= 0 && stretchOverflow > 0.1) {
            stretches.push({ start: stretchStart, end: endIdx,
                             overflowSoc: stretchOverflow, minEp: stretchMinEp });
        }
        stretchStart = -1;
        stretchOverflow = 0;
        stretchMinEp = Infinity;
    }

    for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i];
        const pvW = s.pvPower;
        const loadW = s.loadEst;
        const profitCharge = isProfitChargeSlot(s);

        let socDelta;
        if (s._plan === 'charge') {
            socDelta = kwhToSoc(maxChargeEnergy);
        } else if (s._plan === 'feedin_preemptive'
                   || s._plan === 'feedin_surplus'
                   || s._plan === 'feedin_capacity') {
            socDelta = -feedinDrainSoc(s);
        } else if (profitCharge) {
            socDelta = kwhToSoc(maxChargeEnergy);
        } else {
            socDelta = kwhToSoc((pvW - loadW) * INTERVAL_HOURS / 1000);
        }

        walkSoc += socDelta;
        let overflow = 0;
        if (walkSoc > 100) { overflow = walkSoc - 100; walkSoc = 100; }
        if (walkSoc < MIN_SOC_PCT) walkSoc = MIN_SOC_PCT;

        if (profitCharge) {
            if (stretchStart < 0) stretchStart = i;
            stretchOverflow += overflow;
            if (s.effectivePrice < stretchMinEp) stretchMinEp = s.effectivePrice;
        } else {
            closeStretch(i);
        }
    }
    closeStretch(schedule.length);

    // For each stretch, plan pre-discharge at most-expensive earlier
    // unplanned slots until overflow consumed.
    for (const st of stretches) {
        const minThreshold = Math.max(FEEDIN_MIN_MP_CT, st.minEp + PROFIT_CHARGE_CYCLE_WEAR_CT);
        const candidates = schedule
            .slice(0, st.start)
            .map((s, idx) => ({ idx, s }))
            .filter(({ s }) => !s._plan
                               && s.marketPrice > minThreshold
                               && feedinDrainSoc(s) > 0)
            .sort((a, b) => b.s.marketPrice - a.s.marketPrice);

        let freed = 0;
        for (const { s } of candidates) {
            if (freed >= st.overflowSoc) break;
            s._plan = 'feedin_capacity';
            freed += feedinDrainSoc(s);
        }
        node.warn(`Phase 3e: stretch [${st.start}..${st.end}] minEp=${st.minEp.toFixed(1)}ct overflow=${st.overflowSoc.toFixed(1)}% freed=${freed.toFixed(1)}% threshold=${minThreshold.toFixed(1)}ct`);
    }
}

// --- 3f. Within each profit-charge stretch, plan the K cheapest-ep slots ---
// Phase 4 no longer profit-charges greedily by time; instead, Phase 3f selects
// the deepest-negative slots within each stretch up to the entry-SOC headroom.
// Slots NOT picked stay unplanned and fall through to Phase 4's PV-surplus /
// curtail branches.
{
    function applyDelta(s, soc) {
        let d;
        if (s._plan === 'charge') d = kwhToSoc(maxChargeEnergy);
        else if (s._plan === 'feedin_preemptive'
                 || s._plan === 'feedin_surplus'
                 || s._plan === 'feedin_capacity') d = -feedinDrainSoc(s);
        else d = kwhToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000);
        soc += d;
        if (soc > 100) soc = 100;
        if (soc < MIN_SOC_PCT) soc = MIN_SOC_PCT;
        return soc;
    }

    let walkSoc = currentSoc;
    let stretchStart = -1;
    let stretchEntrySoc = 0;
    const socPerCharge = kwhToSoc(maxChargeEnergy);

    function closeStretch(endIdx) {
        if (stretchStart < 0) return;
        let alreadyChargedInStretch = 0;
        const unplanned = [];
        for (let j = stretchStart; j < endIdx; j++) {
            if (schedule[j]._plan === 'charge') alreadyChargedInStretch++;
            else if (!schedule[j]._plan) unplanned.push({ idx: j, ep: schedule[j].effectivePrice });
        }
        unplanned.sort((a, b) => a.ep - b.ep);
        const totalK = Math.floor((100 - stretchEntrySoc) / socPerCharge + 0.001);
        const K = Math.max(0, totalK - alreadyChargedInStretch);
        const picked = unplanned.slice(0, K);
        for (const p of picked) schedule[p.idx]._plan = 'charge';
        // Re-walk stretch with actual plans applied
        let s = stretchEntrySoc;
        for (let j = stretchStart; j < endIdx; j++) s = applyDelta(schedule[j], s);
        walkSoc = s;
        node.warn(`Phase 3f: stretch [${stretchStart}..${endIdx}] entrySoc=${stretchEntrySoc.toFixed(1)}% totalK=${totalK} preplanned=${alreadyChargedInStretch} picked=${picked.length}/${unplanned.length}`);
        stretchStart = -1;
    }

    for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i];
        const profitCharge = isProfitChargeSlot(s);

        if (profitCharge && stretchStart < 0) {
            stretchStart = i;
            stretchEntrySoc = walkSoc;
        }

        if (stretchStart >= 0 && profitCharge) {
            // In stretch: defer SOC update to closeStretch
            continue;
        }

        if (stretchStart >= 0 && !profitCharge) {
            closeStretch(i);
        }

        walkSoc = applyDelta(s, walkSoc);
    }
    if (stretchStart >= 0) closeStretch(schedule.length);
}

// Overnight-survival guard: the per-slot forward-validate below only keeps
// each feed-in slot's OWN SOC above MIN+5; it ignores the household load that
// keeps draining AFTER the last feed-in. On a sunny-tomorrow plan Phase 3d
// drains the evening peak down to ~MIN+5 (tomorrow's free PV is the assumed
// replacement), then overnight compensate slides SOC to MIN and Phase 4 fires
// emergency grid charges at ~retail effective price — buying back what was
// just sold cheaper. User report 2026-05-21: 15 evening feed-in slots (15-23ct)
// drained SOC to 10%, then 4 overnight grid charges at ~27ct effective.
// Walk the WHOLE trajectory; while its trough breaches MIN+5, give back the
// lowest-mp feed-in slot at/before the trough and re-walk. This drops only the
// marginal feed-ins that force the rebuy and preserves the high-mp peaks that
// tomorrow's PV genuinely refills.
{
    const SURVIVAL_FLOOR = MIN_SOC_PCT + 5;
    function feedinTrough() {
        let soc = currentSoc;
        let minSoc = Infinity, minIdx = -1;
        for (let i = 0; i < schedule.length; i++) {
            const s = schedule[i];
            if (s._plan === 'charge') {
                soc += kwhToSoc(maxChargeEnergy);
            } else if (s._plan === 'feedin_preemptive'
                       || s._plan === 'feedin_surplus'
                       || s._plan === 'feedin_capacity') {
                soc -= feedinDrainSoc(s);
            } else {
                soc += kwhToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000);
            }
            if (soc > 100) soc = 100;
            // Do NOT clamp at MIN here: we need the true trough depth to know
            // how much feed-in to give back.
            if (soc < minSoc) { minSoc = soc; minIdx = i; }
        }
        return { minSoc, minIdx };
    }
    let _demoted = 0;
    let guard = 0;
    while (guard++ < schedule.length) {
        const { minSoc, minIdx } = feedinTrough();
        if (minSoc >= SURVIVAL_FLOOR || minIdx < 0) break;
        let demoteIdx = -1, demoteMp = Infinity;
        for (let i = 0; i <= minIdx; i++) {
            const s = schedule[i];
            if ((s._plan === 'feedin_surplus'
                 || s._plan === 'feedin_capacity'
                 || s._plan === 'feedin_preemptive')
                && s.marketPrice < demoteMp) {
                demoteMp = s.marketPrice; demoteIdx = i;
            }
        }
        if (demoteIdx < 0) break; // trough is structural (load-driven); Phase 4 will charge
        schedule[demoteIdx]._plan = null;
        _demoted++;
    }
    if (_demoted > 0) node.warn(`Overnight-survival guard: demoted ${_demoted} feed-in slot(s) to keep trough >= ${SURVIVAL_FLOOR}%`);
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
        } else if (s._plan === 'feedin_preemptive'
                   || s._plan === 'feedin_surplus'
                   || s._plan === 'feedin_capacity') {
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
        // Planned cheapest-slot charging. Skip when PV has already overfilled the
        // battery past the planning cap: real SOC tracks above MAX_GRID_CHARGE_SOC_PCT
        // while the planner's clamped sim assumed ~cap, so the pick would grid-charge an
        // almost-full battery at a positive price. Profit charges (ep<0, paid to import)
        // still fill.
        if ((soc < MAX_GRID_CHARGE_SOC_PCT || ep < 0) && !(i === 0 && gridChargeBlocked)) {
            state = 1; setPoint = MAX_CHARGE_W;
            reason = `Planned charge at ${ep.toFixed(1)}ct (cheapest available)`;
        } else if (i === 0 && gridChargeBlocked) {
            state = 3; setPoint = -AVG_LOAD_W;
            reason = !socTrust
                ? `Skip planned charge — SOC reading untrusted, compensate`
                : `Skip planned charge — cell ${maxCellV.toFixed(3)}V ≥ ${CELL_FULL_V}V (full), compensate`;
        } else {
            state = 3; setPoint = -AVG_LOAD_W;
            reason = `Skip planned charge, SOC ${soc.toFixed(0)}% >= ${MAX_GRID_CHARGE_SOC_PCT}% cap (PV overfilled), compensate`;
        }
    }
    else if ((plan === 'feedin_surplus' || plan === 'feedin_capacity' || plan === 'feedin_saturation')
             && soc > MIN_SOC_PCT + kwhToSoc(maxDischargeEnergy) + 5) {
        // Planned feed-in — already validated in Phase 3 with price-aware revocation
        state = 4; setPoint = -MAX_DISCHARGE_W;
        const tag = plan === 'feedin_capacity' ? 'free capacity for PV'
                  : plan === 'feedin_saturation' ? 'saturation cluster best'
                  : 'surplus energy';
        reason = `Planned feed-in at ${mp.toFixed(1)}ct (${tag})`;
    }
    // (Profit-charge is now planned in Phase 3f as _plan='charge'; no runtime branch.)
    // Strong PV surplus: let solar charge battery
    else if (pvW - loadW > 1000 && soc < 95) {
        state = 3; setPoint = -AVG_LOAD_W;
        reason = `Strong PV surplus ${(pvW - loadW)}W, solar charges battery`;
    }
    // PV surplus + battery near full. Two firing conditions:
    //   1. Imminent curtailment (soc ≥ 99): PV is being wasted, sell at any
    //      mp > FEEDIN_MIN_MP_CT.
    //   2. Round-trip profitable: mp > replacementPrice (drained SOC is
    //      cheaper to replace at PV/morning-grid than the current sell mp).
    // Otherwise hold (state=3): the cluster best-mp slot was either picked
    // by Phase 3d's saturation pass (feedin_saturation plan) and will fire
    // at its slot, or no slot in the cluster is economic — don't cycle the
    // battery for a loss-making sale at the first soc≥95 slot.
    else if (pvW - loadW > 500 && soc >= 95) {
        if (soc >= 99 && mp > FEEDIN_MIN_MP_CT) {
            state = 4; setPoint = -MAX_DISCHARGE_W;
            reason = `Battery curtailing ${soc.toFixed(0)}%, feed-in at ${mp.toFixed(1)}ct`;
        } else if (mp > replacementPrice && mp > FEEDIN_MIN_MP_CT) {
            state = 4; setPoint = -MAX_DISCHARGE_W;
            reason = `Battery full ${soc.toFixed(0)}%, profitable feed-in at ${mp.toFixed(1)}ct (replacement ${replacementPrice.toFixed(1)}ct)`;
        } else {
            state = 3; setPoint = -AVG_LOAD_W;
            const repStr = isFinite(replacementPrice) ? replacementPrice.toFixed(1) + 'ct' : 'no-replace';
            reason = `Battery full ${soc.toFixed(0)}%, hold (mp ${mp.toFixed(1)}ct ≤ replacement ${repStr})`;
        }
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
        } else if (i === 0 && gridChargeBlocked) {
            state = 3; setPoint = -AVG_LOAD_W;
            reason = !socTrust
                ? `Compensate — SOC reading untrusted, no grid-charge (SOC ${soc.toFixed(0)}%)`
                : `Compensate — cell ${maxCellV.toFixed(3)}V full, no grid-charge (SOC ${soc.toFixed(0)}%)`;
        } else {
            // Not enough SOC for future load and price <= 0 — charge now
            state = 1; setPoint = MAX_CHARGE_W;
            reason = `Charge at ${ep.toFixed(1)}ct, SOC ${soc.toFixed(0)}% < ${socNeeded.toFixed(0)}% needed`;
        }
    }

    // --- Hold-for-sun-poor-tomorrow override (user rule) ---------------------
    // On a sun-poor-tomorrow day, never feed STORED energy to the grid. Feed-in is
    // allowed ONLY as genuine overflow: there is live PV surplus (pv > load) AND the
    // battery is already full (SOC >= 99 or cell at the ceiling) — i.e. PV that
    // physically can't be stored. Everything else (selling at the evening peak, or
    // dumping surplus while the battery still has room) is converted to compensate,
    // so the surplus tops the battery toward 100% and stored energy is held.
    const _pvOverflow = (pvW - loadW) > 0
        && (soc >= 99 || (maxCellV !== null && maxCellV >= CELL_FULL_V));
    if (state === 4 && tomorrowSunPoor && !_pvOverflow) {
        state = 3; setPoint = -AVG_LOAD_W;
        reason = `Hold for sun-poor tomorrow — no feed-in below full (was sell @${mp.toFixed(1)}ct, SOC ${soc.toFixed(0)}%)`;
    }

    // --- Feed-in delivery guard ---------------------------------------------
    // A previous feed-in command the pack couldn't follow means the trusted (BMS)
    // SOC overstates deliverable energy. Applied at i===0 only; future slots
    // re-evaluate once SOC recovers or the block ages out.
    if (i === 0 && state === 4 && feedinDeliveryBlocked) {
        state = 3; setPoint = -AVG_LOAD_W;
        reason = `Feed-in blocked: last command under-delivered (SOC ${soc.toFixed(0)}% not deliverable)`;
    }

    // === Update SOC prediction ===
    let socDelta = 0;

    if (state === 1) {
        // Battery absorbs at most MAX_CHARGE_W total (grid + PV combined).
        // Charging energy lands as SOC at CHARGE_EFFICIENCY (see constant).
        socDelta += kwhToSoc(maxChargeEnergy * CHARGE_EFFICIENCY);
    } else if (state === 3) {
        // Compensate: PV covers load first, surplus charges battery, deficit drains battery.
        // Surplus (charge) is de-rated by CHARGE_EFFICIENCY; deficit (discharge) is not.
        const netPvW = pvW - loadW;
        const eff = netPvW > 0 ? CHARGE_EFFICIENCY : 1;
        socDelta += kwhToSoc(netPvW * INTERVAL_HOURS / 1000 * eff);
    } else if (state === 4) {
        // Max discharge: battery feeds grid at max rate + covers load, PV offsets some
        const drainW = MAX_DISCHARGE_W + loadW - pvW;
        socDelta -= kwhToSoc(Math.max(0, drainW) * INTERVAL_HOURS / 1000);
    }

    soc = Math.max(MIN_SOC_PCT, Math.min(100, soc + socDelta));

    // Safety: if SOC hits minimum, override to charge
    // But NEVER charge from grid during preemptive discharge (night before solar day)
    if (soc <= MIN_SOC_PCT && state !== 1
        && !(targetSocForSunrise !== null && pvW < loadW)) {
        state = 1; setPoint = MAX_CHARGE_W;
        reason = `SOC safety override - must charge`;
        soc = MIN_SOC_PCT + kwhToSoc(maxChargeEnergy * CHARGE_EFFICIENCY);
    }

    slot.state = state;
    slot.predictedSoc = Math.round(soc * 10) / 10;
    slot.reason = reason;
    slot.acPowerSetPoint = setPoint;
}

// === Build output ===
const output = schedule.map(s => ({
    t: s.time,
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
    preemptiveSlots: preemptiveDischargeSlots.size,
    socSource: _socSource,
    socFlatMin: Math.round(_socFlatMin),
    socStale: socStale
};


// msg3: current setpoint for ESS control
var weather7 = global.get("weather7days", "file")

// A stale SOC makes the whole plan above fiction, so the live slot falls back to
// state 3 (cover the household load) rather than acting on it. Emitting nothing
// would leave the Cerbo pinned in whatever state 1 or 4 the last good run had
// commanded, charging or draining blind - worse than doing nothing.
const _cmdState = socStale ? 3 : (currentSlot ? currentSlot.state : 3);
const _cmdReason = socStale
    ? `SOC stale (${currentSoc.toFixed(1)}% flat ${Math.round(_socFlatMin)}min, source ${_socSource}) - holding at load compensation`
    : (currentSlot ? currentSlot.reason : 'no data');

// === Device parameters (Cerbo + Symo) ===
// The published command carries the concrete settings each box is about to
// receive, each with a one-line reason. cerbo_control and symo_gate consume
// these instead of re-deriving them, so every threshold lives here only and a
// subscriber can see what was commanded and why without replaying the planner.
const IDLE_SETPOINT_W = 30;       // the Cerbo's normal self-consumption grid setpoint
const MAX_TOTAL_FEEDIN_W = 4900;  // hard cap on COMBINED grid feed-in from every source
const SYMO_DISABLE_MP_CT = -20;   // below this the grid pays us more than PV output is worth

const _mp = currentSlot && typeof currentSlot.marketPrice === 'number'
    ? currentSlot.marketPrice : null;
const _mpTxt = _mp === null ? 'an unknown price' : _mp.toFixed(1) + 'ct';
const _negPrice = (_mp !== null && _mp < 0);

// Only AcPowerSetPoint can *force* an import or an export; the other four
// settings are limits that gate what the ESS is allowed to do on its own.
let _acSetPoint, _maxDischarge, _setPointWhy, _maxDischargeWhy;
if (_cmdState === 1) {
    _acSetPoint = MAX_CHARGE_W;
    _maxDischarge = 0;
    _setPointWhy = `state 1 at ${_mpTxt}: force ${MAX_CHARGE_W}W import to charge the pack`;
    _maxDischargeWhy = 'pinned to 0 so the pack cannot discharge back out while we are paying to fill it';
} else if (_cmdState === 4) {
    _acSetPoint = -MAX_DISCHARGE_W;
    _maxDischarge = -1;
    _setPointWhy = `state 4 at ${_mpTxt}: force ${MAX_DISCHARGE_W}W export, this is a grid setpoint so it caps total feed-in`;
    _maxDischargeWhy = '-1 = no limit, the setpoint alone decides how hard the pack is pushed';
} else {
    _acSetPoint = IDLE_SETPOINT_W;
    _maxDischarge = -1;
    _setPointWhy = `state 3 at ${_mpTxt}: self-consumption, grid held near ${IDLE_SETPOINT_W}W so the pack covers the house and nothing is forced either way`;
    _maxDischargeWhy = '-1 = no limit, the pack is free to cover whatever the house draws';
}

// Hard rule: never export at a negative market price - we would be paying the
// grid to take it. PreventFeedback=1 blocks PV feed-in as well as the battery,
// which is exactly what we want while the price is below zero.
const _preventFeedback = _negPrice ? 1 : 0;

// The plan above already rewrites feed-in at mp < 0 into state 3, so a negative
// price with an export setpoint should never get here. If it ever does, do not
// command an export we are simultaneously blocking.
if (_negPrice && _acSetPoint < 0) {
    _acSetPoint = IDLE_SETPOINT_W;
    _setPointWhy = `export cancelled: ${_mpTxt} is below zero, we would be paying the grid to take it - falling back to self-consumption`;
}
// Backstop only: cannot bite while MAX_DISCHARGE_W is 3500, but keeps the
// combined-feed-in invariant true if that is ever raised.
if (_acSetPoint < -MAX_TOTAL_FEEDIN_W) {
    _acSetPoint = -MAX_TOTAL_FEEDIN_W;
    _setPointWhy = `clamped to the ${MAX_TOTAL_FEEDIN_W}W combined feed-in cap`;
}

const _cerboParams = {
    AcPowerSetPoint: { value: _acSetPoint, unit: 'W', why: _setPointWhy },
    MaxChargePower: {
        value: MAX_CHARGE_W, unit: 'W',
        why: 'charger ceiling, matches the inverter/pack rating the planner budgets with'
    },
    MaxDischargePower: { value: _maxDischarge, unit: 'W', why: _maxDischargeWhy },
    MaxFeedInPower: {
        value: MAX_TOTAL_FEEDIN_W, unit: 'W',
        why: 'hard cap on combined grid feed-in from battery and PV together; the Symo cannot reach it alone, so it only ever trims the battery share and never curtails PV'
    },
    PreventFeedback: {
        value: _preventFeedback, unit: 'bool',
        why: _preventFeedback
            ? `${_mpTxt} is below zero - block all export, battery and PV alike`
            : (_mp === null
                ? 'no price to judge on - export left allowed, the plan already fell back to self-consumption'
                : `${_mpTxt} is at or above zero - export allowed`)
    }
};

// Symo: at a deeply negative price the grid pays us per kWh imported, so every
// watt the inverter makes is a watt we are not being paid for. Between -20 and
// 0 ct the *effective* import price is still positive once the grid fee is
// added, so self-consuming PV still beats importing and cutting it costs money.
const _symoOff = (_mp !== null && _mp < SYMO_DISABLE_MP_CT);
const _symoParams = {
    setlimit: {
        value: _mp === null ? null : (_symoOff ? 0 : 'disable'),
        unit: _symoOff ? '%' : 'cmd',
        why: _mp === null
            ? 'no market price for this slot - no opinion, the Symo is left alone'
            : (_symoOff
                ? `${_mpTxt} is below ${SYMO_DISABLE_MP_CT}ct - being paid to import beats producing, so clamp the inverter to 0% and let the pack soak up grid energy instead`
                : `${_mpTxt} is at or above ${SYMO_DISABLE_MP_CT}ct - self-consuming PV still beats importing, so hand the inverter back its own control (clears WMaxLim_Ena rather than pinning 100%)`)
    }
};

const msg3 = {
    topic: 'mac/ess/cmd',
    payload: {
        state: _cmdState,
        reason: _cmdReason,
        val: currentSlot.marketPrice,
        sun: weather7.sun7[0].value,
        cerbo: _cerboParams,
        symo: _symoParams,
        slots: output
    }
};

// Record what we just commanded so the next run can check whether the pack
// actually delivered it (see the feed-in delivery guard near the top).
if (!socStale && currentSlot && currentSlot.state === 4) {
    global.set('feedinGuard', {
        commandedAt: Date.now(),
        expectW: Math.max(0, MAX_DISCHARGE_W + (currentSlot.loadEst || 0) - (currentSlot.pvPower || 0))
    });
}

// Persist current schedule into global.pp.prediction (file store) so other
// flows/nodes can read the optimizer's output without subscribing to msgs.
const pp = global.get('pp', 'file') || {};
pp.prediction = output;
global.set('pp', pp, 'file');

node.status(socStale
    ? { fill: 'red', shape: 'ring',
        text: `SOC STALE ${currentSoc.toFixed(1)}% flat ${Math.round(_socFlatMin)}min (${_socSource}) -> state 3` }
    : { fill: 'green', shape: 'dot',
        text: `s${_cmdState} soc=${currentSoc.toFixed(1)}% (${_socSource}) ${currentSlot ? currentSlot.marketPrice.toFixed(1) : '?'}ct` });

return [msg, null, msg3];
