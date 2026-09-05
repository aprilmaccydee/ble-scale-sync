# Zepp exporter (experimental)

Send scale measurements **into Zepp** from BLE Scale Sync. The weight-record
request format was recovered from Zepp Android 10.8.1. Weight and composition
uploads, regional routing and readback were verified with a live account on
2026-09-05. This uses a private API that may change.

## Configure in config.yaml

Add Zepp to each person's existing `exporters` list. The service signs in using
these YAML credentials, discovers the account and regional API, and renews the
session automatically. No environment variables or manually copied tokens are needed.

```yaml
users:
  - name: Example
    # Keep existing profile fields and exporters.
    exporters:
      - type: zepp
        username: "person@example.com"
        password: ""                  # Fill in your Zepp password
        country_code: GB
        token_dir: ./zepp-tokens
        member_id: "-1"               # Account owner
        device_source: 104            # Amazfit Smart Scale A2003
        device_id: "AA:BB:CC:DD:EE:FF"
        time_zone: Europe/London
        upload_mode: full
```

Use each person's own login for separate accounts. Explicitly blank username or
password entries are skipped until completed. `npm run validate` checks the
configuration; the setup wizard also offers a read-only connection check.

For an existing family member inside one account, use their quoted **cloud**
`member_id`. Local `amazfit_user_id` values are unrelated to cloud IDs.

| Field | Default | Meaning |
| --- | --- | --- |
| `username`, `password` | Required | Zepp email and password |
| `country_code` | `US` | Two-letter account country, e.g. `GB` |
| `token_dir` | `./zepp-tokens` | Persistent session cache; separate files per account |
| `member_id` | `"-1"` | Account owner or existing cloud family member |
| `device_source` | `-1` | Unknown device; `104` is Amazfit Smart Scale |
| `device_id` | Omitted | Scale device ID / Bluetooth MAC |
| `time_zone` | Service host's zone | IANA zone, e.g. `Europe/London` |
| `upload_mode` | `full` | `full`, or `weight_impedance` to omit calculated metrics and pulse |

Keep the real credentials in your private `config.yaml`. Session files contain
only tokens and routing metadata, use mode 0600, and are reused after restarts.
For Docker, persist the cache with a writable volume:

```yaml
volumes:
  - ./zepp-tokens:/app/zepp-tokens
```

The container runs as UID 1000; ensure that user can write the host directory.

## Authentication and verification

The service uses encrypted email/password login and exchanges the access token
for a **web application** session (`app_name=com.huami.webapp`). Mobile-app login
was observed to replace the phone's session. The web flow works with the health
API; continued iOS session coexistence still needs confirmation during normal use.
Weight requests use `appname: com.huami.midong`: using the web name for data
requests selected a different, empty history in the live test.

Sessions renew before expiry, or once after a definite `401`/`403` rejection.
Concurrent sign-ins for the same account share one request. Failed sign-ins, or
a newly issued session being rejected, pause further sign-ins for five minutes.
Changing the configured password permits an immediate retry. Account creation
and device binding are not performed.

For diagnostics or manually managed sessions, `npm run setup-zepp` saves a private
`.zepp-exporter.local.yaml` fragment without uploading measurements. It also
accepts `--credentials .zepp-login.local.json` with `username`, `password` and
`country_code`. Alternatively configure quoted `user_id`, `app_token` and the
session's `base_url` instead of username/password. This token-only mode cannot
renew automatically. Only HTTPS Zepp/Huami `api-mifit` origins are accepted.

A healthcheck reads the configured member's weight-record endpoint. Export sends
one JSON array, then checks the same time range, reporting success only when all
submitted measurements match the stored values. This checks the API, not every
Zepp screen or downstream integration.

A definite authentication rejection can renew the session and repeat the upload
once. Timeouts and server errors do not repeat uploads because server-side
idempotency is unproven. After an uncertain failure, inspect Zepp before
resubmitting. **Live readings use the current time.** Historical readings retain
their supplied measurement time. Masses stay in kilograms regardless of display
units. Local scale accounts and Bluetooth provisioning are unchanged.

## Measurement mapping

| BLE Scale Sync | Zepp summary | Units/encoding |
| --- | --- | --- |
| `weight` | `weight` | kg |
| Resolved profile | `height`, `age` | cm, years |
| `bmi` | `bmi` | BMI |
| `bodyFatPercent` | `fatRate` | Percent, e.g. 20 |
| `waterPercent` | `bodyWaterRate` | Percent |
| `boneMass` | `boneMass` | kg |
| `bmr` | `metabolism` | Integer kcal/day |
| `muscleMass` | `muscleRate` | **kg**, despite the name |
| `metabolicAge` | `muscleAge` | Integer years |
| `proteinPercent` | `proteinRatio` | Percent |
| `idealWeight` | `standBodyWeight` | kg |
| `visceralFat` | `visceralFat` | Scale index |
| `impedance` | `impedance` | Integer ohms |
| `subcutaneousFatMass` | `subcutaneousFat` | **kg**, not percent |
| `skeletalMuscleMass` | `skeletalMuscle` | kg |
| `heartRate` | `heartRateData` | Decimal string, e.g. `"72"` |

Unavailable or invalid optional values are omitted. Without valid impedance,
composition is omitted; pulse is independent of composition.

In `upload_mode: weight_impedance`, the only measurements sent are weight and
valid impedance; Zepp source metadata is also required. The live test stored
these raw values without calculating BMI, body fat or other composition values,
and the iOS app did not fill them in. Use `full` for those metrics. The service
calculates them before upload; for A2003, `scale.amazfit_algorithm: zepp` selects
the recovered Zepp scale algorithm.

Stress is not uploaded: `Summary` declares `singleStress`, but `dni0.R` supplies
its null default. Local `physiqueRating` is not equivalent to Zepp `bodyStyle` or
`bodyScore`. Fat-free mass, fat mass and muscle percentage have no established
field in this request. The exporter does not create sleep, step or workout data.

## APK evidence

Zepp 10.8.1 base APK SHA-256:
`6828681bcee993832e1769f67a3d96563e2fe4183f7be997b2586fa6edb623f5`.
Obfuscated class names are specific to this build. No APK or native library is
needed at runtime; proprietary binaries are not included in the project.

| Evidence | Finding |
| --- | --- |
| `classes16.dex`, `i19.b` | JSON-array POST to `users/{userId}/members/{memberId}/weightRecords` |
| `classes16.dex`, `i19.a` | GET: `limit`, `fromTime`, `toTime`; response `items`/`next` |
| `classes16.dex`, `j19` / `hec1` (BodyCompositionRemoteModel / Summary) | Serialized field names/types |
| `classes16.dex`, `dni0.R`, `fct.e`, `eij1.a/b` | Units, seconds, owner normalization, decimal-string pulse |
| `classes25.dex`, `WeightingType`, `DataSourceType`, `SourceType` | Normal weighing 0, scale data 1, Android upload source 1 |
| `classes16.dex`, `w900`; `HMDeviceType` | Amazfit source 104; weight device type 1 |
| `classes18.dex`, `vs50`, `e8z0`, `fp10.b.c`; `classes2.dex`, `jp10.n` | Request headers include authenticated `apptoken` |
| `classes18.dex`, `tft0` | App identity `com.huami.midong` |
| `classes2.dex`, `lc10`, `ev00` | API origin and regional routing |
| `classes2.dex`, `MailService.s`, `avm1.D`, `sp50` | Credential form, access-token exchange and regional hosts |
| `classes24.dex`, `xu40` | Encrypted credential body and fixed IV |

The login encoding was cross-checked against
[huami-token's authentication implementation](https://github.com/argrento/huami-token/blob/master/huami_token/zepp.py),
[protocol constants](https://github.com/argrento/huami-token/blob/master/huami_token/constants.py)
and [encryption helper](https://github.com/argrento/huami-token/blob/master/huami_token/helpers.py).
The web-session exchange and the separate health-data app header were then tested
against the live API. No third-party client is needed at runtime.

Some JADX methods need instruction dumps (`--comments-level debug`) because Java
reconstruction fails. The field mapping follows those dumps and the serialized
constructors, not guesses based on field names.
