# Amazfit Smart Scale A2003

The service reads completed measurements from BLE advertisements and can manage
on-scale profiles through an ESPHome proxy, without Zepp or a cloud account.
The protocol was recovered from Zepp 10.8.1 and verified on A2003 firmware
V1.0.0.16. Profile management currently requires `esphome-proxy` and continuous mode.

## Enable profiles

Set `ble.scale_mac` to your scale's Bluetooth address, and add a unique
`amazfit_user_id` to each user you want on the scale:

```yaml
ble:
  handler: esphome-proxy
  scale_mac: "AA:BB:CC:DD:EE:FF"
  esphome_proxy:
    host: 192.168.1.20
    encryption_key: ${ESPHOME_API_KEY}
users:
  - name: Alice
    slug: alice
    amazfit_user_id: 1
    height: 170
    birth_date: 1990-01-15
    gender: female
    is_athlete: false
    weight_range: { min: 65, max: 75 }
    last_known_weight: 70
  - name: Bob
    slug: bob
    amazfit_user_id: 2
    height: 180
    birth_date: 1985-06-20
    gender: male
    is_athlete: false
    weight_range: { min: 80, max: 90 }
    last_known_weight: 85
runtime:
  continuous_mode: true
```

Keep these IDs stable when reordering or renaming users. The service creates a
separate local account and primary member for each ID. Multiple family members
under one account acknowledged successfully on the tested firmware but only the
primary member appeared in its selector.

The first three letters of `name` become the display label. They must be ASCII
letters, digits, or spaces. Up to 10 accounts are supported. Height must resolve
to 90–220 cm and weight to 10–180 kg. The weight reference comes from
`last_known_weight`, falling back to the midpoint of `weight_range`. Only the
verified normal measurement mode is supported (`is_athlete: false`).

On startup and after profile details change, the service waits for the scale to
wake and the person to step off, then registers accounts and writes the profiles.
Every write must be acknowledged and the final account list must read back
correctly. Routine `last_known_weight` updates do not trigger another setup.
Existing accounts outside the configured IDs are preserved.

The maintenance wake-up is not exported. Wait for **Profile status: ready**, then
take a fresh measurement. Known scale profile IDs route readings to their
configured users; unrecognised readings use the existing weight-matching policy.
`dry_run: true` disables profile writes and MQTT controls as well as exports.

## MQTT reset button

With a global MQTT exporter configured, the service maintains a separate control
connection using that exporter's broker credentials. With `ha_discovery: true`,
Home Assistant discovers **Reset scale profiles** and **Profile status** under
the device **BLE Scale profiles** (or your configured device name).

Press the button, wake the scale, and step off. It unbinds the configured accounts,
verifies their removal, recreates the same IDs and profile details, then verifies
the final account list. It uses Zepp's actual account-unbind command, rather than
merely clearing the sync buffer. It does not erase Home Assistant's history.

Status reports `reset_pending`, `resetting`, `ready`, or `error` with a detail
message. Errors retry when the scale next advertises, with a 30-second backoff.
Repeated requests while a reset is pending or a session is running are ignored.
Retained MQTT commands and retransmissions are ignored so reconnecting cannot
trigger another reset. Interrupted recreation retries preserve deletion progress
for the life of the service, so newly recreated accounts are not deleted again.

Topics, where `<mac>` is the lowercase MAC without colons:

| Topic | Meaning |
| --- | --- |
| `<export-topic>/amazfit/<mac>/reset/set` | Send `RESET`, without retain |
| `<export-topic>/amazfit/<mac>/state` | Retained JSON status and detail |
| `<export-topic>/amazfit/<mac>/availability` | Service online/offline |

The ESPHome connection is shared with the existing advertisement watcher. Do not
run a separate provisioning script or give Home Assistant the proxy's Bluetooth
subscription while the service is running.

## Measurement correction and protocol references

The 20-byte FEE0 frame contains a packed UTC timestamp in bytes 2–6, weight in
bytes 7–8, and **encoded impedance in bytes 9–11**. The earlier decoder wrongly
treated timestamp bytes 5–6 as impedance. The native Zepp decoder turns captured
`4e0480` into **420 Ω**; the old timestamp interpretation gave 2,435.2 Ω.

The adapter waits for a settled measurement result and the step-off flag. Failed
composition measurements can still provide a valid final weight. Unavailable or
implausible impedance uses the bridge's BMI estimate. Other readings use its BIA
estimate; these are not Zepp's proprietary body-composition results.

Source references for Zepp 10.8.1:

- `r12.c()` and `MeasureData`: frame layout and flags.
- ARM64 `libhtBodyfatBia4TwoLegs.so`, exported `impedanceDecode`, address `0x4780`:
  encoded impedance calculation.
- `v411.I0/i1/s1/U0`: profile record, member roster, registered account write/read.
- `goz.unbindSync()` → `v411.O0()`: account unbind, module 32, `01 07 + accountLE6`.
- `zzc/n1d/i3v`: plaintext Huami channel v1, fragmentation and acknowledgements.

Base APK SHA-256: `6828681bcee993832e1769f67a3d96563e2fe4183f7be997b2586fa6edb623f5`.
The scale firmware itself was not decompiled.
