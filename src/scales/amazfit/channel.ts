import { setTimeout as delay } from 'node:timers/promises';
import type { BleChar, BleDevice } from '../../ble/shared.js';
import { AsyncQueue } from '../../ble/async-queue.js';
import { normalizeUuid } from '../../ble/types.js';

export const CHANNEL_DOWN = '00000016-0000-3512-2118-0009af100700';
export const CHANNEL_UP = '00000017-0000-3512-2118-0009af100700';

/** Zepp 10.8.1 zzc/n1d/i3v: plaintext Huami channel v1, 20-byte writes. */
export function packets(module: number, payload: Buffer, session: number): Buffer[] {
  if (!payload.length || payload.length > 65536) throw new Error('Invalid channel payload size');
  const result: Buffer[] = [];
  for (let offset = 0, index = 0; offset < payload.length; index++) {
    const first = offset === 0;
    const end = Math.min(payload.length, offset + (first ? 10 : 16));
    const last = end === payload.length;
    const header = Buffer.alloc(first ? 10 : 4);
    header[0] = 3;
    header[1] = Number(first) | (last ? 2 : 0) | (last || (index + 1) % 16 === 0 ? 4 : 0);
    header[2] = session;
    header[3] = index % 256;
    if (first) {
      header.writeUInt32LE(payload.length, 4);
      header.writeUInt16LE(module, 8);
    }
    result.push(Buffer.concat([header, payload.subarray(offset, end)]));
    offset = end;
  }
  return result;
}

export class Assembler {
  private active?: { session: number; index: number; length: number; module: number; data: Buffer };

  feed(packet: Buffer): { ack?: Buffer; message?: { module: number; data: Buffer } } {
    if (packet.length < 4 || packet[0] !== 3) throw new Error('Malformed channel packet');
    const [, flags, session, index] = packet;
    if (flags & 8) throw new Error('Encrypted Huami channel is unsupported');
    if (flags & 1) {
      if (packet.length < 10 || index !== 0 || this.active)
        throw new Error('Invalid first fragment');
      const length = packet.readUInt32LE(4);
      if (!length || length > 65536) throw new Error('Invalid channel message length');
      this.active = {
        session,
        index: 0,
        length,
        module: packet.readUInt16LE(8),
        data: Buffer.alloc(0),
      };
    }
    const a = this.active;
    if (!a || a.session !== session || a.index !== index) throw new Error('Out-of-order fragment');
    a.index = (index + 1) % 256;
    a.data = Buffer.concat([a.data, packet.subarray(flags & 1 ? 10 : 4)]);
    if (a.data.length > a.length) throw new Error('Channel message exceeds its length');
    const result: ReturnType<Assembler['feed']> = {};
    if (flags & 2) {
      if (a.data.length !== a.length) throw new Error('Truncated channel message');
      result.message = { module: a.module, data: a.data };
      this.active = undefined;
    }
    if (flags & 4) result.ack = Buffer.from([4, session, 1, index]);
    return result;
  }
}

export interface FamilyChannel {
  request(command: Buffer): Promise<Buffer>;
}

export class AmazfitChannel implements FamilyChannel {
  private readonly down: BleChar;
  private readonly up: BleChar;
  private readonly queue = new AsyncQueue<{ upstream: boolean; packet: Buffer }>();
  private readonly assembler = new Assembler();
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly unsubscribers: Array<() => void> = [];
  private session = 0;

  constructor(charMap: Map<string, BleChar>, device: BleDevice, signal?: AbortSignal) {
    const down = charMap.get(normalizeUuid(CHANNEL_DOWN));
    const up = charMap.get(normalizeUuid(CHANNEL_UP));
    if (!down || !up) throw new Error('Amazfit Huami channel characteristics are missing');
    this.down = down;
    this.up = up;
    this.signal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    device.onDisconnect(() =>
      this.abort.abort(new Error('Scale disconnected during profile setup')),
    );
  }

  async open(): Promise<void> {
    for (const [char, upstream] of [
      [this.down, false],
      [this.up, true],
    ] as const) {
      this.unsubscribers.push(
        await char.subscribe((packet) => this.queue.push({ upstream, packet })),
      );
    }
    this.signal.throwIfAborted();
    await this.down.write(Buffer.from([1]), false);
    const { upstream, packet } = await this.queue.shift(
      AbortSignal.any([this.signal, AbortSignal.timeout(10_000)]),
    );
    if (upstream || !packet.equals(Buffer.from([2, 1])))
      throw new Error('Unsupported Huami channel version');
  }

  async request(command: Buffer): Promise<Buffer> {
    this.signal.throwIfAborted();
    const session = this.session++ % 256;
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]);
    const acks = new Set<number>();
    let response: Buffer | undefined;
    const receive = async (): Promise<void> => {
      const { upstream, packet } = await this.queue.shift(signal);
      if (!upstream && packet[0] === 4) {
        if (packet.length !== 4 || packet[1] !== session || packet[2] !== 1) {
          throw new Error(`Huami packet rejected: ${packet.toString('hex')}`);
        }
        acks.add(packet[3]);
      } else if (upstream && packet[0] === 3) {
        const { ack, message } = this.assembler.feed(packet);
        if (ack) await this.up.write(ack, false);
        if (message) {
          const { module, data } = message;
          const matches =
            command[0] === 3 && command[1] === 0x0d
              ? data.length >= 3 && data[0] === 3 && data[1] === 0x0e && data[2] === command[2]
              : data.length >= 3 && data[0] === 1 && data[1] === 0x10 && data[2] === command[1];
          if (module !== 32 || !matches) {
            throw new Error('Unexpected Amazfit command response');
          }
          response = data;
        }
      } else {
        throw new Error(`Unexpected Huami packet: ${packet.toString('hex')}`);
      }
    };
    for (const packet of packets(32, command, session)) {
      signal.throwIfAborted();
      await this.down.write(packet, false);
      if (packet[1] & 4) {
        while (!acks.has(packet[3])) await receive();
      } else {
        await delay(30, undefined, { signal });
      }
    }
    while (!response) await receive();
    return response;
  }

  close(): void {
    this.abort.abort(new Error('Amazfit channel closed'));
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
