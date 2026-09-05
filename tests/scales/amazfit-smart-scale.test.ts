import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bleLog } from '../../src/ble/types.js';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { buildPayload, computeBiaFat } from '../../src/scales/body-comp-helpers.js';
import { AmazfitSmartScaleAdapter } from '../../src/scales/amazfit-smart-scale.js';
import { assertPayloadRanges, defaultProfile } from '../helpers/scale-test-utils.js';

const HUAMI_MANUFACTURER = { id: 0x0157, data: Buffer.from('70879eb52fa4', 'hex') };

// custom-components/ble_monitor#910 fixture: 85.3 kg, 502 ohm, 104 bpm.
// Impedance now decoded with Zepp's native impedanceDecode, not timestamp bytes.
const BLE_MONITOR_FRAME = Buffer.from('ba82e6c7fc3414a442bf46ec68000462bba30100', 'hex');
// Captured through an ESPHome proxy in this project from a scale set to lb:
// 241.4 lb (the display showed 109 kg), 405 ohm, 74 bpm, user ID bytes
// all 0xff (scale matched nobody).
const PROXY_FRAME = Buffer.from('bb82ea270bd0284c5ef046ee4a00ffffffffffff', 'hex');
// Same issue: a weight-only weigh-in (84.05 kg) with bytes 9-11 zero.
const WEIGHT_ONLY_FRAME = Buffer.from('0a00e6c7fab3d9aa410000000000000000000000', 'hex');
// Same issue: idle re-broadcast, zero kg.
const IDLE_FRAME = Buffer.from('0a80e6c778a37900000000000000000000000000', 'hex');
// One weigh-in as the proxy saw it: the payload repeats while byte 1 walks
// 0x00 -> 0x02 (pulse in) -> 0x82 (finished). 241.6 lb, 70 bpm.
const IN_PROGRESS_FRAMES = [
  Buffer.from('bb00ea270b205f605e4e04800000ffffffffffff', 'hex'),
  Buffer.from('bb02ea270b205f605e4e04804600ffffffffffff', 'hex'),
];
const FINISHED_FRAME = Buffer.from('bb82ea270b205f605e4e04804600ffffffffffff', 'hex');

describe('AmazfitSmartScaleAdapter', () => {
  let adapter: AmazfitSmartScaleAdapter;

  beforeEach(() => {
    adapter = new AmazfitSmartScaleAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches the scan-response frame that carries only the name', () => {
    expect(
      adapter.matches({
        localName: 'Amazfit Scale',
        serviceUuids: ['fee0'],
        manufacturerData: HUAMI_MANUFACTURER,
      }),
    ).toBe(true);
  });

  it('matches the nameless advertisement by its 20-byte 0xFEE0 service data', () => {
    expect(
      adapter.matches({
        localName: '',
        serviceUuids: ['fee0'],
        serviceData: [{ uuid: 'fee0', data: PROXY_FRAME }],
      }),
    ).toBe(true);
  });

  it('does not claim Huami wearables on the same service', () => {
    expect(
      adapter.matches({
        localName: 'Amazfit Helio Strap',
        serviceUuids: ['180d', 'fee0'],
        manufacturerData: HUAMI_MANUFACTURER,
      }),
    ).toBe(false);
    expect(
      adapter.matches({
        localName: 'Mi Smart Band 4',
        serviceUuids: ['fee0'],
        serviceData: [{ uuid: 'fee0', data: Buffer.from('0b000000', 'hex') }],
      }),
    ).toBe(false);
  });

  it('decodes the ble_monitor fixture', () => {
    const reading = adapter.parseServiceData('fee0', BLE_MONITOR_FRAME);

    expect(reading).toEqual({ weight: 85.3, impedance: 502, heartRate: 104 });
    expect(adapter.isComplete(reading!)).toBe(true);
  });

  it('converts a pound-mode frame to kg and accepts the full 128-bit service uuid', () => {
    const reading = adapter.parseServiceData('0000fee000001000800000805f9b34fb', PROXY_FRAME);

    expect(reading?.weight).toBeCloseTo(109.497, 3);
    expect(reading?.impedance).toBe(405);
  });

  it('reads the same raw weight as kg when the pound bit is clear', () => {
    const frame = Buffer.from(PROXY_FRAME);
    frame[0] &= ~0x01;

    expect(adapter.parseServiceData('fee0', frame)).toEqual({
      weight: 120.7,
      impedance: 405,
      heartRate: 74,
    });
  });

  it('drops frames whose measurement has not completed', () => {
    expect(adapter.parseServiceData('fee0', WEIGHT_ONLY_FRAME)).toBeNull();
    expect(adapter.parseServiceData('fee0', IDLE_FRAME)).toBeNull();
  });

  it('reports one weigh-in once, from its finished frame only', () => {
    const fresh = new AmazfitSmartScaleAdapter();
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});

    for (const frame of IN_PROGRESS_FRAMES) {
      expect(fresh.parseServiceData('fee0', frame)).toBeNull();
    }
    const reading = fresh.parseServiceData('fee0', FINISHED_FRAME);
    expect(reading?.weight).toBeCloseTo(109.588, 3);
    expect(reading?.impedance).toBe(420);
    expect(reading?.heartRate).toBe(70);
    expect(fresh.computeMetrics(reading!, defaultProfile()).heartRate).toBe(70);
  });

  it.each(['missing flag', 'zero pulse'])('omits unavailable heart rate: %s', (reason) => {
    const frame = Buffer.from(FINISHED_FRAME);
    if (reason === 'missing flag') frame[0] &= ~0x20;
    else frame[12] = 0;
    const reading = adapter.parseServiceData('fee0', frame)!;
    expect(reading).not.toHaveProperty('heartRate');
    expect(adapter.computeMetrics(reading, defaultProfile())).not.toHaveProperty('heartRate');
  });

  it('ignores other services and frame lengths', () => {
    expect(adapter.parseServiceData('181b', BLE_MONITOR_FRAME)).toBeNull();
    expect(adapter.parseServiceData('fee0', BLE_MONITOR_FRAME.subarray(0, 19))).toBeNull();
  });

  it.each([0, 0xffffff, 0xff0f00, 0x0000ff])(
    'zeroes unavailable, implausible or unsigned-underflow impedance: %i',
    (encoded) => {
      const frame = Buffer.from(BLE_MONITOR_FRAME);
      frame.writeUIntLE(encoded, 9, 3);

      expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)).toEqual({
        weight: 85.3,
        impedance: 0,
        heartRate: 104,
      });
    },
  );

  it.each([
    ['bb83ea270bc016425e5434974200ffffffffffff', 418],
    ['bb85ea270b3097fa55cf37c30000ffffffffffff', 578],
    ['bb83ea274b3216765cc706805e00ffffffffffff', 434],
    ['bb82ea274bb242c454a657774200ffffffffffff', 621],
    ['bb83ea27cbd265785535357f5600ffffffffffff', 596],
  ])('decodes captured impedance independently of timestamp: %s', (hex, ohms) => {
    expect(
      new AmazfitSmartScaleAdapter().parseServiceData('fee0', Buffer.from(hex, 'hex'))?.impedance,
    ).toBe(ohms);
  });

  it('keeps impedance unchanged when the packed timestamp changes', () => {
    const frame = Buffer.from(BLE_MONITOR_FRAME);
    frame.writeUInt16LE(23218, 5);
    expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)?.impedance).toBe(502);
  });

  it('accepts a final weight-only reading after the person steps off', () => {
    const frame = Buffer.from(WEIGHT_ONLY_FRAME);
    frame[1] |= 0x82; // left the scale after a successful weight measurement
    expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)).toEqual({
      weight: 84.05,
      impedance: 0,
    });
  });

  it('uses the impedance-present flag, even when stale bytes are nonzero', () => {
    const frame = Buffer.from(BLE_MONITOR_FRAME);
    frame[0] &= ~0x10;
    expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)?.impedance).toBe(0);
  });

  it('rejects wake-up frames with an old leave flag while still measuring', () => {
    const frame = Buffer.from('0b80ea270bd3bdcc5b0000000000000000000000', 'hex');
    expect(adapter.parseServiceData('fee0', frame)).toBeNull();
  });

  it('retains final weight after body-composition measurement failed', () => {
    const frame = Buffer.from('9b84ea270be3357a5d0000000000010000000000', 'hex');
    expect(adapter.parseServiceData('fee0', frame)).toEqual({
      weight: (23930 / 100) * 0.45359237,
      impedance: 0,
    });
  });

  it('rejects overload and frames without a weight-present flag', () => {
    const frame = Buffer.from(BLE_MONITOR_FRAME);
    frame.writeUInt16LE(0xffff, 7);
    expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)).toBeNull();
    frame.writeUInt16LE(17060, 7);
    frame[0] &= ~0x08;
    expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)).toBeNull();
  });

  it('emits a completed frame immediately instead of starting the grace period', () => {
    expect(
      evaluateAdvertisement(adapter, {
        localName: '',
        serviceUuids: ['fee0'],
        serviceData: [{ uuid: 'fee0', data: BLE_MONITOR_FRAME }],
      }),
    ).toEqual({ kind: 'complete', reading: { weight: 85.3, impedance: 502, heartRate: 104 } });
  });

  it('treats an identical frame as the scale repeating itself, not a new weigh-in', () => {
    let now = 1_000_000;
    const fresh = new AmazfitSmartScaleAdapter(() => now);
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});

    expect(fresh.parseServiceData('fee0', PROXY_FRAME)).not.toBeNull();
    now += 32_000; // one scan cooldown later, still the same broadcast
    expect(fresh.parseServiceData('fee0', PROXY_FRAME)).toBeNull();
    now += 5 * 60_000;
    expect(fresh.parseServiceData('fee0', PROXY_FRAME)).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain(PROXY_FRAME.toString('hex'));

    // A different frame is a new measurement straight away.
    expect(fresh.parseServiceData('fee0', BLE_MONITOR_FRAME)).not.toBeNull();
    expect(info).toHaveBeenCalledTimes(2);

    // And the first frame is accepted again once the repeat window has passed.
    now += 16 * 60_000;
    expect(fresh.parseServiceData('fee0', PROXY_FRAME)).not.toBeNull();
  });

  it('uses BIA when impedance is present and the BMI estimate otherwise', () => {
    const profile = defaultProfile();

    const withImpedance = adapter.computeMetrics({ weight: 85.3, impedance: 502 }, profile);
    expect(withImpedance).toEqual(
      buildPayload(85.3, 502, { fat: computeBiaFat(85.3, 502, profile) }, profile),
    );
    assertPayloadRanges(withImpedance);

    const withoutImpedance = adapter.computeMetrics({ weight: 85.3, impedance: 0 }, profile);
    expect(withoutImpedance).toEqual(buildPayload(85.3, 0, {}, profile));
    assertPayloadRanges(withoutImpedance);
  });

  it('suppresses wake-up variants and interleaved repeats of an exported measurement', () => {
    const fresh = new AmazfitSmartScaleAdapter();
    expect(fresh.parseServiceData('fee0', PROXY_FRAME)).not.toBeNull();
    expect(fresh.parseServiceData('fee0', BLE_MONITOR_FRAME)).not.toBeNull();
    expect(fresh.parseServiceData('fee0', PROXY_FRAME)).toBeNull();
    const wake = Buffer.from(PROXY_FRAME);
    wake.writeUInt16LE(0x820b, 0); // leave + success + weight + lb, without composition
    wake.fill(0, 9);
    expect(fresh.parseServiceData('fee0', wake)).toBeNull();
    // A new timestamp is a new weigh-in, including at exactly the same weight.
    wake[6] += 4;
    expect(fresh.parseServiceData('fee0', wake)?.weight).toBeCloseTo(109.497, 3);
  });

  it('maps only configured on-scale family IDs to user slugs', () => {
    adapter.configure({
      amazfitUsers: [
        { id: 1, slug: 'alice' },
        { id: 2, slug: 'bob' },
      ],
    });
    const frame = Buffer.from('bb83ea270b933f8255f3488a5100010000000000', 'hex');
    expect(adapter.parseServiceData('fee0', frame)?.userSlug).toBe('alice');
    frame[6] += 4;
    frame.writeUIntLE(2, 14, 6);
    expect(adapter.parseServiceData('fee0', frame)?.userSlug).toBe('bob');
    frame[6] += 4;
    frame.fill(0xff, 14);
    expect(adapter.parseServiceData('fee0', frame)?.userSlug).toBeUndefined();
  });
  it('exports the hardware-verified stress score and preserves flagged zero', () => {
    const frame = Buffer.from('fb83ea274b746050557326205d27010000000000', 'hex');
    const reading = adapter.parseServiceData('fee0', frame)!;
    expect(reading).toMatchObject({ stress: 39, heartRate: 93, impedance: 553 });
    expect(adapter.computeMetrics(reading, defaultProfile()).stress).toBe(39);
    frame[13] = 0;
    expect(new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)?.stress).toBe(0);
    frame[0] &= ~0x40;
    frame[13] = 39;
    const noStress = new AmazfitSmartScaleAdapter().parseServiceData('fee0', frame)!;
    expect(noStress).not.toHaveProperty('stress');
    expect(adapter.computeMetrics(noStress, defaultProfile())).not.toHaveProperty('stress');
  });
});
