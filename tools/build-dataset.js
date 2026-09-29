#!/usr/bin/env node
// Build a clean 15-min dataset from InfluxDB for analysis and replays.
//
//   node tools/build-dataset.js 2026-09-01 2026-09-28 [out.json.gz]
//
// Dates are Berlin local days, inclusive. One extra day past the end is pulled
// so a replay of the last day still sees tomorrow's prices. Output (gzipped JSON,
// default tools/data/<from>_<to>.json.gz):
//   slots[]  t, pv, load, grid (+import W), bat (+charge W), soc (%), mp (ct), state
//   sun[]    {time, sunshineDurationInMinutes}  sunshine the optimizer saw
//   pvh[]    {time, avg_pv, max_pv}  hourly PV history back 746 days (optimizer baseline input)
//   wx{}     slot t -> [solar W/m2, rain rate]  weather station
//
// Sources, best first (the long-term ones are all in infra_2y):
//   actuals  infra_2y ess (mean_pac/mean_acload/mean_Power), pv, power device=balanceeme
//   soc/mp/state/sun  infra_2y optrun (logged by the flow since 2026-09-29), then
//            forecast.batteryplan and forecast.forecastnew (30-day retention),
//            then tmp.ess socbms (7-day retention)
'use strict';
const fs = require('fs');
const path = require('path');
const { query, berlin, berlinMidnight, writeGz, SLOT } = require('./lib');

async function main() {
    const [from, to, outArg] = process.argv.slice(2);
    if (!from || !to) { console.error('usage: build-dataset.js FROM TO [out.json.gz]  (Berlin dates)'); process.exit(2); }
    const t0 = berlinMidnight(from);
    const t1 = berlinMidnight(new Date(Date.parse(to + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10));
    const tEnd = t1 + 86400000;                        // +1 day for tomorrow's prices
    const range = (a, b) => `time >= ${a}ms AND time < ${b}ms`;
    const W = range(t0 - 2 * 86400000, tEnd);          // 2 days before: replay load history

    const [ess, pv15, grid, optrun, plan, sunF, socT, pvh, wx] = await Promise.all([
        query('infra_2y', `SELECT mean_pac, mean_acload, mean_Power FROM two_years.ess WHERE ${W}`),
        query('infra_2y', `SELECT mean(mean_PAC) AS pv FROM two_years.pv WHERE ${W} GROUP BY time(15m)`),
        query('infra_2y', `SELECT mean(mean_val) AS bal FROM two_years.power WHERE device = 'balanceeme' AND ${W} GROUP BY time(15m)`),
        query('infra_2y', `SELECT soc, mp, state, sun_min FROM optrun WHERE ${W}`),
        query('forecast', `SELECT predictedSoc, marketPrice, state FROM batteryplan WHERE ${W}`),
        query('forecast', `SELECT sunshineDurationInMinutes FROM forecastnew WHERE period = 'PT1H' AND ${W}`),
        query('tmp', `SELECT mean(socbms) AS soc FROM ess WHERE ${W} GROUP BY time(15m)`),
        query('infra_2y', `SELECT mean(mean_PAC) AS avg_pv, max(mean_PAC) AS max_pv FROM two_years.pv WHERE ${range(t0 - 746 * 86400000, tEnd)} GROUP BY time(1h)`),
        query('infra_2y', `SELECT mean(mean_solar) AS solar, max(mean_rain_rate) AS rain FROM two_years.ws2900 WHERE ${W} GROUP BY time(15m)`)
    ]);
    const by = (rows) => new Map(rows.map(r => [r.time, r]));
    const E = by(ess), P = by(pv15), G = by(grid), O = by(optrun), B = by(plan), S = by(socT), X = by(wx);

    const slots = [];
    const last = { pac: null, load: null, bat: null };
    const hourLoads = Array.from({ length: 24 }, () => []);
    for (let t = t0 - 2 * 86400000; t < tEnd; t += SLOT) {
        const e = E.get(t) || {};
        // ess fields are written on change, so a missing 15-min row means "unchanged".
        for (const [k, f] of [['load', 'mean_acload'], ['bat', 'mean_Power']]) {
            if (e[f] !== null && e[f] !== undefined) last[k] = { v: e[f], t };
            else if (last[k] && t - last[k].t > 8 * SLOT) last[k] = null;
        }
        const pvv = e.mean_pac ?? (P.get(t) || {}).pv ?? 0;
        const bal = (G.get(t) || {}).bal;
        const bat = last.bat ? last.bat.v : null;
        let load = last.load ? last.load.v : null;
        const gridW = (bal === null || bal === undefined) ? null : -bal;
        if (load === null && gridW !== null && bat !== null) load = pvv + gridW - bat;
        if (load !== null && load > 10000) load = null;  // Shelly wedge: PV booked as load
        const o = O.get(t) || {}, b = B.get(t) || {};
        const s = {
            t, pv: Math.round(pvv), load: load === null ? null : Math.round(load),
            grid: gridW === null ? null : Math.round(gridW), bat: bat === null ? null : Math.round(bat),
            soc: o.soc ?? b.predictedSoc ?? (S.get(t) || {}).soc ?? null,
            mp: o.mp ?? b.marketPrice ?? null,
            state: o.state ?? b.state ?? null
        };
        if (s.load !== null) hourLoads[berlin(t).h].push(s.load);
        slots.push(s);
    }
    // Remaining load holes: that hour's median across the range.
    const med = hourLoads.map(v => { const a = [...v].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 700; });
    let filled = 0;
    for (const s of slots) if (s.load === null) { s.load = med[berlin(s.t).h]; filled++; }
    // Price holes (short outages): carry the previous slot.
    let prevMp = null;
    for (const s of slots) { if (s.mp === null) s.mp = prevMp; else prevMp = s.mp; }

    // Sunshine as the optimizer saw it: optrun per slot where logged, else forecastnew.
    const sun = [];
    const sunSeen = new Set();
    for (const r of optrun) if (typeof r.sun_min === 'number') { sun.push({ time: r.time, sunshineDurationInMinutes: r.sun_min }); sunSeen.add(r.time - (r.time % 3600000)); }
    for (const r of sunF) if (typeof r.sunshineDurationInMinutes === 'number' && !sunSeen.has(r.time)) sun.push({ time: r.time, sunshineDurationInMinutes: r.sunshineDurationInMinutes });
    sun.sort((a, b) => a.time - b.time);

    const wxOut = {};
    for (const [t, r] of X) wxOut[t] = [r.solar === null ? null : Math.round(r.solar), r.rain];

    const data = {
        meta: {
            from, to, t0, t1, built: new Date().toISOString(),
            counts: { slots: slots.length, optrun: optrun.length, batteryplan: plan.length, sun: sun.length, pvh: pvh.length, wx: X.size, loadFilled: filled },
            missing: {
                soc: slots.filter(s => s.t >= t0 && s.t < t1 && s.soc === null).length,
                mp: slots.filter(s => s.t >= t0 && s.t < tEnd && s.mp === null).length,
                grid: slots.filter(s => s.t >= t0 && s.t < t1 && s.grid === null).length
            }
        },
        slots, sun,
        pvh: pvh.filter(r => r.avg_pv !== null).map(r => ({ time: r.time, avg_pv: r.avg_pv, max_pv: r.max_pv })),
        wx: wxOut
    };
    const out = outArg || path.join(__dirname, 'data', `${from}_${to}.json.gz`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    writeGz(out, data);
    console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    console.log(JSON.stringify(data.meta.counts), 'missing in range:', JSON.stringify(data.meta.missing));
}
main().catch(e => { console.error(e.message); process.exit(1); });
