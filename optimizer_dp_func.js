// ============================================================
// Battery Controller v2 - Cost Optimization Algorithm (DP planner)
// ============================================================
// Live since 2026-10-17 as node `optimizer_dp`. Planning is one dynamic
// program (see PLANNING below); inputs, SOC source, safety guards, PV/load
// forecasts and outputs are the old optimizer's (optimizer_func.js, node
// `optimizer`, kept disabled as the backup). Constants above PLANNING that only
// the old rule stack read are left in place unused.
// Battery: 30 kWh, charger max 3500W, planning floor MIN_SOC_PCT
// States: 1=charge from grid, 3=compensate load, 4=feed-in (setpoint per slot)
// 5=hold in the logs only (batteryplan, optrun): commanded as 3 with MaxDischargePower 0
// Grid fee: +13 ct/kWh, reduced 20% in months 4-9 between 10:00-16:00
// Hard rule: NEVER feed in at negative market prices (we'd pay the grid)
// ============================================================

const BATTERY_CAPACITY_KWH = 30;
const MAX_CHARGE_W = 3500;
const MAX_DISCHARGE_W = 3500;
const AVG_LOAD_W = 700;
const MIN_SOC_PCT = 10; // planning floor on the ess.Soc scale. 5 until 2026-10-17: cell-voltage anchors showed ess.Soc 9-15 % with the cells already at the LFP knee (3.14-3.20 V), so 5 % planned the pack onto its cutoff
// --- Prototype 2026-09-29: measured losses + evening sale against tomorrow's sun ---
// Flags so a replay can compare old vs new; both false = the pre-2026-09-29 algorithm.
const PLAN_WITH_LOSSES = false;   // round-trip economics and the arbitrage hurdle use the measured AC<->DC losses
const DRAIN_WITH_LOSSES = true;   // the overnight-survival guard's trough walk drains 1/ETA_DISCHARGE SOC per AC kWh: its lossless walk planned a 10% trough that replayed to the 3% cutoff on 2026-09-19 (the spill/selling walks stay lossless - their thresholds are calibrated on it)
const WALK_WITH_LOSSES = false;   // also apply them inside the planning SOC walks and the predictedSoc projection (off: the spill/ceiling/damping thresholds and reserve picks are calibrated on these walks)
const EVENING_REFILL_SELL = false; // price stored energy that tomorrow's PV refills at that PV's export value, not at retail
// Measured 2026-09-22..29: summed per-pack DC power vs the AC side (PV + import - export - load).
// AC 120.5 kWh in -> 106.9 kWh DC; 110.1 kWh DC out -> 100.7 kWh AC. Round trip ~0.81, idle draw included.
const ETA_CHARGE = 0.887;
const ETA_DISCHARGE = 0.915;
const FEEDIN_CYCLE_WEAR_CT = 1.5;  // per stored kWh cycled out
const FEEDIN_MIN_PROFIT_CT = 1.5;  // what a stored kWh must still net after losses, wear and replacing it
// --- PV forecast v2 (2026-09-29) ---
// PV per slot = clear-sky PV for that hour x a saturating function of the hour's
// forecast sunshine minutes. The old model scaled a matched-days profile LINEARLY
// by sunshine, so an hour with 0 forecast sun made 0 W and a half-sunny day came
// out at a third of reality: over 2026-09-01..28 it forecast 61% of actual PV
// (RMSE 11.9 kWh/day). Fitted on hourly PV vs forecastnew sunshine for the same
// period (split-half fits agree: floor 0.17-0.22, k 14-33 min): an overcast hour
// still gives ~20% of clear sky from diffuse light, 30 min of sun ~68%, a full
// sunny hour ~90%. v2 forecast 100% of actual, RMSE 2.8 kWh/day.
const PV_FORECAST_V2 = true;
const PV_SUN_FLOOR = 0.2;         // fraction of clear-sky PV with zero forecast sunshine (diffuse light)
const PV_SUN_TOP = 0.95;          // fraction of clear-sky PV in a fully sunny hour
const PV_SUN_K_MIN = 20;          // sunshine minutes at which ~63% of the floor->top rise is reached
const PV_CLEARSKY_PCTL = 0.95;    // clear-sky hour = this percentile of that hour's history (+-15 days, all years)
const CHARGE_EFFICIENCY = WALK_WITH_LOSSES ? ETA_CHARGE : 0.94; // one-way charge efficiency for the predictedSoc projection only. Energy sent to the pack (grid charge or PV surplus) lands as SOC at ~94% (inverter AC→DC conversion + minor coulombic loss). Empirically calibrated 2026-07-04: predicted SOC ran ~+3–4% above true capacity-weighted BMS SOC during steep daytime charging (morning gain +45.4 predicted vs +42.5 true BMS → 0.936 ratio); overnight discharge already matched within 0.1%, so the factor is applied to charging deltas only. Planning sims are left at 100% (unchanged) — this only tightens the reported projection.
const INTERVAL_HOURS = 0.25; // 15 minutes
const PV_PEAK_W = 5000;
const BASE_GRID_FEE = 13; // ct/kWh
const FEEDIN_MIN_MP_CT = 5; // never feed in below this market price (cycle wear + inverter losses exceed sub-ct revenue)
const MAX_GRID_CHARGE_SOC_PCT = 90; // Phase 3c projection cap: planner refuses to schedule grid-charge slots past 90% SOC. PV-driven fill above this is still allowed at runtime (no curtailment). Drops the most-expensive ~3 picks (typically pre-13:00 morning slots before next-day prices publish), reduces battery wear, preserves headroom for unforecast PV.
const SOC_CEILING_PCT = 95;     // planning ceiling: the SOC the planner treats as a full pack. Every planning simulation clamps here and books the excess as spill, so the machinery that already exists for saturation (Phase 3d's pre-saturation pass, the feed-in budget, Phase 3d.2's cluster pre-pick) frees the room at the best-priced slots ahead of the morning wall and sells the evening peak back down to it. Keeps the pack off the top of the LFP charge plateau — where the per-pack CELL_FULL_V full-stop lives and where charge acceptance falls off — and leaves ~1.5 kWh of headroom for PV the forecast missed. Deliberately an AIM, not an enforcement: SOC_CURTAIL_PCT stays where it was, so a real overshoot is planned back down on the next cycle rather than dumped at the FEEDIN_MIN_MP_CT floor. When the pack starts a run ABOVE this (runtime is allowed to), the clamp books the difference as spill on the very first slot — the bias is conservative in the intended direction (it asks for a drain) and self-corrects each run against the fresh SOC reading.
const SOC_CURTAIL_PCT = 99;     // runtime backstop: the SOC at which PV is genuinely being wasted, so Phase 4 sells at any mp above FEEDIN_MIN_MP_CT. Independent of SOC_CEILING_PCT by design — the ceiling governs what the planner aims for, this governs when an overshoot has stopped being worth holding. Lowering this to the ceiling would enforce 95% but only by selling stored energy at the 5 ct floor, against the round-trip discipline the feed-in rules exist to protect.
const SOC_CEILING_BAND_PCT = SOC_CURTAIL_PCT - SOC_CEILING_PCT; // the headroom the ceiling reserves. Overflow inside this band is not a forecast guess — the pack really would sit there — so it is certain budget; only overflow past it is PV the forecast may have imagined.
const PRESAT_MIN_GAIN_CT = 3; // Phase 3d pass 1: a pre-saturation drain must beat the price the same energy would fetch when Phase 4's runtime branch dumps it during saturation. Guards the pre-drain against becoming a low-price midday sale (see the "never pre-drain at low midday prices to make room for PV" rule): the hurdle is the realistic alternative price, not zero. 3 ct ≈ the observed 10–15 ct dump band vs 17–20 ct pre-saturation prices, so it fires on genuine spreads and stays quiet on near-ties.
const PRESAT_RAW_EXEMPT_FRAC = 0.35; // Phase 3d pass 1 only: fraction of the UNDAMPED PV-only spill that may be treated as curtailment-bound on the FIRST run a saturation wall appears, before dampOverflow has confirmed it. The damping window is right for the mp-DESC pass (a 2026-07-28-style forecast spike there empties the pack past the evening peak) but it also costs pass 1 the best pre-wall price on every strong-PV morning, because the wall shows up mid-morning and the good slots decay 2-3 ct while the window fills (2026-08-24: 20.50 -> 18.04 ct). A wall can still evaporate in one slot (2026-08-27 07:45 projected 20.8% spill; the 08:00 run projected none), so this only ever bets a fraction, and only inside the price band set by PRESAT_RAW_MAX_REGRET_CT.
const PRESAT_RAW_MAX_REGRET_CT = 6; // Phase 3d pass 1 raw-spill exemption: how much per kWh we are willing to lose against the peak the cross-day hold is protecting, if the unconfirmed wall turns out to wobble. Only slots priced within this much of the hold floor may use the raw exemption, so the downside is bounded at PRESAT_RAW_MAX_REGRET_CT x PRESAT_RAW_EXEMPT_FRAC. Was 2 until 2026-08-29, then 4: that admitted the 2026-08-29 case (16.41ct against a 19.41ct floor = 2.99ct of regret) while still excluding the 2026-08-27 wobble (17.05ct against a 21.31ct floor = 4.26ct of regret, wall gone by the next run) — 4 was calibrated specifically to sit between those two. Widened to 6 on 2026-09-20: with dawn-eager wall detection (see estimatePvPowerForecastOnly) opening the wall as early as 07:00-07:15, the morning ramp's price decays fast enough (21.2 -> 19.6 -> 15.4ct in 30 min that day) that 4ct still missed the 15.4ct slot at 5.9ct of regret. This is a deliberate trade, not a new safeguard: 6 also re-admits the 2026-08-27 wobble shape (4.26ct < 6ct), so a single-run false wall is now more expensive when it happens — accepted because it is still bounded to PRESAT_RAW_EXEMPT_FRAC of the spill and gated on the hold being armed at all.
const PV_CURTAIL_MIN_SOC = 5;   // a PV-ONLY projection must overflow by at least this much SOC (~1.5 kWh) before the planner accepts "PV will saturate the pack" as real. 0.6% of phantom overflow on a bad-PV day (74 sun-min) once unlocked PV-opportunity pricing and let a 22.39ct evening feed-in pass against a 14ct real grid refill. The same floor now also gates the Phase 3c saturation wall and the Phase 3d free-refill test, so a single forecast wobble cannot rewrite the plan.
const FEEDIN_ROUNDTRIP_MARGIN_CT = 5; // Phase 3d round-trip margin: non-overflow feed-in mp must beat replacementPrice by this much. Raw mp-vs-effective comparison alone ignores inverter round-trip losses (~10%) and battery cycle wear — the 5 ct margin covers ~10% inverter losses + ~1.5 ct cycle wear at the typical 20 ct sell price (net ~1.5 ct/kWh remaining profit). Raised to 10 on 2026-05-19 when the false pvOpportunityPrice ~11ct was being applied across the board — dropping to 5 against pvOpp made thin spreads net losers. After the early pass was fixed to use strict minReplaceEff (no pvOpp bypass for pre-grid-charge slots), the margin/replacement combination became too strict and missed the legitimate 22.39 ct peak (real spread 5.49 ct vs minReplaceEff 16.90). Returned to 5 on 2026-05-19 (later 5).
const CROSSDAY_HOLD_SLACK_CT = 3; // Phase 3d cross-day hold: don't sell tonight's STORED energy when a materially higher stored-energy feed-in peak lies BEYOND the horizon (e.g. tomorrow evening). Tonight's mp must clear (futurePeak − this slack) to sell; otherwise hold the SOC for the better peak (captured next cycle once the horizon advances). The genuinely curtailment-bound portion (pvOnlyOverflow) is still sold tonight — it would be lost to PV curtailment if held. Slack avoids churn on near-ties and covers PV-forecast uncertainty (re-evaluated every 15 min).
const CROSSDAY_HOLD_MAX_AGE_MS = 12 * 3600 * 1000; // how long a cross-day hold floor may be carried once horizonIsRefill flips false (see the carry branch in Phase 3d). Bounded so a floor computed from a stale horizon can't suppress feed-in indefinitely; the peak it was derived from must also still lie in the future.
// Phase 3b-arb (arbitrage grid-charge): on exceptional-delta days, grid-charge cheap slots SPECIFICALLY to resell at a high feed-in peak before the next free PV refill. This deliberately opens the grid→feed-in path that the other phases block — guarded by a high NET hurdle so it only fires when the round-trip is genuinely profitable. Charged slots are tagged _plan='charge', so all existing charge handling (SOC sims, state=1 emit, Phase 3d feed-in budget + round-trip checks) sells the resulting surplus at the peak automatically.
const ARB_MIN_NET_CT = 16;      // required NET profit per kWh after round-trip loss + cycle wear: peakMp*ARB_RT_EFF − chargeEff − ARB_CYCLE_WEAR_CT ≥ this
const ARB_RT_EFF = PLAN_WITH_LOSSES ? ETA_CHARGE * ETA_DISCHARGE : 0.9;         // inverter+round-trip efficiency applied to sell revenue (~10% loss)
const ARB_CYCLE_WEAR_CT = 1.5;  // battery cycle-wear cost per kWh cycled
const ARB_CHARGE_SOC_PCT = SOC_CEILING_PCT; // arbitrage may fill to the planning ceiling (energy is dumped within hours; relaxes the normal 90% Phase 3c headroom cap, but not past the ceiling — the headroom the ceiling reserves is for PV the forecast missed, which arbitrage has no claim on)
const TIMEZONE = 'Europe/Berlin';

// Timezone-aware time extraction (all logic must use local Berlin time, not UTC)
const _tzFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour: 'numeric', minute: 'numeric', month: 'numeric', hourCycle: 'h23'
});
function berlinTime(timeMs) {
    const parts = _tzFmt.formatToParts(new Date(timeMs));
    const get = type => parseInt(parts.find(p => p.type === type).value);
    return { hour: get('hour'), minute: get('minute'), month: get('month') };
}

// A grid-charge slot is "pre-publish" only if it lies before ~13:00 Berlin on
// TODAY's date: charging there bets that tomorrow's still-unpublished prices are
// no cheaper (user 2026-05-20). Tomorrow-morning slots seen from an evening run
// are already priced, so they compete on price alone; once their own day starts
// they become today-morning slots and the preference applies again. Keying on
// the slot's hour alone made every evening run skip a 15.5ct 06:00 slot for
// 18.9ct ones tonight (2026-10-17).
const _tzDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
function isPrePublishSlot(timeMs) {
    return berlinTime(timeMs).hour < 13
        && _tzDayFmt.format(new Date(timeMs)) === _tzDayFmt.format(new Date(Date.now()));
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
let minCellV = lastVal(raw.soc, 'minCellV');
if (typeof minCellV !== 'number' || !isFinite(minCellV)) minCellV = null;

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
// is, and those are exempt. So is a pack that is simply not moving current: on
// 2026-09-25 the pack sat at 0 W from 03:15 and the counter held 25.0% because
// nothing was flowing, not because the feed froze - and the guard then blocked
// grid-charge for the rest of the night. A frozen collector can in principle
// re-write a 0 W reading as well, but a live pack at night is covering load, so
// a truly frozen feed almost always pins a non-zero power.
const SOC_IDLE_W = 50;
const SOC_STALE_MIN = 120;
const _bmsCtx = global.get('bms') || {};
const _socSource = lastVal(raw.soc, 'socSource')
    || ((typeof _bmsCtx.weightedSoc === 'number'
        && typeof _bmsCtx.ts === 'number' && _bmsCtx.ts > _nowMs - 1800000) ? 'bms' : 'ess');
// Kept in the file store: a Node-RED restart is exactly what someone does while
// troubleshooting an outage, and losing changedAt there would re-arm the whole
// window and buy the fault another two hours of blind operation.
const _socFresh = global.get('socFresh', 'file') || {};
const _socChangedAt = (_socFresh.soc === currentSoc && typeof _socFresh.changedAt === 'number')
    ? _socFresh.changedAt : _nowMs;
const _socFlatMin = (_nowMs - _socChangedAt) / 60000;
const _atSocRail = currentSoc >= 99 || currentSoc <= MIN_SOC_PCT + 1;
const _idlePowerW = lastVal(raw.power, 'power');
const _packIdle = typeof _idlePowerW === 'number' && Math.abs(_idlePowerW) < SOC_IDLE_W;
const socStale = _socFlatMin >= SOC_STALE_MIN && !_atSocRail && !_packIdle;
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
// What the planner actually ran on, for whoever logs an "actual SOC" line. The
// two feeds sit ~36 pp apart today, so a consumer that always reads the BMS ends
// up plotting a different quantity than the one predictedSoc was projected from.
global.set('socUsed', { soc: currentSoc, source: _socSource, ts: _nowMs });
// Suppress grid-charge of the LIVE slot when the reading can't be trusted or a pack
// is at the cell-voltage ceiling. (Applied at i===0 only; future slots re-evaluate.)
const gridChargeBlocked = !socTrust || (maxCellV !== null && maxCellV >= CELL_FULL_V);

// No cell-voltage floor. One ran here from 2026-09-11 to 2026-09-25, blocking
// export at a min cell of 3.22 V and all discharge at 3.18 V. Both thresholds sat
// on the LFP plateau (3.2 V is nominal; the knee is near 3.0 V), so it rested and
// held packs that still had a fifth of their charge. Each pack's BMS owns its
// low-voltage cutoff; minCellV is kept for telemetry only.

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

// Clear-sky hourly profile for PV_FORECAST_V2: a high percentile of each hour's
// average PV across the +-15-day seasonal window (recent days and prior years).
const clearSkyProfile = (() => {
    const byHour = new Array(24).fill(null).map(() => []);
    for (const d of Object.values(pvDays)) {
        for (const [h, v] of Object.entries(d.hours)) byHour[parseInt(h)].push(v);
    }
    const prof = byHour.map(v => {
        if (v.length < 5) return null;
        const sorted = [...v].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(PV_CLEARSKY_PCTL * sorted.length))];
    });
    return prof.map(v => v || 0);
})();
const _clearSkyUsable = clearSkyProfile.reduce((a, b) => a + b, 0) > 5000; // cold start: fall back to v1
const pvV2 = PV_FORECAST_V2 && _clearSkyUsable;

// Share of clear-sky PV for a forecast sunshine ratio (0-1 = 0-60 min per hour).
function pvSunFactor(ratio, floor = PV_SUN_FLOOR) {
    const min = Math.max(0, Math.min(ratio, 1)) * 60;
    return floor + (PV_SUN_TOP - floor) * (1 - Math.exp(-min / PV_SUN_K_MIN));
}
// The multiplier applied to a baseline profile hour for a slot's sunshine ratio.
// The post-schedule walks (overnight bridge, multi-day reserve, post-schedule
// overflow) pass floor 0: past the price horizon they are the safety margin for
// sunless streaks (hold stored energy when the days ahead are dark), so they
// keep the old "no sun, no PV" pessimism for dark hours while partly sunny
// hours still get the realistic saturating curve.
function pvSunScale(ratio, refRatio, floor = PV_SUN_FLOOR) {
    return pvV2 ? pvSunFactor(ratio, floor) : Math.min(ratio / Math.max(refRatio, 0.1), 1.2);
}

function getDayBaseline(timeMs) {
    if (pvV2) return { profile: clearSkyProfile, refRatio: 1 };
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

// Per-slot PV baseline before any live-data correction: the historical
// hourly profile scaled by the per-slot sunshine forecast.
function estimatePvBaseline(timeMs) {
    const h = berlinTime(timeMs).hour;
    const { profile: hourlyPv, refRatio: baselineRefRatio } = getDayBaseline(timeMs);
    const basePvRaw = hourlyPv[h] || 0;
    let basePv = basePvRaw;
    const slotForecast = getSunshineForecast(timeMs);
    if (slotForecast !== null && basePvRaw > 0) {
        basePv = basePvRaw * pvSunScale(slotForecast, baselineRefRatio);
    } else if (pvV2) {
        // no sunshine row for this hour: v2's profile is clear sky, so hedge to a half-sunny hour
        basePv = basePvRaw * pvSunFactor(0.5);
    }
    return { basePvRaw, basePv };
}

function estimatePvPower(timeMs) {
    if (!isDaylight(timeMs)) return 0;
    const now = Date.now();
    const hoursAhead = (timeMs - now) / (3600 * 1000);
    const { basePvRaw, basePv } = estimatePvBaseline(timeMs);

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
    if (weather.rainrate > 0 && (!pvV2 || hoursAhead < 1)) rainFactor = 0.3;

    return Math.min(basePv * rainFactor, PV_PEAK_W);
}

// Baseline + rain factor only, no live-PAC/radiation correction. The live
// correction blends toward actual inverter output, which under-reads during
// the morning ramp (PAC lags the true curve as panels come out of shadow/low
// angle) — 2026-09-20 the pack sat at 100% SoC for ~4h before the corrected
// estimate caught up and the saturation wall fired. Used only to widen the
// dawn-hours wall check below, never for dispatch or the reserve floor.
function estimatePvPowerForecastOnly(timeMs) {
    if (!isDaylight(timeMs)) return 0;
    const { basePv } = estimatePvBaseline(timeMs);
    if (basePv <= 0) return 0;
    let rainFactor = 1;
    if (weather.rainrate > 0 && !pvV2) rainFactor = 0.3;
    return Math.min(basePv * rainFactor, PV_PEAK_W);
}

// Dawn window during which the live-corrected estimate above is least
// trustworthy for the near-term ramp (see estimatePvPowerForecastOnly).
// Day-agnostic (minutes since that day's sunrise), like isDaylight().
const DAWN_EAGER_HOURS = 3;
function isDawnEagerWindow(timeMs) {
    if (!sunRise) return false;
    const rise = berlinTime(sunRise);
    const cur = berlinTime(timeMs);
    const mins = cur.hour * 60 + cur.minute;
    const riseMins = rise.hour * 60 + rise.minute;
    return mins >= riseMins && mins < riseMins + DAWN_EAGER_HOURS * 60;
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

// SOC change for a net AC energy flow into (+) or out of (-) the pack, as the
// planning walks see it. With WALK_WITH_LOSSES the pack keeps ETA_CHARGE of what
// goes in and gives up 1/ETA_DISCHARGE of SOC per AC kWh it delivers.
function netToSoc(kwh) {
    if (!WALK_WITH_LOSSES) return kwhToSoc(kwh);
    return kwh > 0 ? kwhToSoc(kwh * ETA_CHARGE) : kwhToSoc(kwh / ETA_DISCHARGE);
}
function chargeToSoc(kwh) { return kwhToSoc(WALK_WITH_LOSSES ? kwh * ETA_CHARGE : kwh); }
function drainToSoc(kwh) { return kwhToSoc(WALK_WITH_LOSSES ? kwh / ETA_DISCHARGE : kwh); }

// Round-trip test for selling a stored kWh at mp when replacing it costs
// replacementCt per AC kWh (grid effective price, or the export price the
// refilling PV would otherwise have fetched). Selling yields mp*ETA_DISCHARGE;
// putting the kWh back takes 1/ETA_CHARGE AC kWh. Without PLAN_WITH_LOSSES this
// is the old flat FEEDIN_ROUNDTRIP_MARGIN_CT test.
function roundTripClears(mp, replacementCt) {
    if (!PLAN_WITH_LOSSES) return mp > replacementCt + FEEDIN_ROUNDTRIP_MARGIN_CT;
    return mp * ETA_DISCHARGE - FEEDIN_CYCLE_WEAR_CT - replacementCt / ETA_CHARGE >= FEEDIN_MIN_PROFIT_CT;
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
                pvW = basePvRaw * pvSunScale(ratio, baselineRefRatio, 0);
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
                pvW = basePvRaw * pvSunScale(ratio, baselineRefRatio, 0);
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

// --- PV-overflow damping (single-spike guard) -------------------------------
// Shared by the preemptive drain below and the Phase 3d budget: both derive a
// drain decision from a PV forecast, and both must survive a single-run spike.
// Clamp a quantity to its rolling minimum over the last OVERFLOW_DAMP_SLOTS
// slots — decreases apply immediately, increases must persist 30 min before
// they can unlock a sale. History is bucketed by 15-min SLOT, not by run, so an
// off-slot re-trigger can't consume a window entry; a re-run within the same
// slot keeps that slot's MINIMUM rather than overwriting it. Entries written
// before slot-bucketing have no .slot, never match a numeric slot, and simply
// age out. (Window was 4 until 2026-08-24; see the Phase 3d notes for why 2.)
const OVERFLOW_DAMP_SLOTS = 2;
const OVERFLOW_DAMP_MAX_AGE_MS = 90 * 60 * 1000;
const _ovfHist = global.get('overflowHist') || {};
const dampOverflow = (key, value) => {
    if (!(typeof value === 'number' && isFinite(value))) return value;
    const slot = Math.floor(_nowMs / (15 * 60 * 1000));
    const prev = (_ovfHist[key] || []).find(e => e.slot === slot);
    const slotVal = (prev && typeof prev.v === 'number' && isFinite(prev.v))
        ? Math.min(prev.v, value) : value;
    const hist = (_ovfHist[key] || [])
        .filter(e => (_nowMs - e.t) <= OVERFLOW_DAMP_MAX_AGE_MS && e.slot !== slot);
    hist.push({ t: _nowMs, slot, v: slotVal });
    hist.sort((a, b) => a.t - b.t);
    while (hist.length > OVERFLOW_DAMP_SLOTS) hist.shift();
    _ovfHist[key] = hist;
    global.set('overflowHist', _ovfHist);
    return Math.min(...hist.map(e => e.v));
};

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
    const capacityNeededPct = chargeToSoc(totalSurplusKwh);
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
    // Track overflow (curtailed PV above the physical rail) — that energy is
    // also drainable
    // if we make room for it. Without PV in this calc, drain need is
    // under-estimated whenever the window includes daylight hours.
    let projSocAtSunrise = currentSoc;
    let overflowPct = 0;
    for (const s of eveningSlots) {
        const netKwh = (s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000;
        projSocAtSunrise += netToSoc(netKwh);
        if (projSocAtSunrise > SOC_CURTAIL_PCT) {
            overflowPct += projSocAtSunrise - SOC_CURTAIL_PCT;
            projSocAtSunrise = SOC_CURTAIL_PCT;
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

    // PV-spill replacement — the post-sunrise case.
    // `sunriseTime` is the first daylight slot at or after now-30min, so once
    // the glut day is under way it lies BEHIND us and the window above
    // (s.time > now && s.time < sunriseTime) is unsatisfiable: the list comes
    // back empty, minReplacementEffPrice is Infinity, every DP reward below
    // evaluates to -Infinity, and the phase picks nothing. It still logs
    // ACTIVE with a full drain target, which is how it stayed invisible: 1493
    // of 3414 logged runs (44%) — every run after sunrise on the glut day —
    // were structurally incapable of picking a slot. User report 2026-08-29:
    // pack projected to sit at 100% for over an hour while the 15-17ct morning
    // went unsold; the preemptive drain wanted 65 points and took nothing.
    // The premise of this whole phase is that PV will overfill the pack, so
    // the energy drained here is replaced by PV that would otherwise SPILL —
    // the replacement cost is the price that spill would fetch, not a grid
    // rebuy at retail (~26ct, which essentially nothing clears). Same
    // reasoning as Phase 3d's pvOpportunityPrice / satDumpPrice.
    // Gated on damped overflow evidence, not the raw projection: a single
    // forecast spike must not empty the pack before the evening peak
    // (2026-07-28). Until the overflow persists two runs the strict
    // grid-rebuy replacement stands, so the first run a wall appears still
    // picks nothing — the same one-run lag Phase 3d's damping accepts.
    const spillSlots = eveningSlots.filter(s => isDaylight(s.time) && s.pvPower > s.loadEst);
    const pvSpillPrice = spillSlots.length
        ? spillSlots.reduce((a, s) => a + Math.max(0, s.marketPrice), 0) / spillSlots.length
        : Infinity;
    const dampedOverflowPct = dampOverflow('preemptiveOverflowPct', overflowPct);
    const spillConfirmed = dampedOverflowPct >= PV_CURTAIL_MIN_SOC;
    const replacementCt = spillConfirmed
        ? Math.min(minReplacementEffPrice, pvSpillPrice)
        : minReplacementEffPrice;

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
                netToSoc((s.pvPower - s.loadEst) * INTERVAL_HOURS / 1000));
            const pickDelta = sortedChrono.map(s =>
                -drainToSoc(Math.max(0, MAX_DISCHARGE_W + s.loadEst - s.pvPower) * INTERVAL_HOURS / 1000));
            // The Infinity replacement above used to be the only thing keeping
            // this path off cheap slots — `feedin_preemptive` bypasses
            // planSlot(), so neither the FEEDIN_MIN_MP_CT floor nor Phase 3d's
            // round-trip margin applies to it (Phase 4 only guards mp < 0).
            // Now that the replacement can legitimately drop to a ~2ct spill
            // price, both have to be stated here explicitly.
            const reward = sortedChrono.map((s, i) =>
                s.marketPrice >= FEEDIN_MIN_MP_CT
                && roundTripClears(s.marketPrice, replacementCt)
                    ? s.marketPrice * (skipDelta[i] - pickDelta[i])
                    : -Infinity);

            const clipSoc = (soc) => Math.max(MIN_SOC_PCT, Math.min(SOC_CEILING_PCT, soc));
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

    node.warn(`Preemptive ACTIVE: target=${targetSocForSunrise.toFixed(1)}%, sunrise=${new Date(sunriseTime).toISOString()}, extraDrain=${extraDrainNeeded.toFixed(1)}%, slots=${preemptiveDischargeSlots.size}, surplus=${totalSurplusKwh.toFixed(1)}kWh, negSlots=${negPriceSlots}, minReplaceEff=${isFinite(minReplacementEffPrice) ? minReplacementEffPrice.toFixed(1) : '∞'}ct, `
    + `replacement=${isFinite(replacementCt) ? replacementCt.toFixed(1) : '∞'}ct`
    + `${spillConfirmed ? ` (pv-spill ${pvSpillPrice.toFixed(1)}ct, damped overflow ${dampedOverflowPct.toFixed(1)}%)` : ` (spill unconfirmed, damped overflow ${dampedOverflowPct.toFixed(1)}%)`}`);
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
// PLANNING: dynamic programming over the whole horizon (since 2026-10-17)
// ================================================================
// Replaces the rule stack (Phases 2-4 of the old optimizer, kept disabled in
// the flow as "Battery Optimizer" and in optimizer_func.js). One objective:
// grid cost first (import x effectivePrice - export x marketPrice), cell wear
// second (DP_WEAR_CT per kWh taken out of the cells). Every former rule (no
// feed-in at negative prices, minimum feed-in price, round trip, reserves,
// arbitrage, the 13:00 preference) follows from that cost or from the
// physics below, so none is coded.
//
// Actions are Cerbo grid setpoints, modelled the way the Cerbo executes them:
// battery = clamp(setpoint + PV - load). > DP_SELF_W = charge (discharge
// pinned to 0), < 0 = export, DP_SELF_W = self-consumption. At mp < 0 export
// is blocked (PreventFeedback, see the device parameters). The last action,
// hold, is DP_SELF_W with discharge pinned to 0: the grid carries the house and
// PV surplus still charges. Without it the pack could only drain or charge, so
// on 2026-10-22 it covered the night at 20 ct, hit the floor at 03:15 and left
// the 29 ct morning peak to the grid. Replay Sep 22-Oct 21: -1.71 EUR.
// State: SOC on a DP_STEP grid from MIN_SOC_PCT to 100 %. Energy left at the
// horizon end is worth the DP_TERM_PCTL import price of the horizon x
// ETA_DISCHARGE. Replay 2026-09-01..10-16 (46 days, cost + wear, SOC-adjusted):
// -13.21 EUR against -1.90 EUR for the rule stack, lowest SOC 17.5 % vs 3 %.
const DP_STEP = 0.25;              // % SOC per DP state
const DP_WEAR_CT = FEEDIN_CYCLE_WEAR_CT; // 1.5 ct per kWh out of the cells
const DP_TERM_PCTL = 0.5;
const DP_SELF_W = 10;              // self-consumption setpoint (= IDLE_SETPOINT_W below)
// Leistungspreis (Austrian grid tariff, SNE-G-V 2026): from LP_FROM the grid bills
// each month's highest 15-min IMPORT in kW (min 2 kW). Netz OÖ has not set its
// start date yet (between 2027-01-01 and 2028-07-01), so null = off and nothing
// below changes. When on, charge setpoints are capped at LP_CHARGE_CAP_W and
// discharge stays free while charging: the Cerbo holds the grid at the setpoint
// and the pack covers any load above it, so a house spike during a charge slot no
// longer lands on the meter. Replay 2026-09-01..10-16 (cost + wear + LP):
// 3500 W pinned +3.85 EUR (peak 4.93 kW), 2000 W free -3.36 EUR at 33.82 EUR/kW-yr
// (final stage), -3.62 vs -7.10 EUR at 19 (start stage); 1500 W saves no LP (2 kW
// minimum) and loses spread. Autumn only, winter not replayed yet.
const LP_FROM = null;              // e.g. '2027-01-01T00:00:00+01:00' (Netz OÖ start)
const LP_CHARGE_CAP_W = 2000;      // = the 2 kW billing minimum
const _lpActive = LP_FROM !== null && now >= Date.parse(LP_FROM);
const DP_CHARGE_W = _lpActive ? Math.min(LP_CHARGE_CAP_W, MAX_CHARGE_W) : MAX_CHARGE_W;
const DP_GSET = [DP_CHARGE_W, DP_CHARGE_W / 2, DP_SELF_W, -MAX_DISCHARGE_W / 2, -MAX_DISCHARGE_W, DP_SELF_W];
const DP_HOLD_A = DP_GSET.length - 1;   // index of the hold action
const DP_MAX_FEEDIN_W = 4900;      // combined export cap (= MAX_TOTAL_FEEDIN_W below)

function dpGridCost(kwh, mp, ep) {
    if (kwh >= 0) return kwh * ep;
    return mp < 0 ? 0 : -Math.min(-kwh, DP_MAX_FEEDIN_W / 4000) * mp;
}
// Battery AC power (kW, + = charge) the Cerbo produces for setpoint G.
function dpBattery(G, pvKw, loadKw, mp, hold) {
    let b = Math.max(-MAX_DISCHARGE_W / 1000, Math.min(MAX_CHARGE_W / 1000, G / 1000 + pvKw - loadKw));
    if ((G > DP_SELF_W && !_lpActive) || hold) b = Math.max(0, b);
    if (mp < 0) b = Math.max(b, Math.min(MAX_CHARGE_W / 1000, pvKw - loadKw));
    return b;
}
// One slot's battery kWh (AC) and SOC delta, clipped to the SOC range.
function dpStep(G, s, socPct, hold) {
    let b = dpBattery(G, s.pvPower / 1000, s.loadEst / 1000, s.marketPrice, hold) / 4;
    if (b > 0) b = Math.min(b, (100 - socPct) / 100 * BATTERY_CAPACITY_KWH / ETA_CHARGE);
    if (b < 0) b = Math.max(b, -(socPct - MIN_SOC_PCT) / 100 * BATTERY_CAPACITY_KWH * ETA_DISCHARGE);
    const dcKwh = b > 0 ? b * ETA_CHARGE : b / ETA_DISCHARGE;
    return { b, dcKwh, dSoc: dcKwh / BATTERY_CAPACITY_KWH * 100 };
}

const _dpN = Math.round((100 - MIN_SOC_PCT) / DP_STEP) + 1;
const _dpKwhStep = DP_STEP / 100 * BATTERY_CAPACITY_KWH;
const _dpIdx = socPct => Math.max(0, Math.min(_dpN - 1, Math.round((socPct - MIN_SOC_PCT) / DP_STEP)));
const _dpActs = new Array(schedule.length);
let _dpTermCt = 0, _dpPlanCt = 0;
if (schedule.length > 0) {
    const sortedEp = schedule.map(s => s.effectivePrice).sort((a, b) => a - b);
    _dpTermCt = sortedEp[Math.floor((sortedEp.length - 1) * DP_TERM_PCTL)] * ETA_DISCHARGE;
    let V = new Float64Array(_dpN);
    for (let i = 0; i < _dpN; i++) V[i] = -_dpTermCt * i * _dpKwhStep;
    for (let k = schedule.length - 1; k >= 0; k--) {
        const s = schedule[k];
        const P = s.pvPower / 1000, L = s.loadEst / 1000, mp = s.marketPrice, ep = s.effectivePrice;
        const NV = new Float64Array(_dpN), A = new Int8Array(_dpN);
        for (let i = 0; i < _dpN; i++) {
            let best = Infinity, ba = DP_GSET.indexOf(DP_SELF_W);
            for (let a = 0; a < DP_GSET.length; a++) {
                let b = dpBattery(DP_GSET[a], P, L, mp, a === DP_HOLD_A) / 4;
                let d = b > 0 ? b * ETA_CHARGE : b / ETA_DISCHARGE;
                let x = i + d / _dpKwhStep;
                if (x > _dpN - 1) { x = _dpN - 1; d = (x - i) * _dpKwhStep; b = d / ETA_CHARGE; }
                if (x < 0) {
                    // An export setpoint does not stop at the floor: the Cerbo holds
                    // the grid at G and drains the pack for it. Clipping made it look
                    // free here, and on 2026-10-20 the DP sold 1750 W at 20 ct from
                    // 10 % down to 7 %. Feed-in must fit above the floor.
                    if (DP_GSET[a] < 0) continue;
                    x = 0; d = (x - i) * _dpKwhStep; b = d * ETA_DISCHARGE;
                }
                const x0 = Math.floor(x), x1 = Math.min(_dpN - 1, x0 + 1), w = x - x0;
                const c = dpGridCost(L / 4 + b - P / 4, mp, ep) + (d < 0 ? -d * DP_WEAR_CT : 0)
                    + V[x0] * (1 - w) + V[x1] * w;
                if (c < best - 1e-9) { best = c; ba = a; }
            }
            NV[i] = best; A[i] = ba;
        }
        V = NV; _dpActs[k] = A;
    }
    _dpPlanCt = V[_dpIdx(currentSoc)];
}

// Forward walk from the live SOC: the plan the policy produces if the forecast
// comes true. The guards apply to the live slot only; later slots re-plan.
{
    let soc = currentSoc;
    for (let i = 0; i < schedule.length; i++) {
        const slot = schedule[i];
        const mp = slot.marketPrice, ep = slot.effectivePrice;
        const a = _dpActs[i][_dpIdx(soc)];
        let G = DP_GSET[a], hold = a === DP_HOLD_A;
        let reason;
        if (i === 0 && G > DP_SELF_W && gridChargeBlocked) {
            G = DP_SELF_W;
            reason = !socTrust
                ? `Skip planned charge - SOC reading untrusted, compensate`
                : `Skip planned charge - cell ${maxCellV.toFixed(3)}V >= ${CELL_FULL_V}V (full), compensate`;
        } else if (i === 0 && G < 0 && feedinDeliveryBlocked) {
            G = DP_SELF_W;
            reason = `Skip planned feed-in - pack under-delivered the last one, compensate`;
        } else if (G < 0 && mp < 0) {
            G = DP_SELF_W;   // cannot happen (export is priced out), kept as the hard guard
            reason = `Skip feed-in at ${mp.toFixed(1)}ct (neg price), compensate`;
        }
        const st = dpStep(G, slot, soc, hold);
        soc = Math.max(MIN_SOC_PCT, Math.min(100, soc + st.dSoc));
        const state = G > DP_SELF_W ? 1 : G < 0 ? 4 : 3;
        if (!reason) {
            reason = state === 1 ? `DP charge: grid ${G}W at ${ep.toFixed(1)}ct`
                : state === 4 ? `DP feed-in: grid ${G}W at ${mp.toFixed(1)}ct`
                : hold ? `DP hold: grid covers the house at ${ep.toFixed(1)}ct, pack kept for later`
                : `DP compensate: self-consumption at ${ep.toFixed(1)}ct`;
        }
        slot.state = state;
        slot.hold = hold;
        slot.acPowerSetPoint = G;
        slot.predictedSoc = Math.round(soc * 10) / 10;
        slot.reason = reason;
    }
}

// Audit only (optrun.satwall): does PV alone fill the pack within the horizon?
let pvSatWall = -1;
{
    let s0 = currentSoc;
    for (let i = 0; i < schedule.length && pvSatWall < 0; i++) {
        s0 = Math.max(MIN_SOC_PCT, s0 + netToSoc((schedule[i].pvPower - schedule[i].loadEst) * INTERVAL_HOURS / 1000));
        if (s0 >= SOC_CURTAIL_PCT) pvSatWall = i;
    }
}

// === Build output ===
const output = schedule.map(s => ({
    t: s.time,
    time: s.timeStr,
    state: s.state,
    acPowerSetPoint: s.acPowerSetPoint,
    hold: s.hold,
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
    socStale: socStale,
    minCellV: minCellV
};


// msg3: current setpoint for ESS control
var weather7 = global.get("weather7days", "file")

// A stale SOC makes the whole plan above fiction, so the live slot falls back to
// state 3 (cover the household load) rather than acting on it. Emitting nothing
// would leave the Cerbo pinned in whatever state 1 or 4 the last good run had
// commanded, charging or draining blind - worse than doing nothing.
// Backstop for the same floor: never command an export with the pack at or below it.
const _floorFeedin = !socStale && currentSlot && currentSlot.state === 4 && currentSoc <= MIN_SOC_PCT;
const _cmdState = socStale || _floorFeedin ? 3 : (currentSlot ? currentSlot.state : 3);
const _cmdReason = socStale
    ? `SOC stale (${currentSoc.toFixed(1)}% flat ${Math.round(_socFlatMin)}min, source ${_socSource}) - holding at load compensation`
    : _floorFeedin
    ? `Skip planned feed-in - SOC ${currentSoc.toFixed(1)}% at/below the ${MIN_SOC_PCT}% floor, compensate`
    : (currentSlot ? currentSlot.reason : 'no data');

// === Device parameters (Cerbo + Symo) ===
// The published command carries the concrete settings each box is about to
// receive, each with a one-line reason. cerbo_control and symo_gate consume
// these instead of re-deriving them, so every threshold lives here only and a
// subscriber can see what was commanded and why without replaying the planner.
const IDLE_SETPOINT_W = 10;       // the Cerbo's normal self-consumption grid setpoint (30 until 2026-09-29: it bought ~22 kWh/month the pack could have covered)
const MAX_TOTAL_FEEDIN_W = 4900;  // hard cap on COMBINED grid feed-in from every source
const SYMO_DISABLE_MP_CT = -20;   // below this the grid pays us more than PV output is worth

const _mp = currentSlot && typeof currentSlot.marketPrice === 'number'
    ? currentSlot.marketPrice : null;
const _mpTxt = _mp === null ? 'an unknown price' : _mp.toFixed(1) + 'ct';
const _negPrice = (_mp !== null && _mp < 0);

// Only AcPowerSetPoint can *force* an import or an export; the other four
// settings are limits that gate what the ESS is allowed to do on its own.
let _acSetPoint, _maxDischarge, _setPointWhy, _maxDischargeWhy, _cmdHold = false;
const _dpSp = currentSlot && typeof currentSlot.acPowerSetPoint === 'number' ? currentSlot.acPowerSetPoint : null;
if (_cmdState === 1) {
    _acSetPoint = _dpSp !== null && _dpSp > IDLE_SETPOINT_W ? _dpSp : DP_CHARGE_W;
    _maxDischarge = _lpActive ? -1 : 0;
    _setPointWhy = `state 1 at ${_mpTxt}: force ${_acSetPoint}W import to charge the pack`;
    _maxDischargeWhy = _lpActive
        ? `-1 = free: Leistungspreis on, the grid is held at the ${_acSetPoint}W setpoint and the pack covers any load above it, so the monthly import peak stays at the setpoint`
        : 'pinned to 0 so the pack cannot discharge back out while we are paying to fill it';
} else if (_cmdState === 4) {
    _acSetPoint = _dpSp !== null && _dpSp < 0 ? _dpSp : -MAX_DISCHARGE_W;
    _maxDischarge = -1;
    _setPointWhy = `state 4 at ${_mpTxt}: force ${-_acSetPoint}W export, this is a grid setpoint so it caps total feed-in`;
    _maxDischargeWhy = '-1 = no limit, the setpoint alone decides how hard the pack is pushed';
} else if (currentSoc <= MIN_SOC_PCT) {
    // The DP's model stops discharging at the planning floor and lets the grid
    // carry the house, but the Cerbo has no floor of its own (MinimumSocLimit 0),
    // so self-consumption kept draining: 2026-10-18 night, 3 % at 01:00 while the
    // plan showed 10 %. Pin discharge to 0 here; PV surplus can still charge.
    _acSetPoint = IDLE_SETPOINT_W;
    _maxDischarge = 0;
    _setPointWhy = `state 3 at ${_mpTxt}: SOC ${currentSoc.toFixed(1)}% at/below the ${MIN_SOC_PCT}% floor, the grid carries the house`;
    _maxDischargeWhy = `pinned to 0 at the ${MIN_SOC_PCT}% planning floor - the Cerbo's own minimum SOC is 0, so nothing else stops the drain`;
} else if (!socStale && currentSlot && currentSlot.hold) {
    _acSetPoint = IDLE_SETPOINT_W;
    _maxDischarge = 0;
    _setPointWhy = `state 3 hold at ${_mpTxt}: the grid carries the house, the pack is kept for a dearer slot`;
    _maxDischargeWhy = 'pinned to 0 so the pack holds its charge; PV surplus can still charge it';
    _cmdHold = true;
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
        expectW: Math.max(0, -_acSetPoint + (currentSlot.loadEst || 0) - (currentSlot.pvPower || 0))
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

// Per-run audit fields for the "to optlog points" node (one compact row per run
// in infra_2y). Only values this run already computed; no extra work.
const _tomorrowKey = berlinDateKey(now + 86400000);
const _tomorrowSlots = output.filter(s => berlinDateKey(s.t) === _tomorrowKey);
const _sunNow = getSunshineForecast(now);
Object.assign(msg.summary, {
    slotT: currentSlot ? currentSlot.t : null,
    cmdState: _cmdState,
    cmdHold: _cmdHold,
    setPointW: _acSetPoint,
    marketPrice: _mp,
    pvFcW: currentSlot ? currentSlot.pvPower : null,
    loadFcW: currentSlot ? currentSlot.loadEst : null,
    sunMin: _sunNow === null ? null : Math.round(_sunNow * 60),
    pvTomorrowKwh: _tomorrowSlots.length >= 92
        ? _tomorrowSlots.reduce((a, s) => a + (s.pvPower || 0), 0) * INTERVAL_HOURS / 1000
        : null,
    tomorrowSunPoor: tomorrowSunPoor,
    satWall: pvSatWall >= 0
});

return [msg, null, msg3];
