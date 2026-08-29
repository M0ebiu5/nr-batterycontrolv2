// Regression tests for optimizer_func.js
// Each scenario reproduces a specific user-reported bug.
//
// Run: node test_regression.js
// Exit 0 if all pass, 1 otherwise.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'optimizer_func.js'), 'utf8');

// --- Mock node-red node interface ---
// warnLog collects every node.warn line so scenarios can assert on the
// diagnostics the optimizer emits (not just on the resulting schedule).
const warnLog = [];
const node = {
    warn: (...a) => { warnLog.push(a.map(String).join(' ')); if (process.env.OPT_DEBUG) console.log('  [node.warn]', ...a); },
    error: (...a) => console.error('  [node.error]', ...a),
    log: () => {},
    status: () => {}
};

// --- Time mock ---
const realDateNow = Date.now;
function withMockedNow(ms, fn) {
    Date.now = () => ms;
    try { return fn(); }
    finally { Date.now = realDateNow; }
}

// --- Wrap optimizer body so we can call it as a function ---
// `globalStore` seeds global context and captures writes, so scenarios can assert
// on state the optimizer carries between runs (e.g. `feedinGuard`). Omit it and
// global reads return null, as before.
function runOptimizer(msg, globalStore) {
    // The function-node body uses `msg` and `node`, returns `msg` (or array).
    // We wrap as IIFE-style function.
    warnLog.length = 0;
    const store = globalStore || {};
    const fn = new Function('msg', 'node', 'flow', 'global', SRC);
    const flow = { get: () => null, set: () => {} };
    const global = {
        get: (key) => {
            if (key in store) return store[key];
            if (key === 'weather7days') return { sun7: [{ value: 0.5 }] };
            return null;
        },
        set: (key, value) => { store[key] = value; }
    };
    return fn(msg, node, flow, global);
}

const PRESAT_RAW_MAX_REGRET_CT_DOC = (/const PRESAT_RAW_MAX_REGRET_CT = (\d+)/.exec(SRC) || [, '?'])[1];

// --- Scenario builders ---

function buildPriceArray(startMs, slots, priceFn) {
    const out = [];
    for (let i = 0; i < slots; i++) {
        const t = startMs + i * 15 * 60 * 1000;
        out.push({ time: t, marketprice: priceFn(t, i) });
    }
    return out;
}

function buildLoadHistory(refMs) {
    const profile = [
        300, 280, 270, 260, 260, 280,
        350, 500, 700, 800, 750, 700,
        750, 700, 650, 600, 700, 900,
        1100, 1000, 800, 600, 450, 350
    ];
    // Optimizer groups by hour-of-day and takes median across samples with
    // ≥3 samples required per hour. Emit 7 days × 24 hours of data so every
    // hour has enough history to pass the threshold.
    const out = [];
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            out.push({
                time: refMs - (d + 1) * 86400000 + h * 3600000,
                avg_load: profile[h]
            });
        }
    }
    return out;
}

function buildPvHistory(refMs) {
    const out = [];
    // Anchor each historical day at Berlin 00:00, so the loop hour h matches
    // local hour-of-day. (refMs may be any UTC time; we strip to Berlin date.)
    for (let day = 1; day <= 10; day++) {
        const past = new Date(refMs - day * 86400000);
        // Berlin midnight = UTC 22:00 of previous day in CEST (+02:00)
        const dayMidnightUtc = Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), past.getUTCDate(), -2, 0);
        for (let h = 0; h < 24; h++) {
            let pv = 0;
            if (h >= 6 && h <= 19) {
                pv = Math.max(0, 4500 * Math.sin(Math.PI * (h - 6) / 13));
            }
            out.push({
                time: dayMidnightUtc + h * 3600000,
                avg_pv: pv > 100 ? pv : null,
                max_pv: pv > 100 ? pv * 1.2 : null
            });
        }
    }
    return out;
}

function buildSolarForecast(startMs, hours) {
    const out = [];
    for (let h = 0; h < hours; h++) {
        const t = startMs + h * 3600000;
        const hourOfDay = (new Date(t).getUTCHours() + 2) % 24;
        out.push({
            time: t,
            sunshineDurationInMinutes: hourOfDay >= 7 && hourOfDay <= 18 ? 50 : 0
        });
    }
    return out;
}

function fmtSlot(s) {
    const sp = s.acPowerSetPoint || 0;
    return `${s.timeStr || s.time} st=${s.state} sp=${sp} soc=${s.predictedSoc}% mp=${s.marketPrice.toFixed(2)} pv=${s.pvPower}W reason="${s.reason}"`;
}

function getSchedule(result) {
    // Optimizer returns an array of msgs. msg1.payload = schedule.
    if (Array.isArray(result)) return result[0].payload;
    return result.payload;
}

// =========================================================
// SCENARIO 1: User report — 20:15 slot at 15.77 ct,
// SOC ~78%, evening, no PV. With many MORE expensive slots
// above it, the old `> avgPrice` filter would have excluded
// 15.77 from feed-in candidates. After the fix it must feed in.
// =========================================================
function scenario1_eveningSlotBelowAvg() {
    console.log('\n=== SCENARIO 1: User report — 20:15 @ 15.77ct must feed in (SOC headroom) ===');

    // Reproduces user-reported case:
    //   {"time":"09.04., 20:15","state":3,"acPowerSetPoint":-700,"predictedSoc":78.5,
    //    "marketPrice":15.77,"effectivePrice":28.77,"pvPower":0,"loadEst":631,
    //    "reason":"Compensate load, SOC 79% > 49% needed"}
    //
    // The 78.5% is a *predicted* SOC for a future slot — so the schedule is
    // generated much earlier in the day and looks ~36h forward. Build that.

    // "Now" = 2026-04-09 14:00 Berlin → UTC 12:00.
    // Schedule = 36h — reaches into tomorrow evening peak. The rolling-horizon
    // logic must EXCLUDE tomorrow evening from today's competition (it'll be
    // re-planned tomorrow afternoon with real PV data) so today's 15.77 wins.
    const NOW = Date.UTC(2026, 3, 9, 12, 0);
    const startMs = NOW;
    const slots = 144; // 36h

    const prices = buildPriceArray(startMs, slots, (t, i) => {
        const d = new Date(t);
        const hour = ((d.getUTCHours() + 2) % 24 + 24) % 24;
        // Evening peak 18-22: 14-17 ct, with 15.77 in the mix
        if (hour >= 18 && hour < 22) return 14 + Math.random() * 3;
        // Late evening 22-00: 11-13
        if (hour >= 22) return 11 + Math.random() * 2;
        // Night 0-5: 4-6
        if (hour < 5) return 4 + Math.random() * 2;
        // Morning ramp 5-9: 11-14
        if (hour < 9) return 11 + Math.random() * 3;
        // Midday PV trough 9-15: 2-5
        if (hour < 15) return 2 + Math.random() * 3;
        // Afternoon 15-18: 9-12
        return 9 + Math.random() * 3;
    });
    // Find the 20:15 today slot and force to 15.77
    const target2015 = Date.UTC(2026, 3, 9, 18, 15); // Berlin 20:15 = UTC 18:15
    let foundTarget = false;
    for (const p of prices) {
        if (p.time === target2015) {
            p.marketprice = 15.77;
            foundTarget = true;
            break;
        }
    }
    if (!foundTarget) {
        console.error('  setup error: 20:15 slot not in price array');
        return false;
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 85 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 3000 }],
            prices,
            solar: buildSolarForecast(startMs, 36),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 9, 4, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 9, 17, 45)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    // Find the 15.77 slot
    const target = schedule.find(s => Math.abs(s.marketPrice - 15.77) < 0.001);
    if (!target) {
        console.error('  FAIL: 15.77 slot not found in schedule');
        return false;
    }

    // Compute the avgPrice the optimizer saw
    const avgPrice = schedule.reduce((a, s) => a + s.marketPrice, 0) / schedule.length;
    console.log(`  schedule has ${schedule.length} slots, avgPrice=${avgPrice.toFixed(2)}ct`);
    console.log(`  target slot: ${fmtSlot(target)}`);

    if (avgPrice <= 15.77) {
        console.error(`  WARN: test setup avgPrice ${avgPrice.toFixed(2)} <= 15.77 — does not exercise the regression`);
    }

    if (target.state === 4) {
        console.log('  PASS: state=4 (feed-in) at 15.77ct despite being below avgPrice');
        return true;
    } else {
        console.error(`  FAIL: state=${target.state}, expected 4`);
        const idx = schedule.indexOf(target);
        console.error('  context:');
        schedule.slice(Math.max(0, idx - 1), idx + 4).forEach(s => console.error('   ', fmtSlot(s)));
        return false;
    }
}

// =========================================================
// SCENARIO 2: Negative-price midday slot with full battery
// must NOT feed in (state != 4).
// =========================================================
function scenario2_noNegativeFeedIn() {
    console.log('\n=== SCENARIO 2: Negative price + full battery → no feed-in ===');

    // "Now" = 2026-04-09 14:30 Berlin
    const NOW = Date.UTC(2026, 3, 9, 12, 30);
    const startMs = NOW;
    const slots = 96;
    const prices = buildPriceArray(startMs, slots, (t, i) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        // 12:00-16:00 negative (heavy solar)
        if (hour >= 12 && hour < 16) return -0.16;
        if (hour < 6) return 5;
        if (hour >= 18 && hour < 22) return 20;
        return 8;
    });

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 96 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 2522 }],
            prices,
            solar: buildSolarForecast(startMs, 24),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 9, 4, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 9, 17, 45)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const negSlots = schedule.filter(s => s.marketPrice < 0);
    if (negSlots.length === 0) {
        console.error('  FAIL: no negative slots in schedule (test setup broken)');
        return false;
    }
    console.log(`  found ${negSlots.length} negative-price slots`);

    let bad = negSlots.filter(s => s.state === 4);
    if (bad.length === 0) {
        console.log('  PASS: no negative-price slot has state=4');
        negSlots.slice(0, 3).forEach(s => console.log('   ', fmtSlot(s)));
        return true;
    } else {
        console.error(`  FAIL: ${bad.length} negative slot(s) feeding in:`);
        bad.slice(0, 5).forEach(s => console.error('   ', fmtSlot(s)));
        return false;
    }
}

// =========================================================
// SCENARIO 3: Top-priced evening slots should mostly feed in
// when SOC has comfortable headroom and overnight load is small.
// =========================================================
function scenario3_topPricedFeedIn() {
    console.log('\n=== SCENARIO 3: Top-priced slots feed in with SOC headroom ===');

    const NOW = Date.UTC(2026, 3, 9, 15, 0); // 17:00 Berlin
    const startMs = NOW;
    const slots = 32; // 8h, ends ~01:00
    const prices = buildPriceArray(startMs, slots, (t, i) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour >= 17 && hour < 19) return 12;
        if (hour >= 19 && hour < 22) return 20 + (hour - 19) * 2; // 20, 22, 24
        return 8;
    });

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 90 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 1500 }],
            prices,
            solar: buildSolarForecast(startMs, 8),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 9, 4, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 9, 17, 45)).toISOString(),
            solarradiation: 400,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const ranked = [...schedule].sort((a, b) => b.marketPrice - a.marketPrice);
    const top6 = ranked.slice(0, 6);
    const feedIn = top6.filter(s => s.state === 4).length;
    console.log(`  top 6 priced slots, ${feedIn} are state=4`);
    top6.forEach(s => console.log('   ', fmtSlot(s)));

    if (feedIn >= 4) {
        console.log(`  PASS: ${feedIn}/6 high-price slots feeding in`);
        return true;
    } else {
        console.error(`  FAIL: only ${feedIn}/6 top-price slots feeding in`);
        return false;
    }
}

// =========================================================
// SCENARIO 4: User report — SOC 95% at 14:00, predictedSoc
// must NOT collapse to ~50% by 16:30. The optimizer should
// preserve afternoon SOC for evening peak feed-in, not drain
// it via runaway feedin_capacity / mid-day plans.
// =========================================================
function scenario4_preserveAfternoonSoc() {
    console.log('\n=== SCENARIO 4: SOC 95% at start, must stay high through afternoon ===');

    const NOW = Date.UTC(2026, 3, 9, 12, 0); // 14:00 Berlin
    const startMs = NOW;
    const slots = 144; // 36h forward

    // Realistic price profile: afternoon trough, evening peak, night low, morning peak
    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour >= 18 && hour < 22) return 18 + Math.random() * 6; // 18-24
        if (hour >= 22) return 10 + Math.random() * 2;
        if (hour < 5) return 4 + Math.random() * 2;
        if (hour < 9) return 12 + Math.random() * 4;
        if (hour < 15) return 5 + Math.random() * 3; // mid-day trough (incl 14-15)
        if (hour < 16) return 6 + Math.random() * 2; // 15:xx
        if (hour < 17) return 7 + Math.random() * 2; // 16:xx (target slot 16:30)
        return 9 + Math.random() * 3;
    });

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 95 }],
            acload: [{ time: NOW, acload: 1088 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 2500 }],
            prices,
            solar: buildSolarForecast(startMs, 36),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 9, 4, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 9, 17, 45)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    // Find the 16:30 slot today (output entries have `time` as formatted string)
    const targetIdx = schedule.findIndex(s => typeof s.time === 'string' && s.time.includes('09.04.') && s.time.includes('16:30'));
    if (targetIdx < 0) {
        console.error('  setup error: 16:30 slot not in schedule');
        console.error('  first 3 slot times:', schedule.slice(0, 3).map(s => s.time));
        return false;
    }
    const target = schedule[targetIdx];

    console.log(`  current SOC=95%, target slot: ${fmtSlot(target)}`);

    // Count feed-in slots BEFORE 16:30 (the cause of premature drain)
    const beforeTarget = schedule.slice(0, targetIdx);
    const earlyFeedIns = beforeTarget.filter(s => s.state === 4);
    console.log(`  ${beforeTarget.length} slots before 16:30, ${earlyFeedIns.length} feeding in`);
    if (earlyFeedIns.length > 0) {
        earlyFeedIns.forEach(s => console.log('   ', fmtSlot(s)));
    }

    // SOC at 16:30 should remain reasonably high (>= 85%) since it's still
    // afternoon with PV and the high-priced evening peak hasn't started.
    if (target.predictedSoc >= 85) {
        console.log(`  PASS: SOC at 16:30 = ${target.predictedSoc}% (>= 85%)`);
        return true;
    } else {
        console.error(`  FAIL: SOC at 16:30 = ${target.predictedSoc}% (expected >= 85%)`);
        return false;
    }
}

// =========================================================
// SCENARIO 5: User report — forecast predicts 0 solar radiation
// today, but optimizer predicted ~2837W PV for the 09:00 slot.
// Root cause: historical baseline selection falls back to ALL
// days (sunny) when <3 match, then estimatePvPower returns raw
// sunny baseline when PAC=0 AND solarradiation=0.
// =========================================================
function scenario5_cloudyForecastHonored() {
    console.log('\n=== SCENARIO 5: Cloudy forecast (0 sunshine) → predicted PV ~0 ===');

    const NOW = Date.UTC(2026, 3, 10, 5, 0); // 07:00 Berlin, before 09:00 target slot
    const startMs = NOW;
    const slots = 64; // 16h

    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour >= 18 && hour < 22) return 20;
        if (hour < 6) return 5;
        return 12;
    });

    // Sunshine forecast: ZERO minutes all day (fully overcast)
    const solar = [];
    for (let h = 0; h < 16; h++) {
        solar.push({
            time: startMs + h * 3600000,
            sunshineDurationInMinutes: 0
        });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 60 }],
            acload: [{ time: NOW, acload: 590 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 0 }],     // inverter producing 0
            prices,
            solar,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)         // historical sunny days
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 10, 4, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 10, 17, 45)).toISOString(),
            solarradiation: 0,                       // weather station: 0 W/m²
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    // Look at all daytime slots (08-18 Berlin local). No slot should claim
    // strong PV when the forecast says 0 sunshine and PAC is 0.
    const daytime = schedule.filter(s => {
        const hour = ((new Date(s.time).getUTCHours() + 2) % 24 + 24) % 24;
        return hour >= 8 && hour < 18;
    });
    const maxPv = Math.max(0, ...daytime.map(s => s.pvPower));
    console.log(`  ${daytime.length} daytime slots, max predicted pvPower=${maxPv}W`);

    // Also specifically check the 09:00 slot (user's report).
    const nineSlot = schedule.find(s => typeof s.time === 'string' && s.time.includes('09:00'));
    if (nineSlot) {
        console.log(`  09:00 slot: ${fmtSlot(nineSlot)}`);
    }

    if (maxPv <= 500) {
        console.log(`  PASS: predicted PV stays near zero (max ${maxPv}W <= 500W)`);
        return true;
    } else {
        console.error(`  FAIL: max predicted PV ${maxPv}W > 500W despite 0 forecast sunshine`);
        daytime.filter(s => s.pvPower > 500).slice(0, 5).forEach(s => console.error('   ', fmtSlot(s)));
        return false;
    }
}

// =========================================================
// SCENARIO 6: User report — last slot at 14.04 23:45 predicted
// SOC = 8.4% with bad next-day PV forecast. Root cause: the old
// _postSchedLoadKwh computed the overnight gap via a broken
// "sunrise + 24h" heuristic that returned 0 whenever the schedule
// extended past the next sunrise. With no reserve, socNeeded at
// the last slot was just MIN_SOC+5 = 8%, so the optimizer happily
// drained the battery to the floor.
// Fix: walk 24h forward from lastSlotEnd using forecast-weighted
// net load. Bad forecast → reserve climbs → Phase 3 charges more.
// =========================================================
function scenario6_endOfScheduleReserveBadForecast() {
    console.log('\n=== SCENARIO 6: Schedule past next sunrise + bad forecast → reserve SOC ===');

    // "Now" = 2026-04-13 15:00 Berlin (UTC 13:00). Day-ahead prices for
    // 14.04 already published, so schedule extends to 14.04 23:45 Berlin.
    const NOW = Date.UTC(2026, 3, 13, 13, 0);
    const startMs = NOW;
    const slots = 132; // 33h → 15:00 today to 14.04 23:45 Berlin

    // Realistic price profile with some cheap slots available for charging
    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour >= 18 && hour < 22) return 22 + Math.random() * 4; // evening peak
        if (hour >= 22) return 12 + Math.random() * 2;
        if (hour < 5) return 6 + Math.random() * 2; // overnight trough
        if (hour < 9) return 14 + Math.random() * 3; // morning ramp
        if (hour < 15) return 10 + Math.random() * 3; // midday (no PV trough because cloudy)
        return 13 + Math.random() * 3;
    });

    // BAD forecast: almost no sunshine at all — simulating cloudy/rainy day
    // both today and tomorrow. 36h of forecast covered.
    const solar = [];
    for (let h = 0; h < 36; h++) {
        solar.push({
            time: startMs + h * 3600000,
            sunshineDurationInMinutes: 3 // ~5% of clear-sky
        });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 30 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 150 }], // cloudy → low PAC
            prices,
            solar,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 13, 4, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 13, 18, 0)).toISOString(),
            solarradiation: 50,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const lastSlot = schedule[schedule.length - 1];
    console.log(`  last slot: ${fmtSlot(lastSlot)}`);

    // Extract socNeeded from the reason string
    const m = /> (\d+)% needed/.exec(lastSlot.reason);
    const socNeeded = m ? parseInt(m[1]) : null;
    if (socNeeded !== null) console.log(`  last slot socNeeded = ${socNeeded}%`);

    // Acceptance: with a bad-forecast reserve the floor should be
    // meaningfully above the old bug's MIN_SOC+5 = 8%, but not absurd.
    // The reserve covers the blind window until next-day prices publish
    // (~14h × ~700W × mostly-no-PV → ~9.8 kWh → capped at 6 kWh = 20%,
    // then +MIN_SOC(3)+5 = ~28%).
    let ok = true;
    if (socNeeded === null || socNeeded < 20) {
        console.error(`  FAIL: socNeeded ${socNeeded}% < 20% (reserve not honoring bad forecast)`);
        ok = false;
    }
    if (socNeeded !== null && socNeeded > 35) {
        console.error(`  FAIL: socNeeded ${socNeeded}% > 35% (reserve too aggressive)`);
        ok = false;
    }
    if (lastSlot.predictedSoc < 15) {
        console.error(`  FAIL: last slot SOC ${lastSlot.predictedSoc}% too low (draining to floor)`);
        ok = false;
    }
    if (lastSlot.predictedSoc > 40) {
        console.error(`  FAIL: last slot SOC ${lastSlot.predictedSoc}% > 40% (over-reserving)`);
        ok = false;
    }

    if (ok) {
        console.log(`  PASS: socNeeded=${socNeeded}%, endSOC=${lastSlot.predictedSoc}%`);
        return true;
    }
    return false;
}

// =========================================================
// SCENARIO 7: User report 2026-04-23 — preemptive picked
// 04:15-05:00 (mp ~0.5ct) instead of 08:00-08:15 morning peak
// (mp 6.7-7.3ct). Root cause: original eligibility window was
// "night + early morning before PV>=load", which broke right
// at the morning price peak. Fix: window = now → next-day
// sunrise; price-DESC sort then picks the genuine top slots.
// =========================================================
function scenario7_preemptivePicksMorningPeak() {
    console.log('\n=== SCENARIO 7: Preemptive picks morning peak, not low-price night ===');

    // "Now" = 2026-04-23 03:00 Berlin (UTC 01:00) — pre-dawn.
    // Schedule = 36h, so it includes both today's full day and tomorrow's
    // daylight (the solar-glut day that triggers preemptive).
    const NOW = Date.UTC(2026, 3, 23, 1, 0);
    const startMs = NOW;
    const slots = 144;

    const prices = buildPriceArray(startMs, slots, (t) => {
        const d = new Date(t);
        const dayOffset = Math.floor((d.getTime() - NOW) / 86400000);
        const hour = ((d.getUTCHours() + 2) % 24 + 24) % 24;
        // Today (dayOffset 0): real shape from user's report
        if (dayOffset === 0) {
            if (hour < 6) return 0.3 + Math.random() * 0.3;       // night ~0.3-0.6 ct
            if (hour < 8) return 0.5 + (hour - 6) * 1.5;          // ramp 0.5 → 3.5
            if (hour === 8) return 7.0;                            // morning peak
            if (hour < 10) return 4 + Math.random() * 2;
            if (hour < 18) return 0.3 + Math.random() * 1.5;      // mid-day trough
            if (hour < 22) return 5 + Math.random() * 2;          // evening peak ~5-7
            return 1.5 + Math.random();
        }
        // Tomorrow (dayOffset 1): solar-glut day — many <3ct daylight slots
        if (hour >= 6 && hour < 18) return 0.5 + Math.random() * 2; // 0.5-2.5
        if (hour >= 18 && hour < 22) return 5 + Math.random() * 3;
        return 2 + Math.random() * 2;
    });

    // Force the morning peak slots so the assertion is unambiguous
    const force = (hUtc, mUtc, mp) => {
        const t = Date.UTC(2026, 3, 23, hUtc, mUtc);
        const p = prices.find(x => x.time === t);
        if (p) p.marketprice = mp;
    };
    force(6, 0, 6.7); // Berlin 08:00
    force(6, 15, 7.3); // Berlin 08:15

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 55 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 0 }],
            prices,
            solar: buildSolarForecast(startMs, 36),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 23, 3, 30)).toISOString(), // ~05:30 Berlin
            sunSet: new Date(Date.UTC(2026, 3, 23, 18, 0)).toISOString(),
            solarradiation: 0,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const mp0800 = schedule.find(s => typeof s.time === 'string' && s.time.includes('23.04.') && s.time.includes('08:00'));
    const mp0815 = schedule.find(s => typeof s.time === 'string' && s.time.includes('23.04.') && s.time.includes('08:15'));
    const mp0415 = schedule.find(s => typeof s.time === 'string' && s.time.includes('23.04.') && s.time.includes('04:15'));
    const mp0445 = schedule.find(s => typeof s.time === 'string' && s.time.includes('23.04.') && s.time.includes('04:45'));

    if (!mp0800 || !mp0815 || !mp0415) {
        console.error('  setup error: target slots not found');
        console.error('  first 6 times:', schedule.slice(0, 6).map(s => s.time));
        return false;
    }

    console.log(`  04:15 (low):  ${fmtSlot(mp0415)}`);
    if (mp0445) console.log(`  04:45 (low):  ${fmtSlot(mp0445)}`);
    console.log(`  08:00 (peak): ${fmtSlot(mp0800)}`);
    console.log(`  08:15 (peak): ${fmtSlot(mp0815)}`);

    let ok = true;
    if (mp0815.state !== 4) {
        console.error(`  FAIL: 08:15 (mp ${mp0815.marketPrice}ct) should be state=4, got ${mp0815.state}`);
        ok = false;
    }
    if (mp0800.state !== 4) {
        console.error(`  FAIL: 08:00 (mp ${mp0800.marketPrice}ct) should be state=4, got ${mp0800.state}`);
        ok = false;
    }
    // The big symptom: low-price 04:15-05:00 slots draining at <1ct.
    // After the fix, those slots should NOT be feeding in (their price
    // is way below the morning peak alternatives within the same window).
    if (mp0415.state === 4) {
        console.error(`  FAIL: 04:15 (mp ${mp0415.marketPrice}ct) is state=4 — still picking low-price night slots`);
        ok = false;
    }

    if (ok) {
        console.log('  PASS: morning peak picked, low-price night skipped');
        return true;
    }
    return false;
}

// =========================================================
// SCENARIO 8: User report 2026-04-23 — at 07:00 (current
// daylight, tomorrow's prices not yet published), the new
// preemptive logic stopped triggering at all. Result: no
// feed-in plan for the morning peak that's still ahead.
// Root cause: original "find night→day transition" loop
// returned -1 when current is already daylight and the
// schedule doesn't extend past tonight. Fix: identify the
// CURRENT or next daylight period as the glut day.
// =========================================================
function scenario8_preemptivePostSunriseNoTomorrow() {
    console.log('\n=== SCENARIO 8: Preemptive runs post-sunrise even without tomorrow data ===');

    // "Now" = 2026-04-23 07:00 Berlin (UTC 05:00). Current slot is
    // already daylight; schedule ends today at 23:45 (tomorrow's prices
    // arrive at 13:00).
    const NOW = Date.UTC(2026, 3, 23, 5, 0);
    const startMs = NOW;
    const slots = 68; // 07:00 → 23:45

    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour === 8) return 7.0;                          // morning peak
        if (hour < 9) return 1 + (hour - 7) * 2;             // 07-08 ramp
        if (hour < 18) return 0.3 + Math.random() * 1.5;    // mid-day trough
        if (hour < 22) return 5 + Math.random() * 2;        // evening peak
        return 1.5 + Math.random();
    });
    const force = (hUtc, mUtc, mp) => {
        const t = Date.UTC(2026, 3, 23, hUtc, mUtc);
        const p = prices.find(x => x.time === t);
        if (p) p.marketprice = mp;
    };
    force(6, 0, 6.7); // Berlin 08:00
    force(6, 15, 7.3); // Berlin 08:15

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 47 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 800 }], // PV ramping up
            prices,
            solar: buildSolarForecast(startMs, 17),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 3, 23, 3, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 3, 23, 18, 0)).toISOString(),
            solarradiation: 200,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const mp0800 = schedule.find(s => typeof s.time === 'string' && s.time.includes('23.04.') && s.time.includes('08:00'));
    const mp0815 = schedule.find(s => typeof s.time === 'string' && s.time.includes('23.04.') && s.time.includes('08:15'));

    if (!mp0800 || !mp0815) {
        console.error('  setup error: morning-peak slots not found');
        console.error('  first 6 times:', schedule.slice(0, 6).map(s => s.time));
        return false;
    }

    console.log(`  08:00 (peak): ${fmtSlot(mp0800)}`);
    console.log(`  08:15 (peak): ${fmtSlot(mp0815)}`);

    let ok = true;
    if (mp0800.state !== 4) {
        console.error(`  FAIL: 08:00 (mp ${mp0800.marketPrice}ct) should be state=4, got ${mp0800.state}`);
        ok = false;
    }
    if (mp0815.state !== 4) {
        console.error(`  FAIL: 08:15 (mp ${mp0815.marketPrice}ct) should be state=4, got ${mp0815.state}`);
        ok = false;
    }

    if (ok) {
        console.log('  PASS: morning peak feeds in even when current is daylight & no tomorrow data');
        return true;
    }
    return false;
}

// =========================================================
// SCENARIO 9: User report 2026-05-06 — at 16:00, optimizer
// fed-in at mp=9.06ct (state=4 via runtime "battery full +
// PV surplus" branch) even though 17:45 in the same saturation
// cluster had mp=14.45ct AND replacement cost (weak PV
// tomorrow) was ~22ct/kWh — so EVERY slot in the cluster
// was a round-trip loser. Right answer: don't feed in at all,
// preserve SOC for tomorrow's load. Fix: runtime "battery
// full" branch now requires mp>replacementPrice OR soc≥99
// (genuine curtailment).
// =========================================================
function scenario9_saturationClusterRoundTrip() {
    console.log('\n=== SCENARIO 9: Saturation cluster mid-day must respect round-trip economics ===');

    // NOW = today 16:00 Berlin (UTC 14:00). currentSoc=95% (right at the
    // saturation threshold the buggy branch was triggering on). PV moderate
    // (1700W) so soc creeps up but never reaches 99% (true curtailment).
    // Tomorrow's PV is weak so replacement cost stays ~22ct; mp at 16:00
    // is 9.06ct → round-trip loss → MUST hold (state=3), not fire.
    const NOW = Date.UTC(2026, 4, 6, 14, 0);
    const startMs = NOW;
    const slots = 32; // 16:00 today → 23:45 today (today-only horizon for clarity)

    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour === 16) return 9.06;             // <-- local-min, the bug's trigger
        if (hour < 18) return 10.5 + (hour - 16) * 0.5;
        if (hour < 21) return 14 + (hour - 18) * 1; // climbing evening peak
        return 12;
    });

    // Solar: moderate (~1700W peak this afternoon, fading), zero overnight.
    const solar = [];
    for (let h = 0; h < 9; h++) {
        const t = startMs + h * 3600000;
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        solar.push({ time: t, sunshineDurationInMinutes: hour >= 16 && hour <= 18 ? 18 : 0 });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 95 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 1700 }],
            prices,
            solar,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 4, 6, 3, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 4, 6, 18, 30)).toISOString(),
            solarradiation: 200,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const slot1600 = schedule.find(s => typeof s.time === 'string' && s.time.includes('06.05.') && s.time.includes('16:00'));
    if (!slot1600) {
        console.error('  setup error: 16:00 slot not found');
        return false;
    }
    console.log(`  16:00: ${fmtSlot(slot1600)}`);

    if (slot1600.state === 4) {
        console.error('  FAIL: 16:00 fired state=4 despite round-trip loss (mp=9.06 < replacement, soc<99)');
        return false;
    }
    if (slot1600.predictedSoc >= 99) {
        // Setup drift — if SOC ran up to 99 at 16:00, the curtailment branch
        // is the right call and the test has lost its meaning.
        console.error(`  setup drift: 16:00 soc=${slot1600.predictedSoc}% — curtailment fired, not the bug we want to test`);
        return false;
    }
    console.log('  PASS: 16:00 holds (no feed-in at sub-replacement mp without curtailment)');
    return true;
}

// =========================================================
// SCENARIO 10: User report — heavy feed-in tonight at a low
// peak (≤17ct) while tomorrow's 46ct peak is skipped. Today's
// SOC is sold down at 14-17ct because a single cheap PV slot
// tomorrow flips `freeRefillAhead` true (loose existence test),
// but tomorrow is cloudy so PV can't actually refill. The
// cross-day hold must block tonight's sub-peak feed-in.
// =========================================================
function scenario10_crossDayHold() {
    console.log('\n=== SCENARIO 10: Cross-day hold — don\'t sell tonight @17ct vs tomorrow @46ct ===');

    const NOW = Date.UTC(2026, 5, 17, 9, 0); // 2026-06-17 11:00 Berlin
    const startMs = NOW;
    const slots = 144; // 36h → reaches tomorrow evening peak

    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;
    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW)) / 86400000);

    const prices = buildPriceArray(startMs, slots, (t) => {
        const h = berlinHour(t), day = dayOffset(t);
        if (day === 0) {                       // today
            if (h >= 18 && h < 22) return 16;  // today evening peak ~16-17ct
            if (h >= 22) return 11;
            return 8;                          // today daytime/afternoon
        }
        if (h >= 9 && h < 15) return 1.5;      // tomorrow cheap PV midday → freeRefillAhead
        if (h >= 19 && h < 22) return 44;      // tomorrow evening BIG peak
        if (h < 5) return 9;
        return 12;
    });
    const today2000 = Date.UTC(2026, 5, 17, 18, 0); // Berlin 20:00 today
    const tom2000   = Date.UTC(2026, 5, 18, 18, 0); // Berlin 20:00 tomorrow
    for (const p of prices) {
        if (p.time === today2000) p.marketprice = 17;
        if (p.time === tom2000)   p.marketprice = 46;
    }

    // Weak/cloudy PV baseline (~1800W peak): midday pv>load (so the cheap slot
    // counts as PV-surplus) but total surplus never curtails the battery.
    const pvHistory = [];
    for (let day = 1; day <= 10; day++) {
        const past = new Date(NOW - day * 86400000);
        const dayMidnightUtc = Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), past.getUTCDate(), -2, 0);
        for (let h = 0; h < 24; h++) {
            let pv = 0;
            if (h >= 7 && h <= 18) pv = Math.max(0, 1800 * Math.sin(Math.PI * (h - 7) / 11));
            pvHistory.push({ time: dayMidnightUtc + h * 3600000, avg_pv: pv > 100 ? pv : null, max_pv: pv > 100 ? pv * 1.2 : null });
        }
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 70 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 1500 }],
            prices,
            solar: buildSolarForecast(startMs, 36),
            load_history: buildLoadHistory(NOW),
            pv_history: pvHistory
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 5, 17, 3, 0)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 5, 17, 19, 30)).toISOString(),
            solarradiation: 250,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    // schedule slot .time is a formatted Berlin string "DD.MM., HH:MM".
    const parseT = (s) => {
        const m = String(s.time).match(/(\d{2})\.(\d{2})\.,?\s+(\d{2}):(\d{2})/);
        return m ? { dd: +m[1], mm: +m[2], hh: +m[3] } : null;
    };
    const isToday = (s) => { const p = parseT(s); return p && p.dd === 17 && p.mm === 6; };
    const isTomorrow = (s) => { const p = parseT(s); return p && p.dd === 18 && p.mm === 6; };

    const futurePeak = Math.max(0, ...schedule.filter(isTomorrow).map(s => s.marketPrice));
    const tonightFeedins = schedule.filter(s => s.state === 4 && isToday(s) && parseT(s).hh >= 18);
    const target = schedule.find(s => isToday(s) && parseT(s).hh === 20 && Math.abs(s.marketPrice - 17) < 0.5);

    console.log(`  tomorrow peak mp=${futurePeak.toFixed(1)}ct; tonight evening feed-in slots: ${tonightFeedins.length}`);
    if (target) console.log(`  target (17ct today 20:00): ${fmtSlot(target)}`);
    if (futurePeak < 40) { console.error(`  setup error: tomorrow peak ${futurePeak}ct not in schedule`); return false; }

    // The plan must NOT feed in tonight's sub-peak energy: those slots (≤17ct)
    // are worth far more held for tomorrow's 46ct peak that weak PV can't refill.
    if (tonightFeedins.length === 0) {
        console.log('  PASS: no tonight feed-in below tomorrow\'s peak (energy held)');
        return true;
    }
    console.error(`  FAIL: ${tonightFeedins.length} tonight slot(s) fed in at ≤17ct despite 46ct peak tomorrow`);
    tonightFeedins.slice(0, 5).forEach(s => console.error('   ', fmtSlot(s)));
    return false;
}

// =========================================================
// SCENARIO 11: Arbitrage grid-charge fires on exceptional delta.
// Evening peak today = 60ct, cheap pre-peak slots ~5ct (eff ~18ct),
// tomorrow sunny (free PV refill). NET = 60*0.9 - 18 - 1.5 = 34.5ct
// >> 16ct hurdle → Phase 3b-arb must grid-charge cheap slots
// (state=1) before the peak and feed in (state=4) at the 60ct peak.
// =========================================================
function scenario11_arbitrageFiresOnBigDelta() {
    console.log('\n=== SCENARIO 11: Arbitrage charge fires on exceptional delta (60ct peak) ===');

    const NOW = Date.UTC(2026, 5, 17, 17, 0); // 2026-06-17 19:00 Berlin (PV winding down)
    const startMs = NOW;
    const slots = 144; // 36h → reaches tomorrow's free PV refill

    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW)) / 86400000);
    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;

    const prices = buildPriceArray(startMs, slots, (t) => {
        const h = berlinHour(t), day = dayOffset(t);
        if (day === 0) { // today
            if (h === 21) return 60;          // exceptional evening peak
            if (h >= 19 && h < 21) return 5;  // cheap pre-peak charge window
            if (h >= 22) return 10;
            return 8;
        }
        // tomorrow: sunny → cheap midday (free PV refill), normal evening
        if (h >= 9 && h < 15) return 2;
        if (h >= 19 && h < 22) return 22;
        return 9;
    });

    // Strong-sun 48h forecast so the multi-day reserve is non-binding: the
    // energy sold at tonight's peak is refilled by tomorrow's free PV, which
    // is exactly the round-trip the arbitrage phase relies on. (A weak/default
    // forecast would push the reserve floor above the post-charge SOC and the
    // peak would be held instead of sold — that path is covered elsewhere.)
    const solarStrong = [];
    for (let h = 0; h < 48; h++) {
        const t = startMs + h * 3600000;
        const hod = (new Date(t).getUTCHours() + 2) % 24;
        solarStrong.push({ time: t, sunshineDurationInMinutes: hod >= 6 && hod <= 19 ? 60 : 0 });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 50 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 0 }],
            prices,
            solar: solarStrong,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 5, 17, 3, 0)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 5, 17, 19, 45)).toISOString(),
            solarradiation: 0,
            rainrate: 0
        }
    };

    const warns = [];
    const origWarn = node.warn;
    node.warn = (...a) => { warns.push(a.join(' ')); };
    let result;
    try {
        result = withMockedNow(NOW, () => runOptimizer(msg));
    } finally {
        node.warn = origWarn;
    }
    const schedule = getSchedule(result);

    const arbWarn = warns.find(w => w.includes('Phase 3b-arb'));
    console.log(`   arbWarn: ${arbWarn || '(none)'}`);

    const parseT = (s) => {
        const m = String(s.time).match(/(\d{2})\.(\d{2})\.,?\s+(\d{2}):(\d{2})/);
        if (!m) return null;
        return Date.UTC(2026, parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[3]) - 2, parseInt(m[4]));
    };
    const peakIdx = bDay(NOW); // today
    const todayChargesBeforePeak = schedule.filter(s => {
        const tt = parseT(s); if (tt === null) return false;
        return dayOffset(tt) === 0 && berlinHour(tt) >= 19 && berlinHour(tt) < 21 && s.state === 1;
    });
    const peakFeedins = schedule.filter(s => {
        const tt = parseT(s); if (tt === null) return false;
        return dayOffset(tt) === 0 && berlinHour(tt) === 21 && s.state === 4;
    });

    console.log(`   pre-peak charge slots (state=1): ${todayChargesBeforePeak.length}`);
    todayChargesBeforePeak.slice(0, 4).forEach(s => console.log('     ', fmtSlot(s)));
    console.log(`   peak feed-in slots (state=4): ${peakFeedins.length}`);
    peakFeedins.slice(0, 4).forEach(s => console.log('     ', fmtSlot(s)));

    let ok = true;
    if (!arbWarn) { console.error('   FAIL: no Phase 3b-arb warn (arbitrage did not fire)'); ok = false; }
    if (todayChargesBeforePeak.length === 0) { console.error('   FAIL: no state=1 grid-charge slots before the peak'); ok = false; }
    if (peakFeedins.length === 0) { console.error('   FAIL: no state=4 feed-in at the 60ct peak'); ok = false; }

    if (ok) {
        console.log(`   PASS: arbitrage charged ${todayChargesBeforePeak.length} cheap slot(s), fed in at peak`);
        return true;
    }
    return false;
}

// =========================================================
// SCENARIO 12 (negative): normal delta → NO arbitrage.
// Peak 20ct, charge 7ct (eff 20ct). NET = 20*0.9 - 20 - 1.5
// = -3.5ct, far below the 16ct hurdle → Phase 3b-arb must NOT
// fire (no warn, no grid-charge purely to resell).
// =========================================================
function scenario12_noArbitrageOnNormalDelta() {
    console.log('\n=== SCENARIO 12: Normal delta (20ct peak) → no arbitrage charge ===');

    const NOW = Date.UTC(2026, 5, 17, 17, 0); // 2026-06-17 19:00 Berlin
    const startMs = NOW;
    const slots = 144;

    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW)) / 86400000);
    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;

    const prices = buildPriceArray(startMs, slots, (t) => {
        const h = berlinHour(t), day = dayOffset(t);
        if (day === 0) {
            if (h === 21) return 20;          // ordinary evening peak
            if (h >= 19 && h < 21) return 7;  // cheap-ish pre-peak slots
            if (h >= 22) return 10;
            return 8;
        }
        if (h >= 9 && h < 15) return 2;
        if (h >= 19 && h < 22) return 18;
        return 9;
    });

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 50 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 0 }],
            prices,
            solar: buildSolarForecast(startMs, 36),
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 5, 17, 3, 0)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 5, 17, 19, 45)).toISOString(),
            solarradiation: 0,
            rainrate: 0
        }
    };

    const warns = [];
    const origWarn = node.warn;
    node.warn = (...a) => { warns.push(a.join(' ')); };
    let result;
    try {
        result = withMockedNow(NOW, () => runOptimizer(msg));
    } finally {
        node.warn = origWarn;
    }
    getSchedule(result);

    const arbWarn = warns.find(w => w.includes('Phase 3b-arb'));
    if (arbWarn) {
        console.error(`   FAIL: arbitrage fired on normal delta — ${arbWarn}`);
        return false;
    }
    console.log('   PASS: no arbitrage on normal delta (net spread below 16ct hurdle)');
    return true;
}

// =========================================================
// SCENARIO 13: Sun-poor tomorrow → hold stored energy, do
// not feed in below full. Today is sunny (surplus + a 40ct
// evening peak that clears the round-trip hurdle vs an 8ct
// rebuy), but tomorrow has ZERO PV. The user rule must block
// every stored-energy feed-in: no state=4 slot may sit below
// full (SOC<99 / cell<full), and the override must actually
// fire (hold reason present).
// =========================================================
function scenario13_holdWhenTomorrowSunPoor() {
    console.log('\n=== SCENARIO 13: Sun-poor tomorrow → hold, no feed-in below full ===');

    const NOW = Date.UTC(2026, 5, 20, 7, 0); // 09:00 Berlin, June 20
    const startMs = NOW;
    const slots = 140; // ~35h → includes tomorrow's full daylight

    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW)) / 86400000);
    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;

    const prices = buildPriceArray(startMs, slots, (t) => {
        const h = berlinHour(t), day = dayOffset(t);
        if (day === 0) {
            if (h >= 19 && h < 21) return 40;   // today's evening peak (clears hurdle)
            if (h >= 10 && h < 15) return 5;    // cheap midday
            return 12;
        }
        if (h >= 9 && h < 16) return 8;         // tomorrow: cheap daytime (rebuy)
        return 14;
    });

    // Solar: today sunny (daytime 55 min), tomorrow+ ZERO → sun-poor tomorrow.
    const solar = [];
    for (let h = 0; h < 40; h++) {
        const t = startMs + h * 3600000;
        const hod = berlinHour(t), day = dayOffset(t);
        solar.push({ time: t, sunshineDurationInMinutes: (day === 0 && hod >= 7 && hod <= 18) ? 55 : 0 });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 90 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 3000 }],   // sunny today
            prices,
            solar,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 5, 20, 2, 30)).toISOString(),  // 04:30 Berlin
            sunSet: new Date(Date.UTC(2026, 5, 20, 15, 45)).toISOString(),  // 17:45 Berlin
            solarradiation: 700,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    // A "bad" feed-in = selling with no live PV surplus → that's stored energy.
    // Genuine overflow (pv > load on a full battery) is still allowed.
    const storedFeedIn = schedule.filter(s => s.state === 4 && (s.pvPower || 0) <= s.loadEst);
    const holds = schedule.filter(s => (s.reason || '').includes('sun-poor'));
    const peak = schedule.filter(s => s.marketPrice >= 40);
    console.log(`  stored-energy feed-in slots: ${storedFeedIn.length}, hold-for-sun-poor slots: ${holds.length}`);
    peak.slice(0, 3).forEach(s => console.log('   peak', fmtSlot(s)));

    if (storedFeedIn.length > 0) {
        console.error(`  FAIL: ${storedFeedIn.length} stored-energy feed-in slots on a sun-poor-tomorrow day`);
        storedFeedIn.slice(0, 4).forEach(s => console.error('   ', fmtSlot(s)));
        return false;
    }
    if (holds.length === 0) {
        console.error('  FAIL: hold-for-sun-poor override never fired (expected it to block a feed-in)');
        return false;
    }
    console.log(`  PASS: no stored-energy feed-in; override held ${holds.length} slot(s) for the sunless day`);
    return true;
}

// =========================================================
// SCENARIO 14: User report (2026-08-06) — SOC nearly full in
// the morning at a good price, strong PV ahead. The projection
// saturates around midday, so the surplus that arrives after
// saturation gets dumped by Phase 4's runtime "battery full"
// branch at whatever the midday price happens to be (~9ct).
// Phase 3d used to spend the whole overflow budget purely by
// price, so the evening peak (25ct) outbid the morning and the
// morning slots were left idle — the same kWh then left the
// house hours later at the cheap midday price.
// The pre-saturation pass must claim the morning slots: draining
// before saturation creates headroom the PV refills for free.
// =========================================================
function scenario14_preSaturationMorningFeedIn() {
    console.log('\n=== SCENARIO 14: Pre-saturation morning feed-in (headroom before curtailment) ===');

    // NOW = 2026-08-06 08:00 Berlin (UTC 06:00). Today-only prices, as is
    // reality before ~13:00 when tomorrow's prices publish.
    const NOW = Date.UTC(2026, 7, 6, 6, 0);
    const startMs = NOW;
    const slots = 64; // 08:00 → 23:45 today

    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        if (hour < 10) return 18;      // good morning window (pre-saturation)
        if (hour < 19) return 9;       // cheap through the whole PV day — the
                                       // price the runtime dump would fetch
        return 25;                     // post-sunset peak: outbids the morning
                                       // under a purely price-ranked pass
    });

    // Strong sun today AND tomorrow: today's PV saturates the battery around
    // midday, tomorrow's keeps the cross-day/sun-poor holds out of the way.
    const solar = [];
    for (let h = 0; h < 40; h++) {
        const t = startMs + h * 3600000;
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        solar.push({ time: t, sunshineDurationInMinutes: hour >= 7 && hour <= 19 ? 20 : 0 });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 90 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 1500 }],
            prices,
            solar,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 7, 6, 3, 30)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 7, 6, 18, 45)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);
    const presatWarn = warnLog.find(w => w.includes('Phase 3d pre-saturation'));

    const isToday = s => typeof s.time === 'string' && s.time.includes('06.08.');
    const hourOf = s => parseInt(String(s.time).slice(-5, -3), 10);
    const morning = schedule.filter(s => isToday(s) && hourOf(s) < 10);
    const maxSoc = Math.max(...schedule.map(s => s.predictedSoc));

    for (const s of morning) console.log(`  ${fmtSlot(s)}`);
    if (presatWarn) console.log(`  [warn] ${presatWarn}`);

    // Sanity: the day must still be PV-rich enough to fill the battery. (We
    // can't assert on ≥99% slots in the *planned* schedule — a working
    // pre-saturation pass drains exactly enough to keep SOC under the
    // curtailment line, which is the whole point.)
    if (maxSoc < 95) {
        console.error(`  setup drift: peak projected SOC only ${maxSoc.toFixed(1)}% — PV assumptions changed, no saturation to relieve`);
        return false;
    }

    const morningFeedIn = morning.filter(s => s.state === 4);
    const socStart = morning[0].predictedSoc;
    const socEnd = morning[morning.length - 1].predictedSoc;

    // Before the fix the greedy pass spent the budget on the 25ct evening and
    // left the morning mostly idle: SOC climbed 90.9% -> 93.8% and only the
    // reactive "battery full" branch sold anything.
    if (morningFeedIn.length < morning.length - 2) {
        console.error(`  FAIL: only ${morningFeedIn.length}/${morning.length} morning slots feed in at 18ct; ` +
            `the rest of the overflow will dump at the 9ct midday price`);
        return false;
    }
    if (socEnd >= socStart) {
        console.error(`  FAIL: morning SOC rose ${socStart.toFixed(1)}% -> ${socEnd.toFixed(1)}% — ` +
            `no headroom created ahead of saturation`);
        return false;
    }
    if (!presatWarn) {
        console.error('  FAIL: morning feed-in did not come from the pre-saturation pass');
        return false;
    }
    console.log(`  PASS: pre-saturation pass claimed ${morningFeedIn.length}/${morning.length} morning slots at 18ct; ` +
        `SOC drawn ${socStart.toFixed(1)}% -> ${socEnd.toFixed(1)}% ahead of saturation (peak ${maxSoc.toFixed(1)}%)`);
    return true;
}

// =========================================================
// SCENARIO 17: User report (2026-08-20) — "yesterday you charged
// and today you predict many feed in states".
//
// Afternoon of the 19th. Tomorrow (20.08) is PV-rich enough to fill
// the pack to the curtailment line; the day after (21.08) is dead,
// so the multi-day reserve demands a high end-of-schedule floor.
// Two things went wrong at once:
//
//   a) Phase 3c bought grid slots THIS afternoon to reach that floor,
//      at 22-28ct effective — although tomorrow's sun fills the pack
//      for free long before the reserve is ever drawn on. The old
//      "did this pick raise traj[d]?" gate could not see it: the
//      trajectory clamps at MAX_GRID_CHARGE_SOC_PCT, so the spill
//      above 99 never appeared in it.
//   b) Phase 3d's budget collapsed to "overflow only" — a refill was
//      ahead but did not count as free (the marketPrice<3 test only
//      recognises a negative-price glut) — so tonight's 22ct peak was
//      never picked. The energy stayed in the pack, tomorrow's PV
//      then had nowhere to go, and it left the house as 11-15ct
//      curtailment instead.
//
// After the fix: no charge is placed behind the saturation wall, and
// tonight's peak sells because the refill counts as free.
// =========================================================
function scenario17_saturatingRefillUnlocksEveningPeak() {
    console.log('\n=== SCENARIO 17: Saturating PV refill tomorrow -> sell tonight, do not buy ===');

    // NOW = 2026-08-19 14:45 Berlin (UTC 12:45). The schedule reaches
    // 20.08. 23:45 (~33h), past the 30h threshold, so the multi-day reserve
    // is live — the state the reported run was actually in (picks=22).
    const NOW = Date.UTC(2026, 7, 19, 12, 45);
    const startMs = NOW;
    const slots = 133; // 14:45 today → 23:45 tomorrow

    const prices = buildPriceArray(startMs, slots, (t) => {
        const hour = ((new Date(t).getUTCHours() + 2) % 24 + 24) % 24;
        const isToday = t < Date.UTC(2026, 7, 19, 22, 0); // before 00:00 Berlin
        if (isToday) return hour < 18 ? 13 : 22;  // cheap afternoon, 22ct evening peak
        if (hour < 7) return 15;                  // small hours
        if (hour < 17) return 12;                 // tomorrow's PV day: the dump price
        return 20;                                // tomorrow evening: cross-day hold
                                                  // present (floor 17ct), not binding
    });

    // Sun today and tomorrow; nothing at all the day after, so the 48h reserve
    // walk sees a genuine PV desert and pushes the end-of-schedule floor up.
    const solar = [];
    for (let h = 0; h < 80; h++) {
        const t = startMs + h * 3600000;
        const d = new Date(t);
        const hour = ((d.getUTCHours() + 2) % 24 + 24) % 24;
        const dayAfter = t >= Date.UTC(2026, 7, 20, 22, 0); // 21.08 Berlin onwards
        const daylight = hour >= 7 && hour <= 19;
        solar.push({ time: t, sunshineDurationInMinutes: (daylight && !dayAfter) ? 45 : 0 });
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 55 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 1000 }],
            pv_now: [{ time: NOW, pv_now: 3000 }],
            prices,
            solar,
            load_history: buildLoadHistory(NOW),
            pv_history: buildPvHistory(NOW)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 7, 19, 3, 45)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 7, 19, 18, 30)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);
    const phase3cWarn = warnLog.find(w => w.includes('Phase 3c:')) || '';
    const wallMatch = phase3cWarn.match(/PV saturation wall at idx=(\d+) \(([\d.]+)% spill\), (\d+) candidate/);

    const isTonight = s => typeof s.time === 'string' && s.time.includes('19.08.')
        && parseInt(String(s.time).slice(-5, -3), 10) >= 18;
    const tonight = schedule.filter(isTonight);
    const tonightSold = tonight.filter(s => s.state === 4);
    const bought = schedule.filter(s => s.state === 1);

    for (const s of tonight.slice(0, 8)) console.log(`  ${fmtSlot(s)}`);
    if (phase3cWarn) console.log(`  [warn] ${phase3cWarn}`);

    // Sanity: the PV-only walk must actually reach the curtailment line,
    // otherwise there is no wall and nothing under test. (We cannot assert on
    // ≥99% slots in the PLANNED schedule — a working fix sells the pack down
    // so it arrives at saturation exactly full, which is the whole point.)
    if (!wallMatch) {
        console.error('  setup drift: no PV saturation wall projected — nothing to test');
        return false;
    }
    const [, wallIdx, spillPct, refused] = wallMatch;

    let ok = true;
    if (Number(refused) === 0 && bought.length === 0 && tonightSold.length > 0) {
        // Acceptable only if the reserve never asked for a charge at all;
        // flag it so a silent setup change can't hollow the test out.
        console.warn(`  note: wall refused 0 candidates (reserve satisfied without picks)`);
    }
    if (bought.length > 0) {
        console.error(`  FAIL: ${bought.length} grid-charge slot(s) planned although PV spills ${spillPct}% at idx=${wallIdx}`);
        ok = false;
    }
    if (tonightSold.length === 0) {
        console.error(`  FAIL: tonight's 22ct peak never sold (${tonight.length} evening slots, all held)`);
        ok = false;
    }
    if (ok) {
        console.log(`  PASS: ${tonightSold.length}/${tonight.length} evening slots sell at 22ct; `
            + `no grid charge behind the wall (idx=${wallIdx}, ${spillPct}% spill, ${refused} candidate(s) refused)`);
    }
    return ok;
}

function scenario15_feedinGuardIgnoresStaleSample() {
    console.log('\n=== SCENARIO 15: Feed-in guard must not judge a command by a pre-command sample ===');
    // 2026-08-11: the guard blocked feed-in five times in one evening, each block
    // costing the best-priced slot of the following hour (19:45 @ 25.42 ct, the
    // day's peak, among them). Every "delivered" figure it logged came from an
    // ess.Power row recorded BEFORE the command it was judging — 659 W was the
    // 19:54:38 sample, judging the 20:00 feed-in. Power is logged irregularly
    // (18-30 min gaps), so LAST(Power) is routinely a pre-command idle reading.
    const NOW = Date.UTC(2026, 7, 11, 18, 15);        // 20:15 Berlin, the run that blocked
    const commandedAt = NOW - 15 * 60 * 1000;          // the 20:00 feed-in command
    const startMs = NOW - 6 * 3600 * 1000;

    // sampleOffsetMin is measured from commandedAt: negative = sample predates the command.
    function guardBlocks(sampleOffsetMin, powerW) {
        const msg = {
            payload: {
                soc: [{ time: NOW, soc: 81 }],
                acload: [{ time: NOW, acload: 700 }],
                power: [{ time: commandedAt + sampleOffsetMin * 60 * 1000, power: powerW }],
                pv_now: [{ time: NOW, pv_now: 0 }],
                prices: buildPriceArray(startMs, 96, () => 20),
                solar: buildSolarForecast(startMs, 36),
                load_history: buildLoadHistory(NOW),
                pv_history: buildPvHistory(NOW)
            },
            weather: {
                sunRise: new Date(Date.UTC(2026, 7, 11, 3, 30)).toISOString(),
                sunSet: new Date(Date.UTC(2026, 7, 11, 18, 45)).toISOString(),
                solarradiation: 0,
                rainrate: 0
            }
        };
        const store = { feedinGuard: { commandedAt, expectW: 4200 } };
        withMockedNow(NOW, () => runOptimizer(msg, store));
        const blocked = !!(store.feedinGuard && store.feedinGuard.blockedAt);
        const warned = warnLog.some(w => w.includes('under-delivery'));
        return { blocked, warned };
    }

    const cases = [
        // [label, sampleOffsetMin, powerW, expectBlock]
        ['stale pre-command sample (the 11.08. false positive)', -5.4, -659, false],
        ['sample inside the inverter ramp window',                 0.5, -659, false],
        ['fresh sample, pack genuinely under-delivering',            8, -659, true],
        ['fresh sample, pack followed the command',                  8, -4100, false]
    ];

    let ok = true;
    for (const [label, offset, powerW, expectBlock] of cases) {
        const { blocked, warned } = guardBlocks(offset, powerW);
        const pass = blocked === expectBlock && warned === expectBlock;
        if (!pass) ok = false;
        console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}: sample ${offset >= 0 ? '+' : ''}${offset}min, ` +
            `${powerW}W -> blocked=${blocked} (expected ${expectBlock})`);
    }

    console.log(ok
        ? '  PASS: guard only judges samples taken after the command it is checking'
        : '  FAIL: guard verdict wrong for at least one sample timing');
    return ok;
}


// SCENARIO 16: SOC staleness guard.
// 2026-08-16 22:57 the Cerbo GX dropped off the LAN. global.ess.Soc kept being
// re-written with its last value, so the optimizer saw a present, in-range 90.5%
// all night while the packs were really near 53%, and planned against a phantom.
// A SOC that has not moved at all for two hours must stop the optimizer acting
// on its own plan - except at the rails, where a flat SOC is a real state.
function scenario16_socStalenessGuard() {
    console.log('\n=== SCENARIO 16: SOC staleness guard (frozen telemetry) ===');
    const NOW = Date.UTC(2026, 7, 17, 1, 0);          // 03:00 Berlin, deep in the night trough
    const startMs = NOW - 3600 * 1000;

    function run(soc, flatMin) {
        const msg = {
            payload: {
                soc: [{ time: NOW, soc: soc }],
                acload: [{ time: NOW, acload: 700 }],
                power: [{ time: NOW, power: -700 }],
                pv_now: [{ time: NOW, pv_now: 0 }],
                // Deep negative price now: without the guard the optimizer grid-charges.
                prices: buildPriceArray(startMs, 96, (t, i) => (i < 8 ? -30 : 20)),
                solar: buildSolarForecast(startMs, 36),
                load_history: buildLoadHistory(NOW),
                pv_history: buildPvHistory(NOW)
            },
            weather: {
                sunRise: new Date(Date.UTC(2026, 7, 17, 4, 0)).toISOString(),
                sunSet: new Date(Date.UTC(2026, 7, 17, 18, 30)).toISOString(),
                solarradiation: 0,
                rainrate: 0
            }
        };
        const store = { socFresh: { soc: soc, changedAt: NOW - flatMin * 60 * 1000 } };
        const out = withMockedNow(NOW, () => runOptimizer(msg, store));
        return {
            state: out[2].payload.state,
            planned: out[0].currentAction ? out[0].currentAction.state : null,
            stale: out[0].summary.socStale,
            warned: warnLog.some(w => w.includes('SOC stale'))
        };
    }

    const cases = [
        // [label, soc, flatMin, expectStale]
        ['frozen mid-range SOC (the 16.08. outage)', 90.5, 400, true],
        ['same SOC, only 60 min flat',               90.5,  60, false],
        ['flat at the top rail (full pack)',         99.5, 400, false],
        ['flat on the floor',                         5.5, 400, false]
    ];

    let ok = true;
    for (const [label, soc, flatMin, expectStale] of cases) {
        const r = run(soc, flatMin);
        let pass = r.stale === expectStale && r.warned === expectStale;
        // Stale runs must hold state 3 whatever the plan wanted; fresh runs must
        // pass the plan's own decision through untouched.
        if (expectStale) pass = pass && r.state === 3;
        else pass = pass && r.state === r.planned;
        if (!pass) ok = false;
        console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}: soc=${soc}% flat ${flatMin}min -> ` +
            `stale=${r.stale} state=${r.state} (plan wanted ${r.planned})`);
    }

    console.log(ok
        ? '  PASS: frozen SOC holds state 3; fresh and at-rail readings pass through'
        : '  FAIL: staleness guard verdict wrong for at least one case');
    return ok;
}

// =========================================================
// SCENARIO 18: PV-overflow damping window (user report
// 2026-08-24) — "why do you feed in at 08:30 and not 08:00?
// the price is better at 08:00". It was: 20.50ct against the
// 16.82ct we actually sold at. The 08:00 run already saw a real
// saturation wall (21.3% projected spill), but dampOverflow()
// clamps every overflow quantity to its rolling MINIMUM over the
// last OVERFLOW_DAMP_SLOTS slots, and with a 4-slot window the
// wall-free 07:00-07:30 runs were still inside it. So
// `pvOnlyOverflow` read 0.0%, nothing qualified as
// curtailment-bound, the cross-day hold (tomorrow's peak minus
// slack) blocked the morning outright, and the 20.50ct slot went
// by unsold — the budget only unlocked at 08:30, by which time
// the best pre-wall slot was gone.
//
// The window is 2, so a wall must survive one further run — no
// more — before it can unlock feed-in. Three runs against one
// shared context pin both directions at once:
//   07:30 wall-free
//   07:45 FIRST run with spill  -> must NOT unlock (a single-run
//         forecast wobble is exactly what the damping exists to
//         swallow; 06:45 on 08-23 and 08-24 were such wobbles)
//   08:00 SECOND run with spill -> must unlock, and the morning
//         slots must be the ones that get sold
// The window is bracketed from both sides: at 1 the 07:45 run
// unlocks and the wobble guard is gone; at 4 the 08:00 run is
// still held and the reported miss comes back.
// =========================================================
function scenario18_dampingWindowUnlocksOnSecondRun() {
    console.log('\n=== SCENARIO 18: Overflow damping unlocks on the second spill run, not the first ===');

    // 2026-08-24, the reported morning. Runs at 07:30 / 07:45 / 08:00 Berlin.
    const NOW_A = Date.UTC(2026, 7, 24, 5, 30);
    const NOW_B = NOW_A + 15 * 60 * 1000;
    const NOW_C = NOW_A + 30 * 60 * 1000;

    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;
    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW_A)) / 86400000);

    // 36h of prices, so tomorrow's evening peak sits BEYOND the refill horizon
    // and arms the cross-day hold — that hold is what made the reported case
    // turn entirely on the curtailment-bound exemption. Today's own evening is
    // deliberately left under the hold floor (22ct) so it cannot quietly soak
    // the budget and mask the morning result.
    const prices = buildPriceArray(NOW_A, 156, (t) => {
        const h = berlinHour(t), day = dayOffset(t);
        if (day === 0) {
            if (h < 10) return 17;          // the morning window the user asked about — kept more
                                            // than PRESAT_RAW_MAX_REGRET_CT under the 22ct hold floor,
                                            // so only the DAMPED path can ever sell it (scenario 19
                                            // owns the raw exemption's boundary)
            if (h < 19) return 9;           // the price a runtime dump would fetch
            return 15;                      // tonight: below the hold floor
        }
        if (h >= 19 && h < 22) return 25;   // tomorrow's peak, beyond the horizon
        if (h >= 9 && h < 15) return 9;
        return 12;
    });

    const buildSolar = (minutesPerHour) => {
        const out = [];
        for (let h = 0; h < 40; h++) {
            const t = NOW_A + h * 3600000;
            const hour = berlinHour(t);
            out.push({ time: t, sunshineDurationInMinutes: hour >= 7 && hour <= 19 ? minutesPerHour : 0 });
        }
        return out;
    };
    // The forecast jump that starts the episode: 07:30 sees nothing worth
    // saturating for, 07:45 onward sees the day that actually happened.
    const solarWeak = buildSolar(2);
    const solarStrong = buildSolar(45);

    const buildMsg = (now, solar, pvNow) => ({
        payload: {
            soc: [{ time: now, soc: 88 }],
            acload: [{ time: now, acload: 700 }],
            // Feed-in delivering as commanded, so the under-delivery guard
            // (which would otherwise trip on run C after run B commanded a
            // feed-in) stays out of the way.
            power: [{ time: now, power: -3000 }],
            pv_now: [{ time: now, pv_now: pvNow }],
            prices,
            solar,
            load_history: buildLoadHistory(now),
            pv_history: buildPvHistory(now)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 7, 24, 3, 50)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 7, 24, 18, 15)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    });

    // One store across all three runs: `overflowHist` is the state under test,
    // and it only carries if global context survives between runs.
    const store = {};
    const runAt = (now, solar, pvNow) => {
        const result = withMockedNow(now, () => runOptimizer(buildMsg(now, solar, pvNow), store));
        return { schedule: getSchedule(result), warns: warnLog.slice() };
    };

    const runA = runAt(NOW_A, solarWeak, 300);
    const runB = runAt(NOW_B, solarStrong, 1500);
    const runC = runAt(NOW_C, solarStrong, 1500);

    const wallOf = r => (r.warns.find(w => w.includes('Phase 3c:')) || '');
    const spillOf = r => {
        const m = /PV saturation wall at idx=(-?\d+) \(([\d.]+)% spill\)/.exec(wallOf(r));
        return m ? parseFloat(m[2]) : 0;
    };
    const exemptOf = r => {
        const m = /curtailment-bound ([\d.]+)% still sells/.exec(r.warns.find(w => w.includes('Cross-day hold')) || '');
        return m ? parseFloat(m[1]) : null;
    };
    const presatOf = r => r.warns.find(w => w.includes('Phase 3d pre-saturation'));
    const morning = r => r.schedule.filter(s =>
        typeof s.time === 'string' && s.time.includes('24.08.')
        && parseInt(String(s.time).slice(-5, -3), 10) < 10);
    // Only PLANNED feed-in counts. A slot can also reach state 4 through Phase
    // 4's reactive "battery curtailing 100%" branch — that is the pack already
    // full and spilling, i.e. the outcome the pre-saturation pass is supposed
    // to pre-empt, not evidence that the budget unlocked.
    const planned = r => morning(r).filter(s => s.state === 4 && /Planned feed-in/.test(String(s.reason)));
    const reactive = r => morning(r).filter(s => s.state === 4 && /curtailing/.test(String(s.reason)));

    for (const [label, r] of [['07:30', runA], ['07:45', runB], ['08:00', runC]]) {
        const ex = exemptOf(r);
        console.log(`  ${label} run: spill=${spillOf(r).toFixed(1)}% `
            + `curtailment-bound=${ex === null ? 'n/a' : ex.toFixed(1) + '%'} `
            + `morning planned=${planned(r).length} reactive-dump=${reactive(r).length}`
            + `${presatOf(r) ? ' [' + presatOf(r) + ']' : ''}`);
    }

    // Setup sanity: the episode only means something if the wall is INVISIBLE
    // at 07:30 and VISIBLE (raw, undamped) at both 07:45 and 08:00, and if the
    // cross-day hold is actually armed. Otherwise we are testing PV assumptions
    // or price ranking, not the damping window.
    if (spillOf(runA) > 0) {
        console.error(`  setup drift: the 07:30 run already projects ${spillOf(runA).toFixed(1)}% spill — `
            + 'the weak forecast is no longer wall-free');
        return false;
    }
    if (spillOf(runB) < 5 || spillOf(runC) < 5) {
        console.error(`  setup drift: spill ${spillOf(runB).toFixed(1)}% / ${spillOf(runC).toFixed(1)}% at 07:45 / 08:00 — `
            + 'the strong forecast no longer clears PV_CURTAIL_MIN_SOC');
        return false;
    }
    if (exemptOf(runB) === null || exemptOf(runC) === null) {
        console.error('  setup drift: cross-day hold not armed — tomorrow\'s peak no longer lies beyond the horizon, '
            + 'so the morning is not gated on the curtailment-bound exemption');
        return false;
    }

    // Direction 1 — the wobble guard. The 07:45 run SEES the wall and still
    // reports nothing curtailment-bound, because one run of spill is not
    // evidence: the wall-free 07:30 entry is still in the window and the
    // rolling min is 0. With the exemption shut, the 17ct morning sits under
    // the 22ct hold floor and cannot be sold.
    if (exemptOf(runB) !== 0 || presatOf(runB) || planned(runB).length > 0) {
        console.error(`  FAIL: the FIRST spill run (07:45) already unlocked feed-in `
            + `(curtailment-bound ${exemptOf(runB)}%, ${planned(runB).length} planned morning slot(s)) — `
            + 'a single-run forecast wobble now moves the plan');
        return false;
    }

    // Direction 2 — the miss the user reported. Two consecutive runs of spill
    // is the whole evidence bar; the 08:00 morning must sell at 17ct rather
    // than wait for a later run and a worse price.
    if (exemptOf(runC) < 5) {
        console.error(`  FAIL: the SECOND spill run (08:00) still reports only ${exemptOf(runC).toFixed(1)}% `
            + 'curtailment-bound — the damping window is wider than 2 slots');
        return false;
    }
    if (planned(runC).length === 0) {
        console.error('  FAIL: 08:00 unlocked the exemption but planned no morning feed-in; '
            + `the overflow will reach the pack anyway and dump at the 9ct midday price `
            + `(${reactive(runC).length} reactive curtailment slot(s) in the morning)`);
        return false;
    }
    // The point of selling BEFORE the wall is headroom: SOC must fall across
    // the morning, not ride up to the curtailment line and spill.
    const socStart = morning(runC)[0].predictedSoc;
    const socEnd = morning(runC)[morning(runC).length - 1].predictedSoc;
    if (socEnd >= socStart) {
        console.error(`  FAIL: 08:00 sold ${planned(runC).length} morning slot(s) but SOC still rose `
            + `${socStart.toFixed(1)}% -> ${socEnd.toFixed(1)}% — no headroom created ahead of the wall`);
        return false;
    }

    console.log(`  PASS: 07:45 saw ${spillOf(runB).toFixed(1)}% spill and held (curtailment-bound 0.0%, `
        + `${reactive(runB).length} morning slot(s) left to dump reactively at 100%); `
        + `08:00 confirmed it (${exemptOf(runC).toFixed(1)}%) and sold ${planned(runC).length} morning slot(s) `
        + `at 17ct under a 22ct hold floor, SOC ${socStart.toFixed(1)}% -> ${socEnd.toFixed(1)}%`);
    return true;
}

function scenario19_rawSpillExemptionBoundedByRegret() {
    console.log('\n=== SCENARIO 19: Raw-spill exemption sells a near-floor morning on the first spill run, and only that ===');

    // Same three-run episode as scenario 18 (the wall appears at 07:45), but
    // the morning price is the variable. The cross-day hold floor is 22ct
    // throughout (25ct peak beyond the horizon, minus CROSSDAY_HOLD_SLACK_CT).
    //
    //   in-band  21ct   -> 1.0ct of regret if the wall is a wobble -> may sell at 07:45
    //   in-band  19ct   -> 3.0ct of regret                         -> may sell at 07:45
    //   far      17.7ct -> 4.3ct of regret                         -> must wait for 08:00
    //
    // The 19ct case is 2026-08-29 to scale: a 22.41ct evening peak set a 19.41ct
    // floor while the best pre-wall morning slot was 16.41ct, 2.99ct under it, so
    // a 2ct band could not reach the only slot pass 1 had left.
    // The 17.7ct case is the 2026-08-27 07:45 wobble to scale: that run projected
    // 20.8% spill at 17.05ct against a 21.31ct floor, and the 08:00 run projected
    // no wall at all. Selling it would have cost 4.3ct/kWh against a peak that
    // was still coming — 0.3ct outside the band, which is the boundary
    // PRESAT_RAW_MAX_REGRET_CT is calibrated against.
    const NOW_A = Date.UTC(2026, 7, 24, 5, 30);
    const NOW_B = NOW_A + 15 * 60 * 1000;
    const NOW_C = NOW_A + 30 * 60 * 1000;

    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;
    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW_A)) / 86400000);

    const buildPrices = (morningCt) => buildPriceArray(NOW_A, 156, (t) => {
        const h = berlinHour(t), day = dayOffset(t);
        if (day === 0) {
            if (h < 10) return morningCt;   // the pre-wall window under test
            if (h < 19) return 9;           // what a runtime dump would fetch
            return 15;                      // tonight: well under the hold floor
        }
        if (h >= 19 && h < 22) return 25;   // tomorrow's peak, beyond the horizon
        if (h >= 9 && h < 15) return 9;
        return 12;
    });

    const buildSolar = (minutesPerHour) => {
        const out = [];
        for (let h = 0; h < 40; h++) {
            const t = NOW_A + h * 3600000;
            const hour = berlinHour(t);
            out.push({ time: t, sunshineDurationInMinutes: hour >= 7 && hour <= 19 ? minutesPerHour : 0 });
        }
        return out;
    };
    const solarWeak = buildSolar(2);
    const solarStrong = buildSolar(45);

    const buildMsg = (now, prices, solar, pvNow) => ({
        payload: {
            soc: [{ time: now, soc: 88 }],
            acload: [{ time: now, acload: 700 }],
            power: [{ time: now, power: -3000 }],
            pv_now: [{ time: now, pv_now: pvNow }],
            prices,
            solar,
            load_history: buildLoadHistory(now),
            pv_history: buildPvHistory(now)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 7, 24, 3, 50)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 7, 24, 18, 15)).toISOString(),
            solarradiation: 600,
            rainrate: 0
        }
    });

    // One episode = one global store, so overflowHist and crossDayHold carry.
    const runEpisode = (morningCt) => {
        const prices = buildPrices(morningCt);
        const store = {};
        const at = (now, solar, pvNow) => {
            const result = withMockedNow(now, () => runOptimizer(buildMsg(now, prices, solar, pvNow), store));
            return { schedule: getSchedule(result), warns: warnLog.slice() };
        };
        return {
            A: at(NOW_A, solarWeak, 300),
            B: at(NOW_B, solarStrong, 1500),
            C: at(NOW_C, solarStrong, 1500)
        };
    };

    const spillOf = r => {
        const m = /PV saturation wall at idx=(-?\d+) \(([\d.]+)% spill\)/.exec(r.warns.find(w => w.includes('Phase 3c:')) || '');
        return m ? parseFloat(m[2]) : 0;
    };
    const floorOf = r => {
        const m = /feed-in below ([\d.]+)ct/.exec(r.warns.find(w => w.includes('Cross-day hold')) || '');
        return m ? parseFloat(m[1]) : null;
    };
    const presatOf = r => r.warns.find(w => w.includes('Phase 3d pre-saturation')) || '';
    const usedRawPath = r => /raw-spill exemption/.test(presatOf(r));
    const morning = r => r.schedule.filter(s =>
        typeof s.time === 'string' && s.time.includes('24.08.')
        && parseInt(String(s.time).slice(-5, -3), 10) < 10);
    const planned = r => morning(r).filter(s => s.state === 4 && /Planned feed-in/.test(String(s.reason)));
    // Tonight is 15ct, far under the 22ct floor and not a PV-surplus slot, so
    // it may only ever sell out of the DAMPED exemption. It is the tripwire for
    // the raw budget leaking out of pass 1 into the mp-DESC pass.
    const tonight = r => r.schedule.filter(s =>
        typeof s.time === 'string' && s.time.includes('24.08.')
        && parseInt(String(s.time).slice(-5, -3), 10) >= 19
        && s.state === 4 && /Planned feed-in/.test(String(s.reason)));
    const drawn = r => {
        const m = morning(r);
        return m.length ? m[0].predictedSoc - m[m.length - 1].predictedSoc : 0;
    };

    const inBand = runEpisode(21);
    const midBand = runEpisode(19);
    const farBand = runEpisode(17.7);

    for (const [label, ep] of [['21ct (1ct regret)', inBand], ['19ct (3ct regret)', midBand], ['17.7ct (4.3ct regret)', farBand]]) {
        console.log(`  ${label}: floor=${floorOf(ep.B)}ct spill@07:45=${spillOf(ep.B).toFixed(1)}% `
            + `07:45 planned=${planned(ep.B).length} raw=${usedRawPath(ep.B)} drawn=${drawn(ep.B).toFixed(1)}% | `
            + `08:00 planned=${planned(ep.C).length} drawn=${drawn(ep.C).toFixed(1)}%`);
    }

    // Setup sanity: without an armed hold and a wall that is invisible at 07:30
    // and raw-visible at 07:45, this tests nothing.
    if (spillOf(inBand.A) > 0 || spillOf(inBand.B) < 5) {
        console.error(`  setup drift: spill ${spillOf(inBand.A).toFixed(1)}% at 07:30 / `
            + `${spillOf(inBand.B).toFixed(1)}% at 07:45 — the episode no longer starts with a fresh wall`);
        return false;
    }
    if (floorOf(inBand.B) === null || floorOf(farBand.B) === null) {
        console.error('  setup drift: cross-day hold not armed, so nothing gates the morning');
        return false;
    }
    const bandCt = Number(PRESAT_RAW_MAX_REGRET_CT_DOC);
    if (!(inBand.B.schedule.length && 21 < floorOf(inBand.B) && 21 >= floorOf(inBand.B) - bandCt)) {
        console.error(`  setup drift: 21ct is no longer inside the ${PRESAT_RAW_MAX_REGRET_CT_DOC}ct band under the `
            + `${floorOf(inBand.B)}ct floor`);
        return false;
    }

    // Direction 1 — the near-floor morning is taken on the FIRST spill run,
    // via the raw path, without waiting for damping to confirm the wall.
    if (planned(inBand.B).length === 0 || !usedRawPath(inBand.B)) {
        console.error(`  FAIL: 07:45 sold ${planned(inBand.B).length} morning slot(s) at 21ct under a `
            + `${floorOf(inBand.B)}ct floor and did not use the raw-spill exemption — the first spill run still `
            + 'waits a slot while the best pre-wall price decays');
        return false;
    }
    // Headroom is relative, not absolute: under a wall this steep the morning PV
    // outruns any feed-in, so SOC still climbs. The 18ct episode is the same
    // morning with the sale blocked, so the gap between them IS the headroom the
    // raw path bought.
    if (!(drawn(inBand.B) > drawn(farBand.B))) {
        console.error(`  FAIL: 07:45 planned feed-in but ended the morning at the same SOC as the blocked `
            + `18ct episode (${drawn(inBand.B).toFixed(1)}% vs ${drawn(farBand.B).toFixed(1)}%) — `
            + 'no headroom created ahead of the wall');
        return false;
    }

    // Direction 2 — the bet stays bounded. The unconfirmed run may only sell a
    // fraction of what the confirmed run sells.
    if (!(drawn(inBand.B) < drawn(inBand.C))) {
        console.error(`  FAIL: 07:45 drew ${drawn(inBand.B).toFixed(1)}% against ${drawn(inBand.C).toFixed(1)}% at 08:00 — `
            + 'the unconfirmed run is not spending less than the confirmed one');
        return false;
    }
    if (tonight(inBand.B).length > 0) {
        console.error(`  FAIL: the raw budget reached tonight's 15ct slots (${tonight(inBand.B).length} planned) — `
            + 'the exemption leaked out of pass 1 into the mp-DESC pass');
        return false;
    }

    // Direction 3 — the band must reach the gap it exists for. 3ct under the
    // floor is the 2026-08-29 shape: the only pre-wall slot pass 1 had left.
    if (planned(midBand.B).length === 0 || !usedRawPath(midBand.B)) {
        console.error(`  FAIL: 07:45 held the 19ct morning (3ct under a ${floorOf(midBand.B)}ct floor) — `
            + `the ${bandCt}ct band still does not reach a morning peak that sits a few ct under an evening floor`);
        return false;
    }

    // Direction 4 — the regret bound still bounds. 4.3ct under the floor is
    // exactly the 2026-08-27 wobble, and must still wait for confirmation.
    if (planned(farBand.B).length > 0) {
        console.error(`  FAIL: 07:45 sold ${planned(farBand.B).length} morning slot(s) at 17.7ct under a `
            + `${floorOf(farBand.B)}ct floor — a one-run wobble now costs 4.3ct/kWh against the peak we are holding for`);
        return false;
    }
    if (planned(farBand.C).length === 0) {
        console.error('  FAIL: 17.7ct morning never sold, not even on the confirmed 08:00 run — '
            + 'the regret bound has swallowed the damped path too');
        return false;
    }

    console.log(`  PASS: 21ct (1ct under the ${floorOf(inBand.B)}ct floor) sold ${planned(inBand.B).length} slot(s) at 07:45 `
        + `on the raw exemption, ${(drawn(inBand.B) - drawn(farBand.B)).toFixed(1)}% more headroom than the blocked episode `
        + `and ${planned(inBand.C).length} slot(s)/${drawn(inBand.C).toFixed(1)}% once confirmed, tonight untouched; `
        + `19ct (3ct under) also sold ${planned(midBand.B).length} slot(s) at 07:45; `
        + `17.7ct (4.3ct under) held at 07:45 and sold ${planned(farBand.C).length} slot(s) at 08:00`);
    return true;
}

// =========================================================
// SCENARIO 20: User report 2026-08-28 — the day's best evening
// slot (20.35ct at 18:45) idled while 19.46ct at 20:00 sold.
// The pack was still at 87% when the peak arrived, so the
// horizon walk's running peak WAS the starting SOC and the next
// day's refill never came within 3 points of it: the horizon
// fell through to schedule end, tomorrow evening's 20.5-22.4ct
// block entered the feed-in candidate list, and the greedy
// mp-DESC pass spent the budget there. Half an hour later the
// horizon closed normally and those next-day picks were dropped.
// Recovery measured off the TROUGH is start-SOC independent, so
// the candidate window stays inside this cycle and tonight's
// peak competes only against tonight.
// =========================================================
function scenario20_horizonAnchoredToTrough() {
    console.log('\n=== SCENARIO 20: Evening peak must not be outbid by tomorrow (start-SOC-independent horizon) ===');

    const NOW = Date.UTC(2026, 7, 28, 16, 0); // 2026-08-28 18:00 Berlin
    const slots = 120;                        // → 2026-08-29 23:45 Berlin

    const berlinHour = (t) => (new Date(t).getUTCHours() + 2) % 24;
    const berlinMin = (t) => new Date(t).getUTCMinutes();
    const bDay = (ms) => { const d = new Date(ms + 2 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const dayOffset = (t) => Math.round((bDay(t) - bDay(NOW)) / 86400000);

    const TODAY_PEAK_CT = 20.35;
    const prices = buildPriceArray(NOW, slots, (t) => {
        const h = berlinHour(t), m = berlinMin(t), day = dayOffset(t);
        if (day === 0) {                                  // tonight
            if (h === 18 && m === 45) return TODAY_PEAK_CT; // the day's best slot
            if (h === 20 && m === 0) return 19.46;          // what actually sold
            if (h === 21 && m === 0) return 19.99;
            if (h === 23 && m === 0) return 19.72;
            return 18.0;                                    // rest of tonight, under the hold floor
        }
        if (h < 7) return 13;
        if (h >= 7 && h < 17) return 1.5;                 // tomorrow's cheap PV midday
        if (h >= 17 && h < 19) return 20.5;               // tomorrow evening block …
        if (h === 19 && m === 45) return 22.4;            // … topped by the cross-day peak
        if (h >= 19 && h < 23) return 21.5;
        return 18;
    });

    // PV baseline tuned to the reported day: tomorrow lifts the pack ~20 points
    // off the overnight trough but never back to today's 88% — exactly the case
    // the peak-anchored test could not close.
    const pvHistory = [];
    for (let day = 1; day <= 10; day++) {
        const past = new Date(NOW - day * 86400000);
        const dayMidnightUtc = Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), past.getUTCDate(), -2, 0);
        for (let h = 0; h < 24; h++) {
            const pv = (h >= 7 && h <= 18) ? Math.max(0, 1500 * Math.sin(Math.PI * (h - 7) / 11)) : 0;
            pvHistory.push({ time: dayMidnightUtc + h * 3600000, avg_pv: pv > 100 ? pv : null, max_pv: pv > 100 ? pv * 1.2 : null });
        }
    }

    const msg = {
        payload: {
            soc: [{ time: NOW, soc: 88.5 }],
            acload: [{ time: NOW, acload: 700 }],
            power: [{ time: NOW, power: 0 }],
            pv_now: [{ time: NOW, pv_now: 200 }],
            prices,
            solar: buildSolarForecast(NOW, 30),
            load_history: buildLoadHistory(NOW),
            pv_history: pvHistory
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 7, 28, 4, 15)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 7, 28, 18, 15)).toISOString(),
            solarradiation: 80,
            rainrate: 0
        }
    };

    const result = withMockedNow(NOW, () => runOptimizer(msg));
    const schedule = getSchedule(result);

    const parseT = (s) => {
        const m = String(s.time).match(/(\d{2})\.(\d{2})\.,?\s+(\d{2}):(\d{2})/);
        return m ? { dd: +m[1], mm: +m[2], hh: +m[3], mi: +m[4] } : null;
    };
    const isToday = (s) => { const p = parseT(s); return p && p.dd === 28 && p.mm === 8; };

    const peakSlot = schedule.find(s => isToday(s) && Math.abs(s.marketPrice - TODAY_PEAK_CT) < 0.01);
    const tonight = schedule.filter(s => isToday(s) && parseT(s).hh >= 18);
    const sold = tonight.filter(s => s.state === 4);
    const soldBelowFloor = sold.filter(s => s.marketPrice < 19.4);

    console.log(`  tonight sold ${sold.length} slot(s) at ${sold.map(s => s.marketPrice.toFixed(2)).join('/') || '—'}ct`);
    if (peakSlot) console.log(`  ${TODAY_PEAK_CT}ct peak: ${fmtSlot(peakSlot)}`);

    if (!peakSlot) { console.error('  setup error: 20.35ct slot not in schedule'); return false; }
    if (peakSlot.state !== 4) {
        console.error(`  FAIL: the day's best slot (${TODAY_PEAK_CT}ct) idled at state ${peakSlot.state} while ${sold.length} cheaper slot(s) sold`);
        return false;
    }
    if (soldBelowFloor.length) {
        console.error(`  FAIL: ${soldBelowFloor.length} slot(s) sold below the cross-day hold floor`);
        soldBelowFloor.slice(0, 5).forEach(s => console.error('   ', fmtSlot(s)));
        return false;
    }
    console.log(`  PASS: the ${TODAY_PEAK_CT}ct peak sells; nothing below the 19.4ct cross-day floor does`);
    return true;
}

// --- Run all ---

// =========================================================
// SCENARIO 21: User report 2026-08-29 — the plan projected the
// pack sitting at 100% for over an hour while the 15-17ct
// morning went unsold. The preemptive drain was ACTIVE and
// wanted 65 points, but took nothing: its round-trip guard
// priced replacement as a pre-sunrise grid rebuy, and after
// sunrise on the glut day that window is empty, so the
// replacement was Infinity and every DP reward was -Infinity.
// 44% of logged runs (every post-sunrise one) were structurally
// incapable of picking a slot. The energy drained here is
// replaced by PV that would otherwise SPILL, so the replacement
// is what the spill would fetch — but only once the overflow
// has survived the damping window, and never below the
// FEEDIN_MIN_MP_CT floor that `feedin_preemptive` bypasses.
// =========================================================
function scenario21_preemptiveReplacementPostSunrise() {
    console.log('\n=== SCENARIO 21: Preemptive drain must act after sunrise on the glut day ===');

    // Three runs, 15 min apart, all well after sunrise on the glut day itself.
    // Tomorrow's prices have not published, so the schedule ends tonight and
    // there is no pre-sunrise slot left anywhere in it: the old grid-rebuy
    // replacement is structurally unavailable (minReplaceEff=∞).
    //   07:30  weak forecast, no wall  -> nothing to drain for, seeds damping
    //   07:45  wall appears (raw)      -> one run is not evidence, still holds
    //   08:00  wall persists (damped)  -> drains the morning peak
    const NOW_A = Date.UTC(2026, 7, 29, 5, 30); // 07:30 Berlin
    const NOW_B = NOW_A + 15 * 60 * 1000;       // 07:45
    const NOW_C = NOW_A + 30 * 60 * 1000;       // 08:00
    const slots = 66;                            // → 23:45 Berlin

    const berlinHour = (t) => (((new Date(t).getUTCHours() + 2) % 24) + 24) % 24;

    const MORNING_CT = 16;                      // the peak that went unsold
    const prices = buildPriceArray(NOW_A, slots, (t) => {
        const h = berlinHour(t);
        if (h < 9) return MORNING_CT;
        if (h >= 10 && h < 15) return -0.5;     // the glut, confirmed by price
        if (h < 17) return 1.5;
        return 9;                               // evening, under spill + margin
    });

    const buildSolar = (minutesPerHour) => {
        const out = [];
        for (let h = 0; h < 20; h++) {
            const t = NOW_A + h * 3600000;
            const hour = berlinHour(t);
            out.push({ time: t, sunshineDurationInMinutes: hour >= 7 && hour <= 19 ? minutesPerHour : 0 });
        }
        return out;
    };
    const solarWeak = buildSolar(16);   // thin morning: 1.1% projected spill, under PV_CURTAIL_MIN_SOC
    const solarStrong = buildSolar(55);

    const buildMsg = (now, solar, pvNow) => ({
        payload: {
            soc: [{ time: now, soc: 90 }],
            acload: [{ time: now, acload: 700 }],
            power: [{ time: now, power: -2000 }],
            pv_now: [{ time: now, pv_now: pvNow }],
            prices,
            solar,
            load_history: buildLoadHistory(now),
            pv_history: buildPvHistory(now)
        },
        weather: {
            sunRise: new Date(Date.UTC(2026, 7, 29, 4, 10)).toISOString(),
            sunSet: new Date(Date.UTC(2026, 7, 29, 17, 50)).toISOString(),
            solarradiation: 650,
            rainrate: 0
        }
    });

    // One store across all three runs, so the overflow damping history carries.
    const store = {};
    const at = (now, solar, pvNow) => {
        const result = withMockedNow(now, () => runOptimizer(buildMsg(now, solar, pvNow), store));
        return { schedule: getSchedule(result), warns: warnLog.slice() };
    };
    const A = at(NOW_A, solarWeak, 200);
    const B = at(NOW_B, solarStrong, 2500);
    const C = at(NOW_C, solarStrong, 2500);

    const activeOf = r => r.warns.find(w => w.includes('Preemptive ACTIVE:')) || '';
    const picksOf = r => { const m = /slots=(\d+)/.exec(activeOf(r)); return m ? parseInt(m[1], 10) : -1; };
    const replacementOf = r => { const m = /replacement=([\d.]+|∞)ct/.exec(activeOf(r)); return m ? m[1] : null; };
    const confirmedOf = r => /pv-spill/.test(activeOf(r));
    const preemptive = r => r.schedule.filter(s => s.state === 4 && /Pre-emptive discharge/.test(String(s.reason)));

    for (const [label, r] of [['07:30', A], ['07:45', B], ['08:00', C]]) {
        console.log(`  ${label}: active=${!!activeOf(r)} confirmed=${confirmedOf(r)} `
            + `replacement=${replacementOf(r)}ct picks=${picksOf(r)} state4=${preemptive(r).length}`);
    }

    // Setup sanity: the phase has to be armed and genuinely post-sunrise,
    // otherwise this tests nothing. An empty pre-sunrise replacement window
    // (minReplaceEff=∞) is the exact condition that used to sterilise the DP.
    if (!activeOf(A) || !activeOf(B) || !activeOf(C)) {
        console.error('  setup drift: preemptive phase did not go ACTIVE on all three runs — '
            + 'the glut day no longer arms it');
        return false;
    }
    if (!/minReplaceEff=∞ct/.test(activeOf(C))) {
        console.error(`  setup drift: a pre-sunrise replacement slot still exists (${activeOf(C)}) — `
            + 'the post-sunrise case is not being exercised');
        return false;
    }

    // Direction 1 — one run of overflow is not evidence. The run the wall first
    // appears keeps the strict grid-rebuy replacement and picks nothing.
    if (confirmedOf(B) || picksOf(B) !== 0) {
        console.error(`  FAIL: 07:45 drained on unconfirmed spill (picks=${picksOf(B)}) — `
            + 'a single forecast spike can now empty the pack ahead of the evening');
        return false;
    }

    // Direction 2 — once the overflow persists, the drain has to act.
    if (!confirmedOf(C)) {
        console.error(`  FAIL: 08:00 never confirmed the spill (${activeOf(C)}) — damping window drifted`);
        return false;
    }
    if (picksOf(C) === 0) {
        console.error('  FAIL: 08:00 still picked nothing with the spill confirmed — '
            + 'the post-sunrise drain is inert and the pack will ride at 100%');
        return false;
    }

    // Direction 3 — the replacement price may drop to the spill price, but the
    // floor and the round-trip margin still bound what it can sell.
    const sold = preemptive(C);
    if (sold.length === 0) {
        console.error('  FAIL: 08:00 planned preemptive slots but none survived to state=4 — '
            + 'Phase 4 demoted every one of them');
        return false;
    }
    const cheap = sold.filter(s => s.marketPrice < 5);
    if (cheap.length > 0) {
        console.error(`  FAIL: 08:00 fed in ${cheap.length} slot(s) under the 5ct floor `
            + `(cheapest ${Math.min(...cheap.map(s => s.marketPrice)).toFixed(1)}ct) — `
            + 'feedin_preemptive bypasses planSlot(), so the floor must be stated in the DP');
        return false;
    }

    console.log(`  PASS: 07:45 held (spill unconfirmed, replacement ${replacementOf(B)}ct); 08:00 confirmed the spill, `
        + `repriced replacement to ${replacementOf(C)}ct and drained ${sold.length} slot(s) at `
        + `${Math.min(...sold.map(s => s.marketPrice)).toFixed(1)}-${Math.max(...sold.map(s => s.marketPrice)).toFixed(1)}ct, `
        + 'none under the 5ct floor');
    return true;
}

const results = [
    ['evening slot below avgPrice', scenario1_eveningSlotBelowAvg],
    ['no negative feed-in',         scenario2_noNegativeFeedIn],
    ['top-priced feed-in',          scenario3_topPricedFeedIn],
    ['preserve afternoon SOC',      scenario4_preserveAfternoonSoc],
    ['cloudy forecast honored',     scenario5_cloudyForecastHonored],
    ['end-of-schedule reserve bad forecast', scenario6_endOfScheduleReserveBadForecast],
    ['preemptive picks morning peak', scenario7_preemptivePicksMorningPeak],
    ['preemptive post-sunrise no tomorrow', scenario8_preemptivePostSunriseNoTomorrow],
    ['saturation cluster round-trip', scenario9_saturationClusterRoundTrip],
    ['cross-day hold (sell tonight vs tomorrow peak)', scenario10_crossDayHold],
    ['arbitrage fires on big delta', scenario11_arbitrageFiresOnBigDelta],
    ['no arbitrage on normal delta', scenario12_noArbitrageOnNormalDelta],
    ['hold when tomorrow sun-poor', scenario13_holdWhenTomorrowSunPoor],
    ['pre-saturation morning feed-in', scenario14_preSaturationMorningFeedIn],
    ['feed-in guard ignores stale sample', scenario15_feedinGuardIgnoresStaleSample],
    ['SOC staleness guard',           scenario16_socStalenessGuard],
    ['saturating refill unlocks evening peak', scenario17_saturatingRefillUnlocksEveningPeak],
    ['damping window unlocks on second spill run', scenario18_dampingWindowUnlocksOnSecondRun],
    ['raw-spill exemption bounded by regret',     scenario19_rawSpillExemptionBoundedByRegret],
    ['evening peak not outbid by tomorrow',       scenario20_horizonAnchoredToTrough],
    ['preemptive drain acts after sunrise',       scenario21_preemptiveReplacementPostSunrise]
];

let passed = 0;
for (const [name, fn] of results) {
    try {
        if (fn()) passed++;
    } catch (e) {
        console.error(`  EXCEPTION in ${name}:`, e.message);
        console.error(e.stack);
    }
}

console.log(`\n=== ${passed}/${results.length} scenarios passed ===`);
process.exit(passed === results.length ? 0 : 1);
