# Analysis and replay tools

Nothing here runs in production. Both scripts are plain Node (22+), no dependencies.

## 1. Build a dataset

```sh
node tools/build-dataset.js 2026-09-01 2026-09-28        # Berlin dates, inclusive
# -> tools/data/2026-09-01_2026-09-28.json.gz  (~180 KB per 4 weeks, ~0.5 s)
```

It runs nine InfluxDB queries (`192.168.4.221:8076`; override with `INFLUX_URL`, `INFLUX_AUTH`) and produces one 15-min table plus the optimizer's side inputs:

| key | content | source (best first) |
|---|---|---|
| `slots[]` | `t, pv, load, grid` (+import W), `bat` (+charge W), `soc`, `mp` (ct), `state` | actuals: `infra_2y` ess/pv/power (`balanceeme`); soc/mp/state: `infra_2y.optrun` → `forecast.batteryplan` → `tmp.ess` |
| `sun[]` | sunshine minutes the optimizer saw | `infra_2y.optrun.sun_min` → `forecast.forecastnew` |
| `pvh[]` | hourly PV mean/max back 746 days | `infra_2y.pv` |
| `wx{}` | station solar W/m² and rain rate per slot | `infra_2y.ws2900` |

Before 2026-09-29 the price, SOC, state and sunshine exist only in the 30-day
`forecast` and 7-day `tmp` databases. From 2026-09-29 the flow logs them into
`infra_2y` (see below), so any period after that can be rebuilt later.

Cleaning: ESS fields are written on change, so a missing row carries the last
value for up to 2 h. Load above 10 kW (the Shelly wedge, PV booked as load)
and remaining holes use that hour's median.

## 2. Replay

```sh
D=tools/data/2026-09-01_2026-09-28.json.gz
node tools/replay.js $D                                      # optimizer_func.js as it is
node tools/replay.js $D --set PV_FORECAST_V2=false           # flip any top-level const
node tools/replay.js $D --src <(git show bf15946~1:optimizer_func.js) --no-weather --label old
node tools/replay.js $D --out /tmp/slots.json                # per-slot results
```

Each 15-min slot, the replay:
1. builds the inputs the live flow would have had at that moment (prices as the
   13:05 fetch had them, 48 h load history, PV history, weather, sunrise/sunset);
2. runs the real optimizer;
3. applies the Cerbo setpoint it returns to the slot's actual PV and load;
4. books the grid energy at that slot's price (import = market + grid fee,
   export = market).

Battery model: 0.887 in, 0.915 out (measured), a 30 kWh SOC scale (matches
real BMS SOC drops), discharge stops at 3%. It takes ~45 s per month; start
variants in parallel (`&`).

**Compare `SOC-adj` across variants.** It values the end-SOC difference at
18 ct/kWh.

Leistungspreis (Austrian grid tariff from 2027): `LP EUR` bills each calendar
month's highest 15-min grid import, at least 2 kW, at `--lp` EUR per kW and year
(default 33.82, E-Control's final-stage model; about 19 at the start stage;
`--lp 0` turns it off). Partial months are pro-rated. `SOC-adj+LP` (replay.js)
and `costInclWearLP` (replay-dp.js) add it, and the `peaks` line shows each
month's peak and when it happened. The Netz OÖ amounts and start date come with
the SNE-T-V (due December 2026).

Fidelity: the pre-2026-09-29 optimizer replays September at -14.00 EUR net
against -14.20 EUR actual.

Caveat: sunshine for past hours is the last forecast written, which is closer
to observed than a real day-ahead forecast. Forecast-driven gains replay
somewhat optimistic; `optforecast` below gives the true day-ahead error for
dates from 2026-09-30.

## 3. What the flow logs for this (since 2026-09-29)

The `to optlog points` → `write_optlog` nodes write to `infra_2y` (default RP,
~5 years). They use only the optimizer's own output, with no extra queries,
at about 1-2 MB/year.

- `optrun`: one row per slot. Fields: `state, sp` (setpoint W), `soc, mp,
  pv_fc, load_fc, sun_min, pv_tom_kwh, sunpoor, satwall`, and `reason` (short
  code such as `compensate-load` or `planned-feed-in-at`).
- `optforecast` (tag `lead=d1`): tomorrow's hourly plan, taken once a day at
  the first run from 19:00 Berlin. Fields: `pv, load, soc, mp, feed, charge`.

Handy queries (`db=infra_2y`):

```sql
-- day-ahead PV forecast vs actual, per day
SELECT sum(pv)/1000 FROM optforecast WHERE lead='d1' AND time > now()-30d GROUP BY time(1d,-2h)
SELECT sum(mean_PAC)/4000 FROM two_years.pv WHERE time > now()-30d GROUP BY time(1d,-2h)
-- how often each decision path fired
SELECT count(state) FROM optrun WHERE time > now()-30d GROUP BY reason
```

## 3. DP comparison

`tools/replay-dp.js` runs the same replay with a dynamic-programming planner in place of
the optimizer (see its header). 2026-10-17, cost + wear, SOC-adjusted:

| | Sep 1-28 | Sep 20 - Oct 15 | lowest SOC |
|---|---|---|---|
| live optimizer (`--policy opt`) | -8.74 EUR | -5.64 EUR | 3% |
| `--policy dpg` (median end value) | -17.18 EUR | -7.12 EUR | 16% |
| `--policy dpg --perfect` gap | about 1-3 EUR/month more | | |

The `dpg` planner runs live as a shadow on the "Battery DP Shadow" tab
(`battery_dp_shadow.json`, `dp_shadow_func.js`) and logs to `infra_2y.dpshadow`.

### Import-capped charging (Leistungspreis), 2026-10-18

`GSET=<cap>,<cap/2>,10,-1750,-3500 node tools/replay-dp.js D --policy dpg --no-pin`
on Sep 1 - Oct 16 (costInclWear + LP, EUR; LP at 33.82 / 19 EUR per kW-year):

| charge setpoints | peak Sep/Oct kW | at 33.82 | at 19 |
|---|---|---|---|
| 3500, discharge pinned (live) | 3.50 / 4.93 | +3.85 | -3.62 |
| 3500 no-pin | 3.50 / 3.50 | +1.31 | -5.24 |
| 3000 no-pin | 3.00 / 3.00 | +0.38 | -5.24 |
| 2500 no-pin | 2.50 / 2.50 | -1.99 | -6.68 |
| 2000 no-pin | 2.00 / 2.00 | **-3.36** | **-7.10** |
| 1500 no-pin | 1.50 / 1.82 | -2.50 | -6.24 |

Autumn only; winter (more grid charging) is not in the data yet.

### Morning-PV fog corrections, 2026-10-20

`tools/data/2026-09-21_2026-10-19.json.gz`, `--policy dpg`, costInclWear (EUR, lower is better):

| variant | EUR | vs current |
|---|---|---|
| current DP (forecast as is) | 1.12 | |
| `--pv-am-adapt 7` (last 7 mornings' actual/forecast) | 1.67 | +0.55 |
| `--scen 0.35,0.25` (hedge, 35 % fog at 25 % PV) | 2.79 | +1.67 |
| `--pv-am 0.66` | 2.90 | +1.78 |
| `--scen 0.5,0.25` | 3.51 | +2.39 |
| `--pv-am 0.5` | 3.90 | +2.78 |

Every correction loses: a kWh bought at night reaches the morning at
(mp + 13 ct fee) / 0.81, so storing only beats buying in the morning above ~27 ct,
and on the sunny mornings the pessimistic plan bought energy PV would have supplied.
Recheck when the per-kWh grid fee drops (2027) or in winter with higher morning peaks.

### Gas heat credit for battery losses, 2026-10-20

The packs and inverter are indoors, and the house is heated with gas, so in
Oct-Apr the conversion losses replace gas heat. `--heat-ct 10.4` = Grünwelt
4.00 ct net + Netz OÖ 2.2339 ct net (2026, zone 1) + Erdgasabgabe/CO2 1.91 ct
gross, all +20 % VAT = 9.4 ct/kWh gas, / 0.9 condensing boiler. Same dataset,
costInclWear incl. the credit (EUR):

| variant | EUR | end SOC |
|---|---|---|
| current DP (credit in accounting only) | -3.80 | 31 % |
| `--heat-plan` (DP plans with the credit) | -3.35 | 63 % |
| `--heat-plan --scen 0.35,0.25` | -1.65 | 65 % |
| `--heat-plan --pv-am 0.66` | -1.12 | 70 % |

The losses already earn 4.91 EUR of heat in Oct 1-19 (~47 kWh). Planning with
the credit is a tie within the end-SOC valuation (18 ct/kWh; at 25 ct the
heat-aware DP would come out ~0.2 EUR ahead); the fog variants still lose.
Only 19 heating days: rerun on Nov-Jan data.
