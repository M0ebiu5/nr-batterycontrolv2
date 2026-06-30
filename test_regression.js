// Regression tests for optimizer_func.js
// Each scenario reproduces a specific user-reported bug.
//
// Run: node test_regression.js
// Exit 0 if all pass, 1 otherwise.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'optimizer_func.js'), 'utf8');

// --- Mock node-red node interface ---
const node = {
    warn: (...a) => { if (process.env.OPT_DEBUG) console.log('  [node.warn]', ...a); },
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
function runOptimizer(msg) {
    // The function-node body uses `msg` and `node`, returns `msg` (or array).
    // We wrap as IIFE-style function.
    const fn = new Function('msg', 'node', 'flow', 'global', SRC);
    const flow = { get: () => null, set: () => {} };
    const global = {
        get: (key) => {
            if (key === 'weather7days') return { sun7: [{ value: 0.5 }] };
            return null;
        },
        set: () => {}
    };
    return fn(msg, node, flow, global);
}

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

// --- Run all ---
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
    ['hold when tomorrow sun-poor', scenario13_holdWhenTomorrowSunPoor]
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
