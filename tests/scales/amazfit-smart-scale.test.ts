import { describe, expect, it } from 'vitest';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { buildPayload, computeBiaFat } from '../../src/scales/body-comp-helpers.js';
import { AmazfitSmartScaleAdapter } from '../../src/scales/amazfit-smart-scale.js';
import { assertPayloadRanges, defaultProfile } from '../helpers/scale-test-utils.js';

const HUAMI_MANUFACTURER = { id: 0x0157, data: Buffer.from('70879eb52fa4', 'hex') };

// custom-components/ble_monitor#910 fixture: 85.3 kg, 517.2 ohm, 104 bpm.
const BLE_MONITOR_FRAME = Buffer.from('ba82e6c7fc3414a442bf46ec68000462bba30100', 'hex');
// Captured through an ESPHome proxy in this project: 120.7 kg, 1044.8 ohm, 74 bpm,
// user slot bytes all 0xff (scale matched nobody).
const PROXY_FRAME = Buffer.from('bb82ea270bd0284c5ef046ee4a00ffffffffffff', 'hex');
// Same issue: a weight-only weigh-in (84.05 kg) with bytes 9-11 zero.
const WEIGHT_ONLY_FRAME = Buffer.from('0a00e6c7fab3d9aa410000000000000000000000', 'hex');
// Same issue: idle re-broadcast, 0.6 kg.
const IDLE_FRAME = Buffer.from('0a80e6c778a37900000000000000000000000000', 'hex');

describe('AmazfitSmartScaleAdapter', () => {
  const adapter = new AmazfitSmartScaleAdapter();

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

    expect(reading).toEqual({ weight: 85.3, impedance: 517.2 });
    expect(adapter.isComplete(reading!)).toBe(true);
  });

  it('decodes the proxy capture and accepts its full 128-bit service uuid', () => {
    expect(adapter.parseServiceData('0000fee000001000800000805f9b34fb', PROXY_FRAME)).toEqual({
      weight: 120.7,
      impedance: 1044.8,
    });
  });

  it('drops frames whose measurement has not completed', () => {
    expect(adapter.parseServiceData('fee0', WEIGHT_ONLY_FRAME)).toBeNull();
    expect(adapter.parseServiceData('fee0', IDLE_FRAME)).toBeNull();
  });

  it('ignores other services and frame lengths', () => {
    expect(adapter.parseServiceData('181b', BLE_MONITOR_FRAME)).toBeNull();
    expect(adapter.parseServiceData('fee0', BLE_MONITOR_FRAME.subarray(0, 19))).toBeNull();
  });

  it('zeroes an implausible impedance so composition falls back to BMI', () => {
    const frame = Buffer.from(BLE_MONITOR_FRAME);
    frame.writeUInt16LE(23218, 5); // 2321.8 ohm, the value reported as wrong in #910

    expect(adapter.parseServiceData('fee0', frame)).toEqual({ weight: 85.3, impedance: 0 });
  });

  it('emits a completed frame immediately instead of starting the grace period', () => {
    expect(
      evaluateAdvertisement(adapter, {
        localName: '',
        serviceUuids: ['fee0'],
        serviceData: [{ uuid: 'fee0', data: BLE_MONITOR_FRAME }],
      }),
    ).toEqual({ kind: 'complete', reading: { weight: 85.3, impedance: 517.2 } });
  });

  it('uses BIA when impedance is present and the BMI estimate otherwise', () => {
    const profile = defaultProfile();

    const withImpedance = adapter.computeMetrics({ weight: 85.3, impedance: 517.2 }, profile);
    expect(withImpedance).toEqual(
      buildPayload(85.3, 517.2, { fat: computeBiaFat(85.3, 517.2, profile) }, profile),
    );
    assertPayloadRanges(withImpedance);

    const withoutImpedance = adapter.computeMetrics({ weight: 85.3, impedance: 0 }, profile);
    expect(withoutImpedance).toEqual(buildPayload(85.3, 0, {}, profile));
    assertPayloadRanges(withoutImpedance);
  });
});
