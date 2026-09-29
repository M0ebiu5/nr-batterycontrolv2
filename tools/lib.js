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

function writeGz(path, obj) { fs.writeFileSync(path, zlib.gzipSync(JSON.stringify(obj))); }
function readGz(path) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path))); }

module.exports = { query, berlin, berlinMidnight, writeGz, readGz, SLOT };
