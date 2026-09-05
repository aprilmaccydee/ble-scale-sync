import { describe, it, expect, vi } from 'vitest';
import {
  Assembler,
  packets,
  AmazfitChannel,
  CHANNEL_DOWN,
  CHANNEL_UP,
} from '../../src/scales/amazfit/channel.js';
import type { BleChar } from '../../src/ble/shared.js';
import { normalizeUuid } from '../../src/ble/types.js';

describe('Huami channel v1', () => {
  it('matches captured account query and response packets', () => {
    expect(packets(32, Buffer.from([1, 8]), 0).map((b) => b.toString('hex'))).toEqual([
      '030700000200000020000108',
    ]);
    const result = new Assembler().feed(Buffer.from('0307010004000000200001100800', 'hex'));
    expect(result.ack?.toString('hex')).toBe('04010100');
    expect(result.message?.data.toString('hex')).toBe('01100800');
    expect(result.message?.module).toBe(32);
  });

  it('fragments profiles with ACKs at fragment 15 and the final fragment', () => {
    const payload = Buffer.alloc(276, 0xab);
    const frames = packets(32, payload, 7);
    const assembler = new Assembler();
    const acks: number[] = [];
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(20);
      const { ack, message } = assembler.feed(frame);
      if (ack) acks.push(ack[3]);
      if (message) expect(message.data).toEqual(payload);
    }
    expect(acks).toEqual([15, 17]);
  });

  it('rejects missing fragments, truncated replies and encryption', () => {
    const frames = packets(32, Buffer.alloc(50), 0);
    const assembler = new Assembler();
    assembler.feed(frames[0]);
    expect(() => assembler.feed(frames[2])).toThrow('Out-of-order');
    expect(() => new Assembler().feed(Buffer.from('03070100040000002000011008', 'hex'))).toThrow(
      'Truncated',
    );
    expect(() => new Assembler().feed(Buffer.from('030f010004000000200001100800', 'hex'))).toThrow(
      'Encrypted',
    );
  });

  it.each([
    ['0108', '01100800'],
    ['030d00', '030e000101'],
    ['030d0100', '030e0101'],
  ])('routes command %s, handles reply before ACK and ACKs UP', async (command, response) => {
    const notifications = new Map<string, (data: Buffer) => void>();
    const writes: Array<[string, string]> = [];
    const unsub = vi.fn();
    const chars = new Map<string, BleChar>();
    for (const uuid of [CHANNEL_DOWN, CHANNEL_UP]) {
      chars.set(normalizeUuid(uuid), {
        read: vi.fn(),
        subscribe: async (cb) => {
          notifications.set(uuid, cb);
          return unsub;
        },
        write: async (data) => {
          writes.push([uuid, data.toString('hex')]);
          expect(notifications.size).toBe(2);
          if (data.equals(Buffer.from([1]))) notifications.get(CHANNEL_DOWN)!(Buffer.from([2, 1]));
          if (data[0] === 3) {
            notifications.get(CHANNEL_UP)!(packets(32, Buffer.from(response, 'hex'), 1)[0]);
            notifications.get(CHANNEL_DOWN)!(Buffer.from([4, data[2], 1, data[3]]));
          }
        },
      });
    }
    const channel = new AmazfitChannel(chars, { onDisconnect: vi.fn() });
    await channel.open();
    expect(await channel.request(Buffer.from(command, 'hex'))).toEqual(
      Buffer.from(response, 'hex'),
    );
    expect(writes).toContainEqual([CHANNEL_UP, '04010100']);
    channel.close();
    expect(unsub).toHaveBeenCalledTimes(2);
  });

  it('aborts an unanswered version query on disconnect and removes listeners', async () => {
    let disconnect: () => void = () => {};
    const unsubscribe = vi.fn();
    const characteristic = {
      read: vi.fn(),
      subscribe: async () => unsubscribe,
      write: async () => disconnect(),
    };
    const chars = new Map(
      [CHANNEL_DOWN, CHANNEL_UP].map((u) => [normalizeUuid(u), characteristic]),
    );
    const channel = new AmazfitChannel(chars, {
      onDisconnect: (cb) => {
        disconnect = cb;
      },
    });
    await expect(channel.open()).rejects.toThrow('disconnected');
    channel.close();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
