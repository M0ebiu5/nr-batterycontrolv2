#!/usr/bin/env node
// Replay the real optimizer slot by slot over a dataset from build-dataset.js.
//
//   node tools/replay.js tools/data/2026-09-01_2026-09-28.json.gz [options]
//     --src FILE          optimizer source (default optimizer_func.js)
//     --set NAME=VALUE    override a top-level `const NAME = ...;` (repeatable),
//                         e.g. --set PV_FORECAST_V2=false --set IDLE_SETPOINT_W=30
//     --label NAME        name in the summary line (default: the --set list)
//     --no-weather        feed the pre-2026-09-29 weather (no sunrise/radiation)
//     --out FILE          write per-slot results as JSON
//
// Each 15-min slot: build the inputs the live flow would have built at that
// moment, run the optimizer, apply the Cerbo setpoint it returns to the slot's
// ACTUAL PV and load, and book the grid energy at that slot's price.
// Fidelity check (2026-09-29): the pre-v2 code replayed Sep 1-28 at -14.09 EUR
// against -14.20 EUR actual.
'use strict';
const fs = require('fs');
const path = require('path');
const { readGz, berlin, SLOT } = require('./lib');

// Battery model, measured 2026-09-22..29 (see memory: round-trip efficiency).
const ETA_C = 0.887, ETA_D = 0.915;
const CAP_KWH = 30;      // SOC scale that matches real BMS SOC drops (not the 28.8 kWh nameplate)
const SOC_CUTOFF = 3;    // the packs stop discharging here
const MAX_W = 3500, MAX_FEEDIN_W = 4900;
const LAT = 48.2, LON = 14.1; // matches the station's sunrise/sunset within minutes

function args() {
    const a = process.argv.slice(2), o = { set: [], weather: true };
    o.data = a.shift();
    while (a.length) {
        const k = a.shift();
        if (k === '--src') o.src = a.shift();
        else if (k === '--set') o.set.push(a.shift());
        else if (k === '--label') o.label = a.shift();
        else if (k === '--no-weather') o.weather = false;
        else if (k === '--out') o.out = a.shift();
        else throw new Error('unknown option ' + k);
    }
    if (!o.data) throw new Error('usage: replay.js DATA.json.gz [--src F] [--set NAME=VALUE]... [--label L] [--no-weather] [--out F]');
    return o;
}

// NOAA sunrise/sunset (good to a few minutes), UTC ms for the day containing ms.
function sunTimes(ms) {
    const d = new Date(ms), day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const n = (day0 - Date.UTC(2000, 0, 1, 12)) / 86400000 + 0.5;
    const rad = Math.PI / 180, Jstar = n - LON / 360;
    const M = (357.5291 + 0.98560028 * Jstar) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lam = (M + C + 180 + 102.9372) % 360;
    const Jt = Jstar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
    const dec = Math.asin(Math.sin(lam * rad) * Math.sin(23.44 * rad));
    const w = Math.acos((Math.sin(-0.833 * rad) - Math.sin(LAT * rad) * Math.sin(dec)) / (Math.cos(LAT * rad) * Math.cos(dec)));
    const noon = Date.UTC(2000, 0, 1, 12) + Jt * 86400000;
    return { rise: noon - w / (2 * Math.PI) * 86400000, set: noon + w / (2 * Math.PI) * 86400000 };
}

function main() {
    const o = args();
    let src = fs.readFileSync(o.src || path.join(__dirname, '..', 'optimizer_func.js'), 'utf8');
    for (const kv of o.set) {
        const [name, value] = kv.split('=');
        const re = new RegExp(`^const ${name} = [^;]*;`, 'm');
        if (!re.test(src)) throw new Error(`--set: no top-level const ${name}`);
        src = src.replace(re, `const ${name} = ${value};`);
    }
    const D = readGz(o.data);
    const byT = new Map(D.slots.map(s => [s.t, s]));
    const price = new Map(D.slots.filter(s => s.mp !== null).map(s => [s.t, s.mp]));
    const priceTimes = [...price.keys()].sort((a, b) => a - b);

    let NOW = 0;
    class FakeDate extends Date {
        constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
        static now() { return NOW; }
    }
    const fn = new Function('msg', 'node', 'flow', 'global', 'Date', src);
    const store = { weather7days: { sun7: [{ value: 0.5 }] } };
    const global = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
    const flow = { get: () => null, set: () => {} };
    const node = { warn: () => {}, status: () => {}, error: () => {}, log: () => {} };

    let soc = byT.get(D.meta.t0).soc;
    if (typeof soc !== 'number') soc = D.slots.find(s => s.t >= D.meta.t0 && typeof s.soc === 'number').soc;
    const soc0 = soc;
    let prevBat = 0;
    const rows = [];
    for (let t = D.meta.t0; t < D.meta.t1; t += SLOT) {
        NOW = t;
        const cur = byT.get(t), prev = byT.get(t - SLOT) || cur, prev2 = byT.get(t - 2 * SLOT) || prev;
        const bt = berlin(t);
        // Prices: the cache holds yesterday+today until the 13:05 fetch, then today+tomorrow.
        const dayStart = t - (bt.h * 60 + bt.m) * 60000;
        const endDate = berlin(dayStart + ((bt.h * 60 + bt.m) >= 13 * 60 + 15 ? 36 : 12) * 3600000).date;
        const prices = priceTimes.filter(pt => pt >= dayStart - 86400000 && pt < dayStart + 2 * 86400000 + 3 * 3600000 && berlin(pt).date <= endDate)
            .map(pt => ({ time: pt, marketprice: price.get(pt) }));
        // Load history: the live query reads infra (48 h retention), hourly means.
        const load_history = [];
        for (let h = Math.floor((t - 48 * 3600000) / 3600000) * 3600000; h < t - 3600000; h += 3600000) {
            const v = [0, 1, 2, 3].map(k => byT.get(h + k * SLOT)).filter(Boolean).map(s => s.load);
            if (v.length) load_history.push({ time: h, avg_pv: undefined, avg_load: v.reduce((a, b) => a + b, 0) / v.length });
        }
        const inWin = (x, a, b) => x.time > t - a * 86400000 && x.time < t - b * 86400000;
        const pv_history = D.pvh.filter(r => r.time < t - 3600000 && (inWin(r, 15, 0) || inWin(r, 380, 350) || inWin(r, 745, 715)));
        let weather = { temp: 15, humidity: 50, solarradiation: 0, rainrate: 0 };
        if (o.weather) {
            const st = sunTimes(t), w = D.wx[t - SLOT] || [];
            weather = { temp: 15, humidity: 50, solarradiation: w[0] || 0, rainrate: w[1] || 0,
                sunRise: new Date(st.rise).toISOString(), sunSet: new Date(st.set).toISOString() };
        }
        const msg = {
            payload: {
                soc: [{ time: t, soc, socSource: 'bms', maxCellV: soc >= 98 ? 3.52 : 3.40, minCellV: 3.30 }],
                acload: [{ time: t - 60000, acload: prev.load }],
                power: [{ time: t - 60000, power: prevBat }],
                pv_now: [{ time: t, pv_now: (prev.pv + prev2.pv) / 2 }],
                prices, solar: D.sun.filter(r => r.time >= t - 3600000),
                load_history, pv_history
            },
            weather
        };
        store.bms = { weightedSoc: soc, ts: t, banks: 3, maxCellV: msg.payload.soc[0].maxCellV, minCellV: 3.30 };
        const out = fn(msg, node, flow, global, FakeDate);
        const cmd = out[2].payload, cb = cmd.cerbo;
        // Physics: the Cerbo holds the grid at the setpoint, within battery limits.
        const P = cur.pv, L = cur.load, mp = cur.mp;
        let b = Math.max(-MAX_W, Math.min(MAX_W, cb.AcPowerSetPoint.value + P - L));
        if (cb.MaxDischargePower.value === 0) b = Math.max(0, b);
        if (b > 0) b = Math.min(b, (100 - soc) / 100 * CAP_KWH / ETA_C / 0.25 * 1000);
        if (b < 0) b = Math.max(b, -(soc - SOC_CUTOFF) / 100 * CAP_KWH * ETA_D / 0.25 * 1000);
        let grid = L + b - P, curtail = 0;
        if (grid < -MAX_FEEDIN_W) { curtail += -MAX_FEEDIN_W - grid; grid = -MAX_FEEDIN_W; }
        if (cb.PreventFeedback.value === 1 && grid < 0) { curtail += -grid; grid = 0; }
        soc += (b > 0 ? b * ETA_C : b / ETA_D) * 0.25 / 1000 / CAP_KWH * 100;
        prevBat = b;
        const fee = (bt.mon >= 4 && bt.mon <= 9 && bt.h >= 10 && bt.h < 16) ? 10.4 : 13;
        rows.push({ t, date: bt.date, h: bt.h, state: cmd.state, mp, eff: mp + fee, P, L, b: Math.round(b), grid: Math.round(grid),
            soc: Math.round(soc * 10) / 10, imp: Math.max(grid, 0) / 4000, exp: Math.max(-grid, 0) / 4000, curtail: Math.round(curtail) });
    }
    const sum = f => rows.reduce((a, r) => a + f(r), 0);
    const cost = sum(r => r.imp * r.eff - r.exp * r.mp) / 100;
    const adj = cost - (soc - soc0) / 100 * CAP_KWH * 0.18; // stored energy valued at 18 ct
    const days = {};
    rows.forEach(r => { days[r.date] = Math.min(days[r.date] ?? 100, r.soc); });
    const lows = Object.values(days);
    console.log(`${(o.label || o.set.join(' ') || 'as-is').padEnd(30)} net EUR ${cost.toFixed(2)}  SOC-adj EUR ${adj.toFixed(2)}`
        + `  SOC ${soc0.toFixed(1)}->${soc.toFixed(1)}%  imp ${sum(r => r.imp).toFixed(0)} exp ${sum(r => r.exp).toFixed(0)} kWh`
        + `  feed-in slots ${rows.filter(r => r.state === 4).length}  charge slots ${rows.filter(r => r.state === 1).length}`
        + `  min SOC ${Math.min(...lows).toFixed(1)}%  days<10% ${lows.filter(x => x < 10).length}`);
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(rows));
}
try { main(); } catch (e) { console.error(e.message); process.exit(1); }
