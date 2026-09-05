import type { FamilyChannel } from './channel.js';
import { accountId, profileRecord, validateProfiles, type AmazfitProfile } from './profiles.js';

export async function readAccounts(channel: FamilyChannel): Promise<number[]> {
  const data = await channel.request(Buffer.from([1, 8]));
  if (
    data.length < 4 ||
    !data.subarray(0, 3).equals(Buffer.from([1, 0x10, 8])) ||
    data.length !== 4 + data[3] * 6 ||
    data[3] > 10
  )
    throw new Error('Malformed Amazfit account list');
  const accounts = Array.from({ length: data[3] }, (_, i) => data.readUIntLE(4 + i * 6, 6));
  if (new Set(accounts).size !== accounts.length) throw new Error('Duplicate Amazfit accounts');
  accounts.forEach(accountId);
  return accounts;
}

async function writeCommand(channel: FamilyChannel, command: Buffer): Promise<void> {
  const response = await channel.request(command);
  if (!response.equals(Buffer.from([1, 0x10, command[1], 1]))) {
    throw new Error(
      `Amazfit rejected command ${command[1].toString(16)}: ${response.toString('hex')}`,
    );
  }
}

function sameAccounts(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Kept across retry attempts so an interrupted recreation never deletes its new profiles. */
export interface ResetProgress {
  removed: Set<number>;
  removalVerified: boolean;
}

/** v411.O0 unbind, then s1/i1/I0 register + roster + profile, with readbacks. */
export async function provisionProfiles(
  channel: FamilyChannel,
  users: AmazfitProfile[],
  reset?: ResetProgress,
): Promise<void> {
  validateProfiles(users); // Validate everything before the first device mutation.
  let accounts = await readAccounts(channel);
  const ids = users.map((u) => u.id);
  if (new Set([...accounts, ...ids]).size > 10)
    throw new Error('Amazfit account capacity exceeded');
  if (reset && !reset.removalVerified) {
    for (const id of ids) {
      if (!reset.removed.has(id) && accounts.includes(id)) {
        await writeCommand(channel, Buffer.concat([Buffer.from([1, 7]), accountId(id)]));
      }
      reset.removed.add(id);
    }
    const remaining = accounts.filter((id) => !ids.includes(id));
    accounts = await readAccounts(channel);
    if (!sameAccounts(accounts, remaining)) throw new Error('Account removal readback failed');
    reset.removalVerified = true;
  }
  const wanted = [...accounts, ...ids.filter((id) => !accounts.includes(id))];
  if (!sameAccounts(wanted, accounts)) {
    await writeCommand(
      channel,
      Buffer.concat([Buffer.from([1, 9, wanted.length]), ...wanted.map(accountId)]),
    );
  }
  for (const user of users) {
    await writeCommand(
      channel,
      Buffer.concat([
        Buffer.from([1, 6]),
        accountId(user.id),
        Buffer.from([1]),
        accountId(user.id),
      ]),
    );
    await writeCommand(channel, profileRecord(user));
  }
  if (!sameAccounts(await readAccounts(channel), wanted))
    throw new Error('Profile account readback failed');
}
