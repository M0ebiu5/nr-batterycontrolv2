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
        }
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

// --- Run all ---
const results = [
    ['evening slot below avgPrice', scenario1_eveningSlotBelowAvg],
    ['no negative feed-in',         scenario2_noNegativeFeedIn],
    ['top-priced feed-in',          scenario3_topPricedFeedIn],
    ['preserve afternoon SOC',      scenario4_preserveAfternoonSoc],
    ['cloudy forecast honored',     scenario5_cloudyForecastHonored],
    ['end-of-schedule reserve bad forecast', scenario6_endOfScheduleReserveBadForecast],
    ['preemptive picks morning peak', scenario7_preemptivePicksMorningPeak],
    ['preemptive post-sunrise no tomorrow', scenario8_preemptivePostSunriseNoTomorrow]
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
