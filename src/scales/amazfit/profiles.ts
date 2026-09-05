import type { UserProfile } from '../../interfaces/scale-adapter.js';

/** One local account per person; the primary member has the same 48-bit ID. */
export interface AmazfitProfile {
  id: number;
  slug: string;
  name: string;
  profile: UserProfile;
}

const FONT = new Map(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '].map((letter, i) => [
    letter,
    Buffer.from(
      [
        '7e1111117e',
        '7f49494936',
        '3e41414122',
        '7f4141221c',
        '7f49494941',
        '7f09090901',
        '3e41495132',
        '7f0808087f',
        '00417f4100',
        '2040403f01',
        '7f08142241',
        '7f40404040',
        '7f020c027f',
        '7f0408107f',
        '3e4141413e',
        '7f09090906',
        '3e4151215e',
        '7f09192946',
        '2649494932',
        '01017f0101',
        '3f4040403f',
        '1f2040201f',
        '3f4038403f',
        '6314081463',
        '0708700807',
        '6151494543',
        '3e5149453e',
        '00427f4000',
        '4261514946',
        '2141454b31',
        '1814127f10',
        '2745454539',
        '3c4a494930',
        '0101710907',
        '3649494936',
        '064949291e',
        '0000000000',
      ][i],
      'hex',
    ),
  ]),
);

export function accountId(id: number): Buffer {
  if (!Number.isSafeInteger(id) || id <= 0 || id >= 0xffffffffffff) {
    throw new Error('Amazfit IDs must be positive 48-bit integers, excluding FFFFFFFFFFFF');
  }
  const bytes = Buffer.alloc(6);
  bytes.writeUIntLE(id, 0, 6);
  return bytes;
}

/** Zepp m0p: three letters, columns first within eight-pixel vertical pages. */
export function nameBitmap(name: string, width: number, height: number, scale: number): Buffer {
  const label = name.toUpperCase().slice(0, 3);
  if (!label.trim() || [...label].some((c) => !FONT.has(c))) {
    throw new Error('Amazfit display names must start with 1–3 ASCII letters or digits');
  }
  const data = Buffer.alloc(1 + width * Math.ceil(height / 8));
  data[0] = data.length - 1;
  const left = Math.floor((width - (label.length * 6 - 1) * scale) / 2);
  const top = Math.floor((height - 7 * scale) / 2);
  [...label].forEach((letter, i) => {
    FONT.get(letter)!.forEach((column, x) => {
      for (let y = 0; y < 7; y++) {
        if (!(column & (1 << y))) continue;
        for (let dx = 0; dx < scale; dx++)
          for (let dy = 0; dy < scale; dy++) {
            const px = left + (i * 6 + x) * scale + dx;
            const py = top + y * scale + dy;
            data[1 + Math.floor(py / 8) * width + px] |= 1 << (py % 8);
          }
      }
    });
  });
  return data;
}

/** Zepp v411.I0: avatar, sex, height, kg x100, normal mode, birth year/month. */
export function profileRecord(user: AmazfitProfile): Buffer {
  const p = user.profile;
  const birth = new Date(`${p.birthDate}T00:00:00Z`);
  if (
    !p.birthDate ||
    !Number.isFinite(birth.getTime()) ||
    birth.toISOString().slice(0, 10) !== p.birthDate ||
    birth >= new Date() ||
    birth.getUTCFullYear() < 1900
  )
    throw new Error('Invalid Amazfit birth date');
  const height = Math.round(p.height);
  if (!Number.isFinite(height) || height < 90 || height > 220) {
    throw new Error('Amazfit height must be 90–220 cm');
  }
  const weight = p.lastKnownWeight;
  if (weight === undefined || !Number.isFinite(weight) || weight < 10 || weight > 180) {
    throw new Error('Amazfit needs a last_known_weight or weight range within 10–180 kg');
  }
  if (p.isAthlete) throw new Error('Amazfit provisioning supports the verified normal mode only');
  const fixed = Buffer.alloc(9);
  fixed[1] = p.gender === 'male' ? 1 : 0;
  fixed[2] = height;
  fixed.writeUInt16LE(Math.round(weight * 100), 3);
  fixed.writeUInt16LE(birth.getUTCFullYear(), 6);
  fixed[8] = birth.getUTCMonth() + 1;
  return Buffer.concat([
    Buffer.from([1, 3]),
    accountId(user.id),
    accountId(user.id),
    fixed,
    nameBitmap(user.name, 37, 12, 1),
    nameBitmap(user.name, 59, 19, 2),
  ]);
}

export function validateProfiles(users: AmazfitProfile[]): void {
  if (
    users.length < 1 ||
    users.length > 10 ||
    new Set(users.map((u) => u.id)).size !== users.length
  ) {
    throw new Error('Configure 1–10 Amazfit users with unique amazfit_user_id values');
  }
  for (const user of users) profileRecord(user);
}

/** Routine weight-anchor updates must not trigger another provisioning session. */
export function profileFingerprint(users: AmazfitProfile[]): string {
  return JSON.stringify(
    users
      .map((u) => ({
        id: u.id,
        slug: u.slug,
        name: u.name,
        height: u.profile.height,
        birthDate: u.profile.birthDate,
        gender: u.profile.gender,
        isAthlete: u.profile.isAthlete,
      }))
      .sort((a, b) => a.id - b.id),
  );
}
