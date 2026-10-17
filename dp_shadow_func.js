// ============================================================
// Battery DP Shadow - cost-optimal planner running beside the live optimizer
// ============================================================
// Controls nothing. Each slot it (1) books the slot that just ended for a
// VIRTUAL battery that followed its own commands, against the measured PV and
// load, and books the real house at the measured grid flow; (2) plans the
// current slot by dynamic programming over the live optimizer's own forecasts
// (global.pp.prediction: pvPower, loadEst, marketPrice per slot), starting
// from the virtual battery's SOC.
//
// Objective, nothing else: grid cost (import x (market + grid fee) - export x
// market) first, battery wear (DP_WEAR_CT per kWh taken out of the cells)
// second. No feed-in floors, no 13:00 rule, no reserves: anything those rules
// were protecting shows up in the cost and the DP weighs it.
//
// Actions are Cerbo grid setpoints, executed the way the Cerbo executes them:
// battery = clamp(setpoint + PV - load). >10 W = charge (discharge pinned to 0),
// <0 = export, 10 = self-consumption. At mp < 0 export is blocked
// (PreventFeedback), as live.
//
// Inputs: msg.payload = raw InfluxDB results for the slot that just ended
// (PV mean, grid mean balanceeme (+ = export), battery mean), from the query
// node before this one. msg.topic 'reset' re-seeds the virtual SOC from the
// real BMS SOC and clears the totals.
// Outputs: 1 = InfluxDB point (infra_2y dpshadow, one per settled slot).
//          2 = the whole plan for forecast.batteryplan as fields dpState /
//              dpPredictedSoc (beside the live optimizer's state / predictedSoc,
//              same timestamps, so the dashboards can show both).
//              dpPredictedSoc starts from the VIRTUAL battery's SOC.

const CAP_KWH = 30;            // SOC scale that matches real BMS SOC drops
const ETA_C = 0.887, ETA_D = 0.915; // measured AC->DC / DC->AC
const MAX_W = 3500;            // charge / discharge limit
const MAX_FEEDIN_W = 4900;     // combined export cap
const SOC_MIN = 5;             // planning floor
const SOC_CUTOFF = 3;          // packs stop discharging here (virtual physics)
const DP_STEP = 0.25;          // SOC grid of the DP, %
const DP_WEAR_CT = 1.5;        // per kWh out of the cells
const DP_TERM_PCTL = 0.5;      // energy left at the horizon end is worth this percentile of the horizon's import price x ETA_D
const GSET = [3500, 1750, 10, -1750, -3500]; // grid setpoints the DP may choose (W)
const BASE_GRID_FEE = 13;
const SLOT = 15 * 60 * 1000;

const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour: 'numeric', month: 'numeric', hourCycle: 'h23' });
function gridFee(t) {
    const p = Object.fromEntries(_fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    const mon = +p.month, h = +p.hour;
    return (mon >= 4 && mon <= 9 && h >= 10 && h < 16) ? BASE_GRID_FEE * 0.8 : BASE_GRID_FEE;
}
// Cost of one slot's grid energy (kWh, + = import), ct.
function gridCost(kwh, mp, eff) {
    if (kwh >= 0) return kwh * eff;
    return mp < 0 ? 0 : -Math.min(-kwh, MAX_FEEDIN_W / 4000) * mp;
}
// Battery AC power (kW, + = charge) the Cerbo produces for setpoint G.
function batteryFor(G, pvKw, loadKw, mp) {
    let b = Math.max(-MAX_W / 1000, Math.min(MAX_W / 1000, G / 1000 + pvKw - loadKw));
    if (G > 10) b = Math.max(0, b);
    if (mp < 0) b = Math.max(b, Math.min(MAX_W / 1000, pvKw - loadKw));
    return b;
}

function plan(fc, soc0) {
    const N = Math.round((100 - SOC_MIN) / DP_STEP) + 1, kwhStep = DP_STEP / 100 * CAP_KWH;
    const effs = fc.map(f => f.mp + gridFee(f.t));
    const sorted = [...effs].sort((a, b) => a - b);
    const q = sorted[Math.floor((sorted.length - 1) * DP_TERM_PCTL)] * ETA_D;
    let V = new Float64Array(N);
    for (let i = 0; i < N; i++) V[i] = -q * i * kwhStep;
    let firstV = null;
    const acts = new Array(fc.length);
    for (let k = fc.length - 1; k >= 0; k--) {
        const P = fc[k].P / 1000, L = fc[k].L / 1000, mp = fc[k].mp, eff = effs[k];
        const NV = new Float64Array(N), A = new Int8Array(N);
        for (let i = 0; i < N; i++) {
            let best = Infinity, ba = GSET.indexOf(10);
            for (let a = 0; a < GSET.length; a++) {
                const G = GSET[a];
                let b = batteryFor(G, P, L, mp) / 4;            // kWh AC this slot
                let d = b > 0 ? b * ETA_C : b / ETA_D;          // kWh in the cells
                let x = i + d / kwhStep;
                if (x > N - 1) { x = N - 1; d = (x - i) * kwhStep; b = d / ETA_C; }
                if (x < 0) { x = 0; d = (x - i) * kwhStep; b = d * ETA_D; }
                const x0 = Math.floor(x), x1 = Math.min(N - 1, x0 + 1), w = x - x0;
                const c = gridCost(L / 4 + b - P / 4, mp, eff) + (d < 0 ? -d * DP_WEAR_CT : 0)
                    + V[x0] * (1 - w) + V[x1] * w;
                if (c < best - 1e-9) { best = c; ba = a; }
            }
            NV[i] = best;
            A[i] = ba;
        }
        V = NV;
        acts[k] = A;
        if (k === 0) firstV = V;
    }
    const idx = soc => Math.max(0, Math.min(N - 1, Math.round((soc - SOC_MIN) / DP_STEP)));
    // Forward walk: the plan the policy produces if the forecast comes true.
    const traj = [];
    let soc = soc0;
    for (let k = 0; k < fc.length; k++) {
        const G = GSET[acts[k][idx(soc)]];
        const P = fc[k].P / 1000, L = fc[k].L / 1000;
        let b = batteryFor(G, P, L, fc[k].mp) / 4;
        if (b > 0) b = Math.min(b, (100 - soc) / 100 * CAP_KWH / ETA_C);
        if (b < 0) b = Math.max(b, -(soc - SOC_MIN) / 100 * CAP_KWH * ETA_D);
        soc += (b > 0 ? b * ETA_C : b / ETA_D) / CAP_KWH * 100;
        traj.push({ t: fc[k].t, G, soc });
    }
    return { G: traj[0].G, planCostCt: firstV[idx(soc0)], termCt: q, traj };
}

// ---- inputs ---------------------------------------------------------------
const now = Date.now();
const slotT = Math.floor(now / SLOT) * SLOT;          // the slot starting now
const bms = global.get('bms') || {};
const realSoc = typeof bms.weightedSoc === 'number' ? bms.weightedSoc : null;
let st = flow.get('dpShadow', 'file');
if (msg.topic === 'reset' || !st || typeof st.soc !== 'number') {
    if (realSoc === null) { node.status({ fill: 'red', shape: 'ring', text: 'no BMS SOC to seed from' }); return null; }
    st = { soc: realSoc, since: now, cmd: null, cumSh: 0, cumLive: 0, socRef: realSoc, dcSh: 0, dcLive: 0, slots: 0 };
}

// Mean of the first series' first numeric column, per statement.
function stmtMean(i) {
    const r = Array.isArray(msg.payload) ? msg.payload : (msg.payload && msg.payload.results) || [];
    const res = r[i] && (r[i].series ? r[i] : r[i][0]);
    const s = res && res.series && res.series[0];
    const v = s && s.values && s.values[0] && s.values[0][1];
    return typeof v === 'number' && isFinite(v) ? v : null;
}
const pvW = stmtMean(0), balW = stmtMean(1), batW = stmtMean(2);

// ---- 1. settle the slot that just ended ----------------------------------
let point = null;
if (st.cmd && st.cmd.t === slotT - SLOT && pvW !== null && balW !== null) {
    const c = st.cmd;
    const gridImpW = -balW;                                  // balanceeme: + = export
    const loadW = Math.max(0, pvW + gridImpW - (batW || 0)); // load = PV + grid - battery
    const P = Math.max(0, pvW) / 1000, L = loadW / 1000;
    // virtual battery under the shadow's command, the replay's physics
    let b = batteryFor(c.G, P, L, c.mp);
    if (b > 0) b = Math.min(b, (100 - st.soc) / 100 * CAP_KWH / ETA_C * 4);
    if (b < 0) b = Math.max(b, -(st.soc - SOC_CUTOFF) / 100 * CAP_KWH * ETA_D * 4);
    let grid = L + b - P;
    if (c.mp < 0 && grid < 0) grid = 0;
    grid = Math.max(grid, -MAX_FEEDIN_W / 1000);
    const dcOut = b < 0 ? -b / 4 / ETA_D : 0;
    st.soc += (b > 0 ? b * ETA_C : b / ETA_D) / 4 / CAP_KWH * 100;
    const shCost = gridCost(grid / 4, c.mp, c.eff);
    const liveCost = gridCost(gridImpW / 4000, c.mp, c.eff);
    const liveDc = batW !== null && batW < 0 ? -batW / 4000 / ETA_D : 0;
    st.cumSh += shCost; st.cumLive += liveCost; st.dcSh += dcOut; st.dcLive += liveDc; st.slots++;
    point = {
        measurement: 'dpshadow',
        timestamp: new Date(c.t),
        fields: {
            sh_sp: c.G, sh_state: c.G > 10 ? 1 : c.G < 0 ? 4 : 3,
            sh_soc: Math.round(st.soc * 10) / 10, sh_grid: Math.round(grid * 1000), sh_cost: Math.round(shCost * 100) / 100,
            live_state: c.liveState, live_grid: Math.round(gridImpW), live_cost: Math.round(liveCost * 100) / 100,
            real_soc: realSoc === null ? undefined : Math.round(realSoc * 10) / 10,
            pv: Math.round(pvW), load: Math.round(loadW), mp: c.mp,
            plan_ct: Math.round(c.planCostCt), term_ct: Math.round(c.termCt * 10) / 10,
            sh_dcout: Math.round(dcOut * 1000) / 1000, live_dcout: Math.round(liveDc * 1000) / 1000
        }
    };
    for (const k of Object.keys(point.fields)) if (point.fields[k] === undefined) delete point.fields[k];
}

// ---- 2. plan the current slot --------------------------------------------
const pred = ((global.get('pp', 'file') || {}).prediction || []).filter(s => typeof s.t === 'number' && s.t >= slotT);
let why, planPoints = null;
if (pred.length >= 8 && pred[0].t === slotT) {
    const fc = pred.map(s => ({ t: s.t, P: Math.max(0, s.pvPower || 0), L: Math.max(0, s.loadEst || 0), mp: s.marketPrice }));
    const r = plan(fc, st.soc);
    st.cmd = { t: slotT, G: r.G, mp: fc[0].mp, eff: fc[0].mp + gridFee(slotT), liveState: pred[0].state, planCostCt: r.planCostCt, termCt: r.termCt };
    why = `sp ${r.G}W`;
    planPoints = r.traj.map(x => ({
        measurement: 'batteryplan', timestamp: new Date(x.t),
        fields: { dpState: x.G > 10 ? 1 : x.G < 0 ? 4 : 3, dpPredictedSoc: Math.round(x.soc * 10) / 10 }
    }));
} else {
    // no fresh forecast this slot: hold self-consumption, like a live fallback
    const mp = pred[0] && pred[0].t === slotT ? pred[0].marketPrice : (st.cmd ? st.cmd.mp : 0);
    st.cmd = { t: slotT, G: 10, mp, eff: mp + gridFee(slotT), liveState: null, planCostCt: 0, termCt: 0 };
    why = 'no fresh live forecast, self-consumption';
}
flow.set('dpShadow', st, 'file');

// Totals since the last reset; the SOC difference is valued at 18 ct/kWh, as in the replay.
const socAdj = ((st.soc - st.socRef) - ((realSoc ?? st.socRef) - st.socRef)) / 100 * CAP_KWH * 18;
const gain = (st.cumLive - st.cumSh + socAdj) / 100;
node.status({ fill: 'blue', shape: 'dot',
    text: `${why} | vSOC ${st.soc.toFixed(1)}% | ${st.slots} slots: shadow ${(st.cumSh / 100).toFixed(2)}€ live ${(st.cumLive / 100).toFixed(2)}€ gain ${gain.toFixed(2)}€` });
return [point ? { payload: [point] } : null, planPoints ? { payload: planPoints } : null];
