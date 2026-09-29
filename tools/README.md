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
