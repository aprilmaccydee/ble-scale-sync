import type { FamilyChannel } from './channel.js';

/** A2003 V1.0.0.16, verified against Zepp and hardware readbacks. */
export async function readStress(channel: FamilyChannel): Promise<boolean> {
  const reply = await channel.request(Buffer.from([3, 0x0d, 0]));
  if (
    reply.length !== 5 ||
    !reply.subarray(0, 4).equals(Buffer.from([3, 0x0e, 0, 1])) ||
    reply[4] > 1
  )
    throw new Error(`Invalid Amazfit stress readback: ${reply.toString('hex')}`);
  return reply[4] === 1;
}

/** Query first, avoid redundant writes, and never report success from ACK alone. */
export async function reconcileStress(channel: FamilyChannel, desired?: boolean): Promise<boolean> {
  const actual = await readStress(channel);
  if (desired === undefined || actual === desired) return actual;
  const reply = await channel.request(Buffer.from([3, 0x0d, 1, Number(desired)]));
  if (!reply.equals(Buffer.from([3, 0x0e, 1, 1])))
    throw new Error(`Amazfit rejected stress setting: ${reply.toString('hex')}`);
  if ((await readStress(channel)) !== desired) throw new Error('Amazfit stress readback mismatch');
  return desired;
}
