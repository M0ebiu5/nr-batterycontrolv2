# Incident 2026-09-16 — BMS feed frozen for ~4h, SOC stuck at 97.2%

**Impact:** `global.bms` froze at 16:36:57 with `weightedSoc` 97.2%. The optimizer ran blind on
BMS data from 16:37 to 21:33 (~4h50m). Restored 21:33, hardened 21:43.

**Severity:** no bad control action occurred. See *Why nothing broke* below — it was closer than
it looks.

All times Europe/Berlin, host `big` (HA OS), add-on `2af0a32d_batmon` v2.20.

---

## What actually happened

Two independent faults stacked. The first stopped the feed; the second kept it down for four
hours.

### Fault 1 — the USB Bluetooth adapter wedged

The trigger was **not** a batmon bug. `hci0` (`00:E0:03:00:22:9D`, bus USB) desynced at the
kernel HCI/L2CAP layer and stopped seeing *any* BLE device.

```
16:33:42  bluetoothd: Unable to register device interface for 00:00:00:00:00:00
          bluetoothd: Unable to create object for found device 00:00:00:00:00:00   (repeats)
16:35:57  [bt] BMS JKBt(...,bat_west) disconnected after 3.8s!
16:36:58  [bt] connecting bat_west ... timeout=10          <- last MQTT publish was 16:36:57
16:37:21  kernel: Bluetooth: Unexpected continuation frame (len 91)
16:37:50  [bt] bt_diagnostics bat_west: NOT seen during 3.0s scan (2 other devices in range)
16:37:58  kernel: Bluetooth: Unexpected start frame (len 84)
16:38:58  [bt] BMS bat_ost disconnected after 631.6s!
          [bt] BMS bat_big disconnected after 2173.1s!
16:39:01  [bt] bt_diagnostics bat_big: NOT seen during 3.0s scan (0 other devices in range)
16:39:21  device not found ... (found set())
```

The tell is the progression `2 other devices in range` → `0 other devices in range` → `found
set()`. All three packs dropped, including `bat_big`, which had held a stable link for 36
minutes. A single flaky pack cannot do that. The adapter itself went deaf, and the null-MAC
(`00:00:00:00:00:00`) registrations plus the kernel framing errors place the fault below BlueZ.

batmon then did the right thing — it exited on purpose so the supervisor would restart it and
rebuild the BLE stack:

```
16:41:58  ERROR [main] Watchdog: MQTT message publish timeout (last 300s ago), exit
16:42:09  INFO  [main] Process still alive, suicide
16:42:15  s6-rc: service legacy-services: stopping
```

### Fault 2 — the restart came up with no MQTT credentials

This is what turned a self-healing restart into a four-hour outage.

`addon_main.sh` resolves broker credentials from the HA supervisor `mqtt` *service*:

```sh
if _has_bashio && bashio::services.available 'mqtt'; then
    MQTT_HOST="$(bashio::services 'mqtt' 'host')" ...
else
    log "MQTT service not configured in HA. Using broker credentials from add-on configuration."
fi
```

`/data/services.json` had been cleared on **2026-09-14 17:44** — the MQTT integration on this
system is a manually-configured config entry (`source: user`), not the Mosquitto add-on's
discovery entry (`source: hassio`), so nothing republishes the supervisor service. batmon had
been running since before that on credentials fetched while they still existed, so the feed
stayed healthy for two more days and hid the problem.

On restart there were no `mqtt_*` keys in `options.json` either, so batmon had no broker at all.
Its own watchdog then fired every 300s — `MQTT never published a message after 300s, exit` — and
the supervisor watchdog restarted it, giving a ~5.5-minute crash loop that lasted until 21:33.

### Why the SOC froze rather than going stale

The `cb_capture` function (tab `checkbattery`, `8a7a85d30c1477cc`) latches MQTT messages into
`flow.bms_state[bank][field]` and writes `global.bms` **only when a message arrives**. With no
messages, nothing recomputed and nothing expired — the last good value simply sat there at
97.2%.

---

## Why nothing broke

The optimizer never planned on 97.2%. `query_soc` had already aged past its 30-minute BMS
window and fallen back to `ess.Soc + essOffset` = 53 + 32.8 = **85.8%**, which matched both the
per-pack calculation (85.9%) and the restored feed (85.6%).

That fallback is also why no *SOC stale* warning fired: the guard trips on a **flat** SOC, and
the Victron-derived fallback keeps moving. The freeze was invisible to the staleness check by
construction.

Two real degradations did run for four hours:

1. **`maxCellV` / `minCellV` were `null`** — the cell-voltage gates were blind. The charge
   ceiling (`CELL_FULL_V = 3.50`) and the discharge floor (3.22 / 3.18) had no data.
2. **A hard deadline at ~04:37** — `essOffsetTs + 12h`. Past it the planner drops the offset and
   uses raw `ess.Soc`, which reads ~26pp low. It would have grid-charged a nearly-full pack at
   the overnight trough. The fix landed ~7h before that.

---

## Fixes

### 1. MQTT credentials (restored service, 21:33)

Set batmon's own add-on options via the supervisor API, preserving all 14 pre-existing keys:

```
mqtt_broker=192.168.4.221  mqtt_port=1883  mqtt_user=m00n  mqtt_password=<from HA config entry>
```

`POST /addons/2af0a32d_batmon/options` then `/restart`. Broker accepted the connection at
21:33:11 and `global.bms` repopulated.

This is the durable path: it does not depend on the supervisor `mqtt` service, which will stay
empty as long as the MQTT integration is a user-configured entry.

### 2. Disconnect hardening (latent crash, 21:43)

**These two bugs did not cause this outage.** They are real latent defects found while
investigating it, on the exact shutdown path the watchdog uses, and they would make a future
adapter wedge substantially worse.

`bg_checks` sets `shutdown = True`, `background_thread` allows 10s for a graceful async
shutdown, then hard-kills via `exit_process(True, True)`. That 10s window runs the pack teardown
loop — so a raise there costs the graceful shutdown and leaks the BLE clients.

**`/app/bmslib/models/jikong.py` — `disconnect()`**

`stop_notify()` resolves the characteristic against `self.services` and raises
`BleakError: Service Discovery has not been performed yet` (`bleak/__init__.py:685`) when the
link connected but never completed GATT discovery. It raised *before* `await
super().disconnect()`, so the BLE client was never released. JK packs allow only one client, so
the leaked handle leaves the pack occupied for the next attempt.

This error is not hypothetical — it fired 8 times on 2026-09-16 alone (00:13, 01:01, 06:32,
08:54, 09:39, 12:39, 12:44, 13:46), almost always on `bat_west` (RSSI ~-94). On the *sampling*
path it is caught against a `max 200` error counter, which is why it never crashed anything. On
the *disconnect* path it was unguarded.

```python
 async def disconnect(self):
-    await self.client.stop_notify(self.char_handle_notify)
+    try:
+        if self.char_handle_notify:
+            await self.client.stop_notify(self.char_handle_notify)
+    except Exception as ex:
+        self.logger.warning("stop_notify failed during disconnect, releasing link anyway: %s", ex)
     await super().disconnect()
```

**`/app/main.py` — shutdown loop (~line 453)**

One pack raising aborted teardown of the *remaining* packs and escaped `main()`.

```python
 for t in tasks:
     if isinstance(t, BmsSampler):
-        await t.bms.disconnect()
+        try:
+            await t.bms.disconnect()
+        except Exception as ex:
+            logger.warning("disconnect of %s failed: %s", getattr(t.bms, "name", t.bms), ex)
```

#### Deployment caveat

batmon is a **pulled** add-on (`/addons` is empty) and the supervisor recreates the container
from the image on every restart, so an in-container edit does not survive. The image was rebuilt
locally at the same tag; the pristine vendor image is kept as
`2af0a32d/amd64-addon-batmon:2.20-orig`.

**An add-on update silently reverts this patch.** 2.20 was latest with `update_available=false`
on 2026-09-16. If these symptoms return after a version bump, that is the first thing to check.
Upstream: https://github.com/fl4p/batmon-ha

Rollback: `docker tag 2af0a32d/amd64-addon-batmon:2.20-orig 2af0a32d/amd64-addon-batmon:2.20`
then restart the add-on.

---

## Verification (21:45)

All three packs sampling on the 60s cycle, no `BleakError` or traceback since restart.

```
weightedSoc 85.1   maxPackSoc 90.44   banks 3
maxCellV 3.347     minCellV 3.28      frozenPacks []   voltOnlyPacks []
ts 21:45:18 (0.8 min old)             essOffsetTs 21:43:42 -> deadline 17 Sep 09:43
```

Cell voltages are populated again, so the gates have data. The 21:45 optimizer run was clean:
`Phase 3c: picks=0 endTarget=19.9% endTraj=35.4% peakTraj=84.6%`, no stale warning.

---

## Open items

- **The adapter wedge is unexplained and will recur.** No root cause for the HCI desync. The
  add-on already has `bt_power_cycle=true` and `bt_power_cycle_on_error=true`, which did not
  recover it — the failure was below BlueZ, so a USB-level reset of `hci0` is likely what is
  needed. Worth considering a host watchdog that resets the USB device when a scan returns
  `found set()` on all three packs.
- **No alert fired on a four-hour BMS blackout.** The staleness guard cannot see it, because the
  Victron fallback keeps the SOC number moving. A direct freshness check on `global.bms.ts`
  would have caught this in minutes.
- `bat_west` remains the weak link (RSSI ~-94, recurring GATT discovery failures, JK-PB AT-flood
  junk bytes). Its radio situation is the underlying nuisance, even though it did not cause this
  outage.
