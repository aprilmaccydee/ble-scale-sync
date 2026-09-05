import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
  AdapterRuntimeConfig,
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
 * The native decoder can return an unsigned underflow for malformed input;
 * unavailable or implausible values must not enter the BIA calculation.
 */
const IMPEDANCE_MIN = 100;
const IMPEDANCE_MAX = 1500;

/**
 * How long a measurement is treated as the scale repeating itself rather
 * than a new weigh-in.
 *
 * The scale re-broadcasts its last completed measurement for
 * several minutes after the weigh-in. The transports' own dedup window is 30 s,
 * the same as the default scan cooldown, so every cooldown cycle re-read and
 * re-exported the same reading: one weigh-in produced 27 exports. A genuine
 * second weigh-in has a different packed timestamp, even at the same weight.
 */
const REPEAT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Amazfit Smart Scale (Huami / Zepp).
 *
 * The adapter is passive: the scale advertises a 20-byte service-data
 * frame on the Huami vendor service 0xFEE0, both while measuring and for a
 * while afterwards. There is no pairing and nothing is written to the scale.
 *
 * Frame layout recovered from Zepp 10.8.1's r12 / MeasureData parser and
 * impedanceDecode(uint32_t) in libhtBodyfatBia4TwoLegs.so. Captures include
 * custom-components/ble_monitor#910 and this project's ESPHome proxy.
 *
 *   [0-1]    LE flags: lb=0x0001, weight=0x0008, impedance=0x0010,
 *            pulse=0x0020, pressure=0x0040, family ID=0x0080,
 *            session=0x0100, result=0x0600 (0 measuring/1 success/2 failed),
 *            user matching=0x0800, jin=0x4000, leave=0x8000
 *   [2-6]    LE packed UTC timestamp: year13/month4/day5/hour6/min6/sec6
 *   [7-8]    LE weight: kg x200 or lb x100 (jin x100 is also kg x200)
 *   [9-11]   encoded 24-bit impedance; NOT bytes 5-6 (those are timestamp)
 *   [12]     pulse, bpm; [13] pressure
 *   [14-19]  LE 48-bit family member ID; all 0xff means unrecognised
 *
 * Export after the leave flag, so the final pulse/impedance has arrived.
 * A failed composition measurement or a weight-only weigh-in can still
 * provide a valid final weight. The packed timestamp stays in the dedup key;
 * ScaleReading.timestamp is reserved by the bridge for historical replay.
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

  /** Timestamp/weight keys suppress repeats even when optional fields change. */
  private readonly recentMeasurements = new Map<string, number>();
  private readonly now: () => number;
  private users = new Map<number, string>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  configure(config: AdapterRuntimeConfig): void {
    this.users = new Map(config.amazfitUsers?.map((u) => [u.id, u.slug]));
  }

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

    const flags = data.readUInt16LE(0);
    const isLbs = (flags & 0x01) !== 0;
    const rawWeight = data.readUInt16LE(7);
    const weight = isLbs ? (rawWeight / 100) * 0.45359237 : rawWeight / 200;
    const leftScale = (flags & 0x8000) !== 0;
    const hasWeight = (flags & 0x0008) !== 0;
    const result = (flags >>> 9) & 3;
    const settled = result === 1 || result === 2;

    if (!leftScale || !hasWeight || !settled || rawWeight === 0xffff || weight < WEIGHT_MIN) {
      bleLog.debug(
        `Amazfit frame without a completed measurement (${weight.toFixed(2)} kg): ${data.toString('hex')}`,
      );
      return null;
    }

    const hex = data.toString('hex');
    const now = this.now();
    for (const [key, seenAt] of this.recentMeasurements) {
      if (now - seenAt >= REPEAT_WINDOW_MS) this.recentMeasurements.delete(key);
    }
    const measurementKey = `${flags & 0x4001}:${data.subarray(2, 9).toString('hex')}`;
    if (this.recentMeasurements.has(measurementKey)) return null;
    this.recentMeasurements.set(measurementKey, now);

    const encoded = data.readUIntLE(9, 3);
    // Native impedanceDecode: subtract a 10-bit offset from the rearranged
    // 12-bit value, then unsigned-shift by one. 0xffffff means unavailable.
    const rawImpedance =
      (flags & 0x0010) !== 0 && encoded !== 0xffffff
        ? (((encoded & 0xf00) | (encoded >>> 16)) -
            (((encoded & 0xff) << 2) + ((encoded >>> 12) & 0xf))) >>>
          1
        : 0;
    const impedance =
      rawImpedance >= IMPEDANCE_MIN && rawImpedance <= IMPEDANCE_MAX ? rawImpedance : 0;
    const pulse = (flags & 0x0020) !== 0 ? data[12] : 0;
    const stress = (flags & 0x0040) !== 0 ? data[13] : undefined;

    bleLog.info(
      `Amazfit frame ${hex}: ${weight.toFixed(2)} kg (${isLbs ? 'lb' : 'kg'} mode), ` +
        `impedance ${rawImpedance} ohm${impedance === 0 ? ' (unavailable or out of range, using BMI estimate)' : ''}, ` +
        `pulse ${pulse} bpm, user bytes ${data.subarray(14, 20).toString('hex')}`,
    );

    const userSlug = flags & 0x0080 ? this.users.get(data.readUIntLE(14, 6)) : undefined;
    return {
      weight,
      impedance,
      ...(pulse > 0 ? { heartRate: pulse } : {}),
      ...(stress !== undefined ? { stress } : {}),
      ...(userSlug ? { userSlug } : {}),
    };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight >= WEIGHT_MIN;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return {
      ...buildPayload(reading.weight, reading.impedance, { fat }, profile),
      ...(reading.heartRate !== undefined ? { heartRate: reading.heartRate } : {}),
      ...(reading.stress !== undefined ? { stress: reading.stress } : {}),
    };
  }
}
