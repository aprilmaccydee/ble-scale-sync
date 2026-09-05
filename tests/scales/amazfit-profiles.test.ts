import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  profileRecord,
  profileFingerprint,
  validateProfiles,
  type AmazfitProfile,
} from '../../src/scales/amazfit/profiles.js';
import { provisionProfiles, readAccounts } from '../../src/scales/amazfit/provision.js';
import { resolveAmazfitProfiles } from '../../src/config/resolve.js';
import { AppConfigSchema } from '../../src/config/schema.js';

const user: AmazfitProfile = {
  id: 1,
  slug: 'aaa',
  name: 'AAA',
  profile: {
    height: 170,
    age: 36,
    gender: 'female',
    isAthlete: false,
    birthDate: '1990-01-01',
    lastKnownWeight: 70,
  },
};
const users = [user, { ...user, id: 2, slug: 'bbb', name: 'BBB' }];

function scale(initial: number[]) {
  let accounts = [...initial];
  const writes: Buffer[] = [];
  let failProfile = false;
  return {
    writes,
    failNextProfile() {
      failProfile = true;
    },
    async request(command: Buffer): Promise<Buffer> {
      writes.push(command);
      const result = Buffer.from([1, 0x10, command[1], 1]);
      if (command[1] === 8) {
        const out = Buffer.alloc(4 + accounts.length * 6);
        out.set([1, 0x10, 8, accounts.length]);
        accounts.forEach((id, i) => out.writeUIntLE(id, 4 + i * 6, 6));
        return out;
      }
      if (command[1] === 7) accounts = accounts.filter((id) => id !== command.readUIntLE(2, 6));
      if (command[1] === 9)
        accounts = Array.from({ length: command[2] }, (_, i) => command.readUIntLE(3 + i * 6, 6));
      if (command[1] === 3 && failProfile) {
        failProfile = false;
        throw new Error('lost connection');
      }
      return result;
    },
  };
}

describe('Amazfit profile provisioning', () => {
  it('matches the complete 276-byte record produced by the live-tested Python encoder', () => {
    const record = profileRecord(user);
    expect(record.length).toBe(276);
    expect(record.subarray(0, 24).toString('hex')).toBe(
      '01030100000000000100000000000000aa581b00c607014a',
    );
    expect(createHash('sha256').update(record).digest('hex')).toBe(
      '44df698a1508d5be9a7245203f07370412c14c045bb41199fdea5d66042b0a46',
    );
  });

  it('creates each person as a primary member under their own account, preserving other accounts', async () => {
    const device = scale([9]);
    await provisionProfiles(device, users);
    expect(await readAccounts(device)).toEqual([9, 1, 2]);
    expect(device.writes.filter((c) => c[1] === 6).map((c) => c.toString('hex'))).toEqual([
      '010601000000000001010000000000',
      '010602000000000001020000000000',
    ]);
    expect(device.writes.some((c) => c[1] === 7)).toBe(false);
  });

  it('verifies account removal before recreation and never deletes newly created accounts on retry', async () => {
    const device = scale([1, 9, 2]);
    const reset = { removed: new Set<number>(), removalVerified: false };
    device.failNextProfile();
    await expect(provisionProfiles(device, users, reset)).rejects.toThrow('lost connection');
    expect(reset.removalVerified).toBe(true);
    expect(device.writes.map((c) => c[1])).toEqual([8, 7, 7, 8, 9, 6, 3]);
    await provisionProfiles(device, users, reset);
    expect(device.writes.filter((c) => c[1] === 7)).toHaveLength(2);
    expect(await readAccounts(device)).toEqual([9, 1, 2]);
  });

  it('does not overwrite accounts after a rejected delete or incorrect removal readback', async () => {
    for (const reject of [true, false]) {
      const device = scale([1, 2]);
      const original = device.request;
      device.request = async (command) =>
        command[1] === 7 ? Buffer.from([1, 0x10, 7, reject ? 0 : 1]) : original(command);
      await expect(
        provisionProfiles(device, users, { removed: new Set(), removalVerified: false }),
      ).rejects.toThrow();
      expect(device.writes.some((c) => c[1] === 9 || c[1] === 3)).toBe(false);
    }
  });

  it('validates the complete profile set before any mutation', async () => {
    const device = scale([]);
    await expect(provisionProfiles(device, [user, user])).rejects.toThrow('unique');
    expect(device.writes).toHaveLength(0);
    expect(() =>
      validateProfiles([{ ...user, profile: { ...user.profile, isAthlete: true } }]),
    ).toThrow('normal mode');
    expect(() =>
      profileRecord({ ...user, profile: { ...user.profile, birthDate: '1990-02-31' } }),
    ).toThrow('birth date');
  });

  it('does not provision again just because an export changed last_known_weight or config order', () => {
    expect(profileFingerprint(users)).toBe(
      profileFingerprint([
        users[1],
        { ...user, profile: { ...user.profile, lastKnownWeight: 71 } },
      ]),
    );
    expect(profileFingerprint(users)).not.toBe(
      profileFingerprint([{ ...user, name: 'CCC' }, users[1]]),
    );
  });

  it('requires an explicit scale address and supported handler before enabling writes', () => {
    const config = AppConfigSchema.parse({
      version: 1,
      ble: {
        handler: 'esphome-proxy',
        scale_mac: 'AA:BB:CC:DD:EE:FF',
        esphome_proxy: { host: 'proxy' },
      },
      runtime: { continuous_mode: true },
      users: [
        {
          name: 'AAA',
          slug: 'aaa',
          amazfit_user_id: 1,
          height: 170,
          birth_date: '1990-01-01',
          gender: 'female',
          is_athlete: false,
          weight_range: { min: 65, max: 75 },
        },
      ],
    });
    expect(resolveAmazfitProfiles(config)[0].profile.lastKnownWeight).toBe(70);
    expect(() =>
      resolveAmazfitProfiles({ ...config, ble: { ...config.ble!, scale_mac: undefined } }),
    ).toThrow('scale_mac');
    expect(() =>
      resolveAmazfitProfiles({ ...config, ble: { ...config.ble!, handler: 'auto' } }),
    ).toThrow('esphome-proxy');
  });
});
