// Test harness for optimizer_func.js
// Simulates Node-RED environment and runs the optimizer

const fs = require('fs');

// Mock Node-RED node
const warnings = [];
const node = {
    warn: (msg) => { warnings.push(msg); console.log('WARN:', msg); },
    status: () => {}
};

// --- Test scenario: afternoon run, prices until midnight ---
// Simulates April 8, 14:00 Berlin time, SOC 55%, sunny day

// Fixed "now" = April 8, 2026 14:00 Berlin (12:00 UTC)
const NOW = new Date('2026-04-08T12:00:00Z').getTime();

const weather = {
    sunRise: '2026-04-08T06:15:00+02:00',
    sunSet: '2026-04-08T20:00:00+02:00',
    temp: 15,
    humidity: 50,
    solarradiation: 600,
    rainrate: 0
};

// Price data: 15-min slots from 14:00 to 23:45 Berlin time (April 8)
const priceByHour = {
    14: -2, 15: 0, 16: 5, 17: 10, 18: 14, 19: 16,
    20: 15, 21: 13, 22: 10, 23: 9
};
const prices = [];
for (let h = 14; h <= 23; h++) {
    for (let q = 0; q < 4; q++) {
        const t = new Date(`2026-04-08T${String(h).padStart(2,'0')}:${String(q*15).padStart(2,'0')}:00+02:00`).getTime();
        prices.push({ time: t, marketprice: priceByHour[h] + (q * 0.3) });
    }
}

// PV history: same period from previous years (~April in infra_2y)
const pvHistory = [];
for (let year = 2024; year <= 2025; year++) {
    for (let day = 24; day <= 30; day++) { // late March
        for (let h = 6; h <= 19; h++) {
            const peakFactor = Math.sin(Math.PI * (h - 5) / 14);
            const avgPv = 4000 * peakFactor * (0.8 + Math.random() * 0.2);
            pvHistory.push({
                time: new Date(`${year}-03-${String(day).padStart(2,'0')}T${String(h).padStart(2,'0')}:00:00+02:00`).getTime(),
                avg_pv: avgPv > 100 ? avgPv : null,
                max_pv: avgPv > 100 ? avgPv * 1.1 : null
            });
        }
    }
    for (let day = 1; day <= 20; day++) { // April
        for (let h = 6; h <= 19; h++) {
            const peakFactor = Math.sin(Math.PI * (h - 5) / 14);
            const avgPv = 4200 * peakFactor * (0.8 + Math.random() * 0.2);
            pvHistory.push({
                time: new Date(`${year}-04-${String(day).padStart(2,'0')}T${String(h).padStart(2,'0')}:00:00+02:00`).getTime(),
                avg_pv: avgPv > 100 ? avgPv : null,
                max_pv: avgPv > 100 ? avgPv * 1.1 : null
            });
        }
    }
}

// Solar forecast (sunshine minutes)
const solarForecast = [];
for (let h = 6; h <= 19; h++) {
    solarForecast.push({
        time: new Date(`2026-04-08T${String(h).padStart(2,'0')}:00:00+02:00`).getTime(),
        sunshineDurationInMinutes: h >= 9 && h <= 16 ? 45 : 20
    });
}

// Load history (24h)
const loadHistory = [];
for (let h = 0; h < 24; h++) {
    const load = h >= 17 && h <= 22 ? 1000 : 600;
    loadHistory.push({
        time: new Date(`2026-04-08T${String(h).padStart(2,'0')}:00:00+02:00`).getTime(),
        avg_load: load
    });
}

const msg = {
    payload: {
        soc: [{ time: NOW, soc: 55 }],
        acload: [{ time: NOW, acload: 700 }],
        power: [{ time: NOW, power: -500 }],
        prices: prices,
        solar: solarForecast,
        load_history: loadHistory,
        pv_history: pvHistory,
        pv_now: [{ time: NOW, pv_now: 3200 }]
    },
    weather: weather
};

// Override Date.now() to use fixed time
const origDateNow = Date.now;
Date.now = () => NOW;

// Read and execute optimizer
let code = fs.readFileSync(__dirname + '/optimizer_func.js', 'utf8');

const wrappedCode = `
(function(msg, node, flow, global) {
    ${code}
})
`;

try {
    const fn = eval(wrappedCode);
    const flow = { get: () => null, set: () => {} };
    const global = { get: () => null };
    const result = fn(msg, node, flow, global);

    if (!result) {
        console.log('ERROR: No result returned');
        process.exit(1);
    }

    const [msg1, msg2, msg3] = result;
    const schedule = msg1.payload;

    console.log(`\n=== Schedule (${schedule.length} slots) ===\n`);
    for (const s of schedule) {
        const marker = s.state === 4 ? '>>>' : s.state === 1 ? '<<<' : '   ';
        console.log(`${marker} ${s.timeStr} | st=${s.state} | soc=${s.predictedSoc}% | pv=${s.pvPower}W | load=${s.loadEst}W | price=${s.marketPrice.toFixed(1)}ct | ${s.reason}`);
    }

    const lastSlot = schedule[schedule.length - 1];
    console.log(`\n=== Results ===`);
    console.log(`End SOC: ${lastSlot.predictedSoc}%`);
    console.log(`Feed-in slots: ${schedule.filter(s => s.state === 4).length}`);
    console.log(`Charge slots: ${schedule.filter(s => s.state === 1).length}`);

    // Overnight need: ~6.25h * 700W avg = 4.375 kWh = 14.6% + 3% min + 5% margin = ~23%
    const overnightSoc = 27; // conservative floor for end-of-schedule SOC
    console.log(`Overnight floor: ${overnightSoc}% SOC`);
    console.log(`Margin: ${(lastSlot.predictedSoc - overnightSoc).toFixed(1)}%`);

    // Verify feed-in pricing
    const feedins = schedule.filter(s => s.state === 4 && s.reason.includes('feed-in'));
    const comps = schedule.filter(s => s.state === 3 && s.pvPower === 0);
    if (feedins.length > 0 && comps.length > 0) {
        const minFi = Math.min(...feedins.map(s => s.marketPrice));
        const maxComp = Math.max(...comps.map(s => s.marketPrice));
        if (minFi < maxComp) {
            console.log(`\n*** PRICING BUG: feed-in at ${minFi.toFixed(1)}ct, compensate at ${maxComp.toFixed(1)}ct ***`);
        } else {
            console.log(`\nPricing OK: cheapest feed-in ${minFi.toFixed(1)}ct >= most expensive compensate ${maxComp.toFixed(1)}ct`);
        }
    }

    if (lastSlot.predictedSoc < overnightSoc) {
        console.log(`\n*** FAIL: End SOC ${lastSlot.predictedSoc}% < overnight need ${overnightSoc.toFixed(1)}% ***`);
        process.exit(1);
    } else {
        console.log(`\n*** PASS ***`);
    }
} catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
} finally {
    Date.now = origDateNow;
}
