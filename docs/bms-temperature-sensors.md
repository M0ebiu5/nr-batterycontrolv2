# Reading the BMS temperature sensors

How to read the temperature sensors of the three battery banks (`bat_ost`, `bat_west`, `bat_big`).
Found while working in the sibling project `checkbattery` (2026-10-01).

## MQTT topics

Broker: `192.168.4.221:1883` (Node-RED config node `mqtt_broker_config`). Authentication is required (user `max`; the password is stored in the Node-RED broker config's Security tab — not recorded here).

Each bank publishes one value per subtopic (plain numeric string, °C):

| Topic | Meaning |
|---|---|
| `<bank>/temperatures/1` | Cell temperature sensor 1 |
| `<bank>/temperatures/2` | Cell temperature sensor 2 |
| `<bank>/temperatures/3`, `/4` | Not fitted — always `0.0`, ignore |
| `<bank>/mosfet_status/temperature` | MOSFET (BMS power stage) temperature |

`<bank>` is one of `bat_ost`, `bat_west`, `bat_big`.

Snapshot 2026-10-01 for reference:

| Bank | T1 | T2 | MOSFET |
|---|---|---|---|
| bat_ost | 29.2 | 28.75 | 34.7 |
| bat_west | 28.05 | 28.5 | 33.65 |
| bat_big | 26.1 | 25.45 | 29.85 |

## Alert thresholds used by checkbattery

From the `evaluate` / `publish per-bank state` function nodes:

- Cell sensors: alert if `< -10 °C` or `> 50 °C`
- MOSFET: alert if `> 60 °C`

## Battery temperature guard (stops the battery)

Added 2026-10-01 because the packs sit inside the house. The `checkbattery` alerts above only report; this guard **stops charging and discharging**.

The `temperature guard` function node (`cb_tempguard`, checkbattery tab) runs every 30 s on `bms_state`. A bank's cell temperature is the **higher of its two sensors**: the sensors are allowed to differ.

| Check | Warning (phone push only) | Trip (battery stops) |
|---|---|---|
| Bank cells | ≥ 42 °C or ≤ 1 °C | > 43 °C or ≤ 0 °C |
| MOSFET | ≥ 59 °C | > 60 °C |
| Bank cells rising | — | ≥ 4 °C within 10 min |
| Both cell sensors of a bank unreadable | — | trip |
| Any sensor silent for 10 min | — | hold until readings return |

- **Temperature trips latch.** They stay active until someone presses *Reset battery temperature trip* on the Batteries dashboard (or the `reset temp trip` inject). A reset is refused while the fault is still present. After a reset, normal operation resumes with the next optimizer run (within 15 min).
- **A silent sensor** holds the battery only while the readings are missing, and releases it on its own.
- **Warnings** fire once per bank or MOSFET. They re-arm after the reading drops another 0.5 °C. No warnings are sent while the guard is tripped.

**How the battery is stopped.** The guard writes `global.batteryTempGuard` (file store, so it survives a restart). `Cerbo ESS Control` on the Battery Controller v2 tab then overrides the optimizer with `MaxChargePower=0`, `MaxDischargePower=0` and `AcPowerSetPoint=10`. A link node applies this immediately, and the settings are re-sent every 5 min. The same hold applies if the guard itself stops reporting for 5 min. Grid and PV keep supplying the house. The pack BMSes' own over-temperature protection remains the hardware backstop.

**Notifications.**

- **Phone, voice and the other instance.** The guard publishes MQTT `checkbattery/tempguard` (not retained). The Home Assistant automation *Battery temperature guard notify* reacts to it:
  - It sends a phone push to `notify.mobile_app_vog_l29` and `notify.mobile_app_vog_l29_p30` for trips, clears, refused resets and warnings.
  - On a temperature trip only, it also announces on the speakers appliancecontrol uses: `notify.alexa_media_kinderzimmer_marlon` (the kitchen Echo; Amazon's room names are swapped), `notify.alexa_media_technik`, and `tts.speak` to the VACA tablet.
- **`red/status/alarm`** (retained) is read by the other Node-RED instance, in appliancecontrol's message format:
  ```json
  {"state":"tripped","reason":"temperature","device":"battery","tripped_at":"2026-10-01T12:20:16+02:00",
   "details":["bat_ost cells 43.5 °C > 43 °C"],
   "voicetext":"Hausbatterie ist wegen einer Temperaturstörung abgeschaltet, bitte prüfen",
   "text":"Hausbatterie ist wegen einer Temperaturstörung abgeschaltet, bitte prüfen"}
  ```
  - `reason` is `temperature`, `no_readings` or `reset_refused`.
  - The reader requires `text`, and there must be **no** `novoice` field.
  - A clear deletes the retained alarm with an empty payload.
- **Announced twice on purpose.** A trip is announced both by Home Assistant and by the other instance. This redundancy is intentional.

## Option 1 — Node-RED context (no MQTT auth needed)

The checkbattery flow (tab `8a7a85d30c1477cc`) keeps the latest value of every subtopic in flow context `bms_state`:

```sh
curl -s http://localhost:1880/context/flow/8a7a85d30c1477cc/bms_state
```

Structure: `{ "<bank>": { "temperatures/1": { "value": "29.2", "_ts": <ms> }, ... } }`.
Values are strings — `parseFloat` them. `_ts` shows freshness.
Note: `global.bms` does **not** contain temperatures, only aggregates.

## Option 2 — mosquitto_sub

```sh
mosquitto_sub -h 192.168.4.221 -u max -P '<password>' \
  -t 'bat_+/temperatures/#' -t 'bat_+/mosfet_status/temperature' -v -C 15
```

On this Mac, `~/.config/mosquitto_sub` (mode 600) already holds `-h/-u/-P`, so `mosquitto_sub -t 'bat_+/temperatures/#' -v` is enough.

### Gotchas

- **macOS Local Network privacy:** Homebrew binaries (mosquitto_sub, brew python, …) are blocked from LAN hosts when run inside an SSH session or a tmux server that wasn't started from a GUI terminal app. Apple binaries (`nc`, `/usr/bin/python3`) are not affected. Run from a local GUI terminal, or start the tmux server from one.
- **Misleading error:** mosquitto 2.1.2 reports any connect failure (blocked, refused) as `Error: Bad file descriptor`. If you see that, it's a connection problem, not a broken install.
- `Connection Refused: not authorised` → the connection works, credentials are missing or wrong.
