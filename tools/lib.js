// Shared helpers for the dataset builder and the replay (no dependencies).
'use strict';
const zlib = require('zlib');
const fs = require('fs');

const INFLUX = process.env.INFLUX_URL || 'http://192.168.4.221:8076';
const AUTH = 'Basic ' + Buffer.from(process.env.INFLUX_AUTH || 'admin:admin').toString('base64');
const SLOT = 15 * 60 * 1000;

// InfluxQL query -> array of row objects ({time: ms, <field>: number|string|null, tags...}).
async function query(db, q) {
    const url = `${INFLUX}/query?db=${encodeURIComponent(db)}&epoch=ms&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    if (!res.ok) throw new Error(`${db}: HTTP ${res.status} for ${q}`);
    const body = await res.json();
    const rows = [];
    for (const r of body.results || []) {
        if (r.error) throw new Error(`${db}: ${r.error} for ${q}`);
        for (const s of r.series || []) {
            for (const v of s.values) {
                const row = Object.assign({}, s.tags || {});
                s.columns.forEach((c, i) => { row[c] = v[i]; });
                rows.push(row);
            }
        }
    }
    return rows;
}

const berlinFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
// {date: 'YYYY-MM-DD', h, m, mon} in Berlin local time.
function berlin(ms) {
    const p = Object.fromEntries(berlinFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute, mon: +p.month };
}
// UTC ms of Berlin midnight starting the given local date.
function berlinMidnight(date) {
    let t = Date.parse(date + 'T00:00:00Z') - 2 * 3600000;
    while (berlin(t).date !== date || berlin(t).h !== 0) t += 3600000;
    return t;
}

// Leistungspreis (Austrian grid tariff from 2027, SNE-G-V 2026): each calendar month
// bills its highest 15-min average grid IMPORT in kW, at least LP_MIN_KW. rows need
// t (ms) and grid (W, + = import, the slot mean). A month the data covers only part of
// is pro-rated by its share of slots, so partial-month replays stay comparable.
// eurPerKwYear: E-Control's final-stage model value is 33.82 (up to 10 kW; above
// 10 kW it doubles, not modelled: the 3.5 kW inverter keeps us far below).
const LP_MIN_KW = 2;
function peakCharge(rows, eurPerKwYear) {
    const m = {};
    for (const r of rows) {
        const b = berlin(r.t), k = b.date.slice(0, 7);
        const e = m[k] || (m[k] = { month: k, peakKw: 0, at: null, n: 0 });
        e.n++;
        if (r.grid / 1000 > e.peakKw) { e.peakKw = r.grid / 1000; e.at = b.date.slice(5) + ' ' + String(b.h).padStart(2, '0') + ':' + String(b.m).padStart(2, '0'); }
    }
    let eur = 0;
    const months = Object.values(m).map(e => {
        const [y, mo] = e.month.split('-').map(Number);
        const frac = e.n / (new Date(Date.UTC(y, mo, 0)).getUTCDate() * 96);
        const billedKw = Math.max(e.peakKw, LP_MIN_KW);
        const cost = billedKw * eurPerKwYear / 12 * frac;
        eur += cost;
        return Object.assign(e, { billedKw, frac, eur: cost });
    });
    return { months, eur };
}
function fmtPeaks(pc) {
    return pc.months.map(e => `${e.month} ${e.peakKw.toFixed(2)}kW@${e.at}`).join(', ');
}

function writeGz(path, obj) { fs.writeFileSync(path, zlib.gzipSync(JSON.stringify(obj))); }
function readGz(path) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path))); }

module.exports = { query, berlin, berlinMidnight, writeGz, readGz, peakCharge, fmtPeaks, SLOT };
