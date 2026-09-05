import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { bleLog } from '../ble/types.js';
import { buildPayload, computeBiaFat, normalizeServiceUuid, uuid16 } from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';

/** Huami vendor service the scale broadcasts its measurement on. */
const SVC_HUAMI = uuid16(0xfee0);
const HUAMI_COMPANY_ID = 0x0157;
const FRAME_LENGTH = 20;
const WEIGHT_MIN = 10;
/** Advertised local name, upper-cased. */
const LOCAL_NAME = 'AMAZFIT SCALE';

/**
 * Whole-body impedance window, in ohms, inside which the decoded value is used
 * for BIA. Outside it the reading falls back to the BMI estimate.
 *
 * The impedance field is the least certain part of this decode (see below), so
 * an implausible value must not poison body composition: a frame from a
 * weigh-in the scale could not measure impedance for carries garbage there
 * (0xd9b3 = 5573 ohm in the ble_monitor capture), and the vendor itself has
 * produced 2321 ohm readings that its own app rejected.
 */
const IMPEDANCE_MIN = 100;
const IMPEDANCE_MAX = 1500;

/**
 * Amazfit Smart Scale (Huami / Zepp).
 *
 * Broadcast-only for our purposes: the scale advertises a 20-byte service-data
 * frame on the Huami vendor service 0xFEE0, both while measuring and for a
 * while afterwards. There is no pairing and nothing is written to the scale.
 *
 * Frame layout, from the reverse engineering in
 * custom-components/ble_monitor#910 and its shipped parser
 * (`ble_parser/amazfit.py`), cross-checked against a capture from this project:
 *
 *   [0]      control byte (0xba / 0xbb on completed measurements, 0x0a / 0x8a
 *            on idle and weight-only frames; not decoded)
 *   [1]      flags, not decoded
 *   [2-4]    unknown (looks like a counter or timestamp)
 *   [5-6]    impedance x10, uint16 LE. See IMPEDANCE_MIN / IMPEDANCE_MAX.
 *   [7-8]    weight x200, uint16 LE, always kg regardless of display unit
 *   [9-11]   all zero until the measurement has completed with impedance
 *   [12]     pulse, bpm (0 when not measured; not exported)
 *   [13]     unknown
 *   [14-19]  user slot identification; 0xff.. when the scale matched nobody
 *
 * The [9-11] gate is the one ble_monitor ships. Frames that fail it include the
 * idle re-broadcast (weight 0.6 kg), a weight-only weigh-in the scale could not
 * measure impedance for, and a stored value for a different user, and the
 * frame carries no field that separates those cases, so all of them are
 * dropped and logged in debug mode until a capture shows which bit does.
 *
 * ble_monitor's fixture: `ba82e6c7fc3414a442bf46ec68000462bba30100` is
 * 85.3 kg, 517.2 ohm, 104 bpm; the same person's Xiaomi Mi Scale 2 read
 * 514 ohm, which is what makes the impedance decode credible.
 */
export class AmazfitSmartScaleAdapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Amazfit Smart Scale';
  readonly match: MatchDescriptor = {
    priority: 213,
    custom: true,
    names: { exact: ['amazfit scale'] },
    serviceUuids: ['fee0'],
    manufacturerId: HUAMI_COMPANY_ID,
  };
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  matches(device: BleDeviceInfo): boolean {
    // The ESPHome proxy delivers the advertisement and the scan response as
    // separate frames: one carries the name plus the Huami manufacturer id,
    // the other only the 0xFEE0 service data. Either alone has to match, so
    // the manufacturer id is not required. Huami wearables also use 0xFEE0
    // but with a 4-byte step counter, never a 20-byte frame.
    if ((device.localName || '').toUpperCase() === LOCAL_NAME) return true;

    return (device.serviceData ?? []).some(
      (sd) => normalizeServiceUuid(sd.uuid) === SVC_HUAMI && sd.data.length === FRAME_LENGTH,
    );
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  parseServiceData(uuid: string, data: Buffer): ScaleReading | null {
    if (normalizeServiceUuid(uuid) !== SVC_HUAMI || data.length !== FRAME_LENGTH) return null;

    const weight = data.readUInt16LE(7) / 200;
    const measured = data[9] !== 0 || data[10] !== 0 || data[11] !== 0;

    if (!measured || weight < WEIGHT_MIN) {
      bleLog.debug(
        `Amazfit frame without a completed measurement (${weight.toFixed(2)} kg): ${data.toString('hex')}`,
      );
      return null;
    }

    const rawImpedance = data.readUInt16LE(5) / 10;
    const impedance =
      rawImpedance >= IMPEDANCE_MIN && rawImpedance <= IMPEDANCE_MAX ? rawImpedance : 0;
    const pulse = data[12];

    bleLog.debug(
      `Amazfit measurement: ${weight.toFixed(2)} kg, impedance ${rawImpedance.toFixed(1)} ohm` +
        `${impedance === 0 ? ' (out of range, using BMI estimate)' : ''}, pulse ${pulse} bpm, ` +
        `user bytes ${data.subarray(14, 20).toString('hex')}`,
    );

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight >= WEIGHT_MIN;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
