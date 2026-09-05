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

An optional per-user `amazfit_avatar_id` accepts Zepp's built-in indexes 0–8.
Leave it absent to keep the existing profile display: the encoded avatar byte
remains 0 and both name bitmaps are unchanged. A nonzero value is an explicit
opt-in and schedules a profile update. No avatar is selected automatically, and
the setup example above deliberately leaves this setting absent. The indexes
come from Zepp's `avatar_of_scale_res_id` resource array; nonzero avatars have
not been tested on the scale. No images from Zepp are bundled with the service.

On startup and after profile details change, the service waits for the scale to
wake and the person to step off, then registers accounts and writes the profiles.
Every write must be acknowledged and the final account list must read back
correctly. Routine `last_known_weight` updates do not trigger another setup.
Existing accounts outside the configured IDs are preserved.

The maintenance wake-up is not exported. Wait for **Profile status: ready**, then
take a fresh measurement. Known scale profile IDs route readings to their
configured users; unrecognised readings use the existing weight-matching policy.
`dry_run: true` disables profile writes and MQTT controls as well as exports.

## Heart rate in Home Assistant

Completed measurements with the pulse-present flag and a nonzero pulse include
`heartRate` (bpm) in the MQTT payload on each user's normal measurement topic.
With MQTT discovery enabled, the first such reading creates a **Heart Rate**
sensor under that user's existing BLE Scale device. No config change is needed.

A weight-only reading omits `heartRate`. The discovery template converts its
absence to Home Assistant's numeric `unknown` state, so an old pulse is not
presented as part of a new reading. This uses Home Assistant's documented
[MQTT sensor missing-value behavior](https://www.home-assistant.io/integrations/sensor.mqtt/#state_topic).
The value comes from the scale, not the body-composition calculation.

## Stress measurement

Home Assistant discovers a **Stress measurement** switch alongside **Reset scale
profiles** and **Profile status** under **BLE Scale profiles**. This switch applies
to the whole scale. A request waits for a completed step-off, reads the existing
setting, writes only if needed, and verifies it by reading it back. It does not
rewrite profiles for a stress-only change. Profile status reports `stress_pending`,
`syncing`, `ready`, or `error`; errors retry after 30 seconds when the scale is awake.

The switch reflects the verified setting, not the requested setting. It is
unavailable until the first readback on startup, or after a failed readback.
The scale stores the setting; startup reads it without changing it. No new
`config.yaml` option is required. Unapplied requests are held only for the current
service process; resend after a restart. Retained commands and duplicates are ignored.

Using the same control base as the profile button:

| Topic | Meaning |
| --- | --- |
| `<export-topic>/amazfit/<mac>/stress/set` | Send `ON` or `OFF`, without retain |
| `<export-topic>/amazfit/<mac>/stress/state` | Retained, verified `ON` or `OFF` |
| `<export-topic>/amazfit/<mac>/stress/availability` | Setting known/unknown (`online`/`offline`) |

After status `ready`, take a fresh barefoot weigh-in and stay on through the
stress stage. The maintenance wake-up is not exported. Stress follows body
composition and heart rate, so it lengthens the measurement.

When the completed frame has flag `0x0040`, byte 13 is exported as `stress`.
The first such reading creates a **Stress** sensor for that user. It is a raw,
unitless score, not a percentage. A flagged zero is preserved; an absent flag
omits the field and makes an already discovered sensor unknown on that reading.
Firmware V1.0.0.16 was verified to broadcast **39**, matching the on-scale display.

Zepp 10.8.1's shared English `stress_measure_intro` resource describes a 0–100
score with bands 0–39 relaxed, 40–59 normal, 60–79 medium, and 80–100 high. That
resource explicitly describes watches and HRV. The A2003 measurement screen
(`r5h0`) displays `MeasureData.getPressure()` directly; no A2003-specific mapping
or calculation has been established. Consequently the integration exports the
raw score without inferred categories, physiological interpretation, or units.

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
- `ug31.N3()` and `avatar_of_scale_res_id`: avatar indexes 0–8;
  `v411.I0()` writes the avatar byte after the two six-byte IDs.
- `goz.unbindSync()` → `v411.O0()`: account unbind, module 32, `01 07 + accountLE6`.
- `zzc/n1d/i3v`: plaintext Huami channel v1, fragmentation and acknowledgements.

Base APK SHA-256: `6828681bcee993832e1769f67a3d96563e2fe4183f7be997b2586fa6edb623f5`.
The scale firmware itself was not decompiled.
