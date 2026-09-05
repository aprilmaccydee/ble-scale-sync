import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MqttConfig } from '../../src/exporters/config.js';

const h = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('mqtt', () => ({ connect: h.connect }));
const { AmazfitMqttControl } = await import('../../src/runtime/amazfit-mqtt.js');
class Client extends EventEmitter {
  connected = true;
  publishAsync = vi.fn(async () => undefined);
  subscribeAsync = vi.fn(async () => undefined);
  endAsync = vi.fn(async () => undefined);
}
let client: Client;
let control: InstanceType<typeof AmazfitMqttControl>;
const reset = vi.fn();
const config: MqttConfig = {
  brokerUrl: 'mqtt://broker',
  topic: 'scale/body-composition',
  qos: 1,
  retain: true,
  clientId: 'ble-scale-sync',
  haDiscovery: true,
  haDeviceName: 'BLE Scale',
};
beforeEach(() => {
  vi.clearAllMocks();
  client = new Client();
  h.connect.mockReturnValue(client);
  control = new AmazfitMqttControl(config, 'AA:BB:CC:DD:EE:FF', reset);
  control.start();
});
afterEach(async () => {
  await control.stop();
});

describe('Amazfit MQTT controls', () => {
  it('discovers a non-retained reset button, status sensor, and separate online/offline connection', async () => {
    client.emit('connect');
    await vi.waitFor(() => expect(client.publishAsync).toHaveBeenCalledTimes(4));
    const calls = client.publishAsync.mock.calls as unknown as Array<[string, string, unknown]>;
    const button = JSON.parse(calls.find(([t]) => t.startsWith('homeassistant/button/'))![1]);
    expect(button).toMatchObject({
      name: 'Reset scale profiles',
      payload_press: 'RESET',
      retain: false,
      qos: 0,
    });
    expect(button.command_topic).toBe(`${control.baseTopic}/reset/set`);
    const opts = h.connect.mock.calls[0][1];
    expect(opts.clientId).not.toBe(config.clientId);
    expect(opts.will.payload.toString()).toBe('offline');
    expect(opts.will.topic).toBe(`${control.baseTopic}/availability`);
    await control.stop();
    expect(client.publishAsync).toHaveBeenCalledWith(
      `${control.baseTopic}/availability`,
      'offline',
      expect.anything(),
    );
    expect(client.endAsync).toHaveBeenCalledWith(true);
  });

  it('ignores retained, duplicate, unknown and malformed commands', () => {
    for (const [topic, payload, packet] of [
      [`${control.baseTopic}/reset/set`, 'RESET', { retain: true }],
      [`${control.baseTopic}/reset/set`, 'RESET', { dup: true }],
      [`${control.baseTopic}/reset/set`, 'oops', {}],
      ['unrelated', 'RESET', {}],
    ] as const)
      client.emit('message', topic, Buffer.from(payload), packet);
    expect(reset).not.toHaveBeenCalled();
    client.emit('message', `${control.baseTopic}/reset/set`, Buffer.from('RESET'), {
      retain: false,
      dup: false,
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('republishes discovery on HA birth and state on broker reconnect', async () => {
    client.emit('message', 'homeassistant/status', Buffer.from('online'), {});
    await vi.waitFor(() => expect(client.publishAsync).toHaveBeenCalledTimes(2));
    control.setState('reset_pending', 'Wake scale');
    client.emit('connect');
    await vi.waitFor(() =>
      expect(client.publishAsync).toHaveBeenCalledWith(
        `${control.baseTopic}/state`,
        JSON.stringify({ state: 'reset_pending', detail: 'Wake scale' }),
        expect.anything(),
      ),
    );
  });
});
