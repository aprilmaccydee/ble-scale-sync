import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeAmazfitComposition } from '../../src/scales/amazfit/body-composition.js';
import { AmazfitSmartScaleAdapter } from '../../src/scales/amazfit-smart-scale.js';
import { buildPayload, computeBiaFat } from '../../src/scales/body-comp-helpers.js';
import type { UserProfile } from '../../src/interfaces/scale-adapter.js';

const reference = JSON.parse(
  readFileSync(new URL('../fixtures/amazfit-zepp-1.29.json', import.meta.url), 'utf8'),
) as {
  sha256: string;
  outputKeys: string[];
  cases: number[][];
};
const profile: UserProfile = { height: 178, age: 33, gender: 'female', isAthlete: false };
const reading = { weight: 100, impedance: 553, heartRate: 70, stress: 39 };

describe('Zepp A2003 native algorithm parity', () => {
  it('exactly matches every float32/integer output in 2,832 native reference cases', () => {
    expect(reference.sha256).toBe(
      '1065c0fddddcab561629ac9b8626026ced453c2e0b446ee57e25189cec6efe4c',
    );
    expect(reference.cases).toHaveLength(2832);
    expect(reference.outputKeys).toHaveLength(17);
    for (const row of reference.cases) {
      const [weight, height, age, sex, mode, impedance] = row;
      const actual = computeAmazfitComposition(weight, impedance, {
        height,
        age,
        gender: sex === 1 ? 'male' : 'female',
        isAthlete: mode === 1,
      });
      const expected = Object.fromEntries(reference.outputKeys.map((key, i) => [key, row[i + 6]]));
      expect(actual, `native input ${JSON.stringify(row.slice(0, 6))}`).toEqual(expected);
    }
  });

  it.each([199, 1201, 0, NaN, Infinity, 553.5])('rejects unsupported impedance %s', (impedance) => {
    expect(computeAmazfitComposition(100, impedance, profile)).toBeNull();
  });

  it.each([9.99, 200.01, NaN, Infinity])('rejects unsupported weight %s', (weight) => {
    expect(computeAmazfitComposition(weight, 553, profile)).toBeNull();
  });

  it.each([
    { height: 89.9 },
    { height: 220.01 },
    { height: NaN },
    { age: 5 },
    { age: 100 },
    { age: 33.5 },
  ])('rejects unsupported demographics %j', (changes) => {
    expect(computeAmazfitComposition(100, 553, { ...profile, ...changes })).toBeNull();
  });
});

describe('Amazfit algorithm selection', () => {
  it('keeps the existing calculation by default and switches without resetting profiles', () => {
    const adapter = new AmazfitSmartScaleAdapter();
    const generic = {
      ...buildPayload(100, 553, { fat: computeBiaFat(100, 553, profile) }, profile),
      heartRate: 70,
      stress: 39,
    };
    expect(adapter.computeMetrics(reading, profile)).toEqual(generic);
    adapter.configure({ amazfitAlgorithm: 'zepp' });
    expect(adapter.computeMetrics(reading, profile)).toEqual({
      weight: 100,
      impedance: 553,
      bmi: 31.6,
      bodyFatPercent: 42.5,
      waterPercent: 41,
      boneMass: 3.4,
      muscleMass: 54.1,
      visceralFat: 9,
      physiqueRating: 9,
      bmr: 1608,
      metabolicAge: 25,
      proteinPercent: 9.9,
      skeletalMuscleMass: 31.3,
      subcutaneousFatPercent: 38.7,
      subcutaneousFatMass: 38.7,
      bodyFatMass: 42.5,
      fatFreeMass: 58,
      musclePercent: 54.1,
      idealWeight: 69.7,
      heartRate: 70,
      stress: 39,
    });
    adapter.configure({ amazfitAlgorithm: 'generic' });
    expect(adapter.computeMetrics(reading, profile)).toEqual(generic);
    adapter.configure({ amazfitAlgorithm: 'zepp' });
    adapter.configure({}); // Removing the setting on reload restores the default.
    expect(adapter.computeMetrics(reading, profile)).toEqual(generic);
  });

  it('falls back on rejected input and does not reuse optional composition or pulse/stress', () => {
    const adapter = new AmazfitSmartScaleAdapter();
    adapter.configure({ amazfitAlgorithm: 'zepp' });
    expect(adapter.computeMetrics(reading, profile).proteinPercent).toBe(9.9);
    const fallback = adapter.computeMetrics({ weight: 100, impedance: 0 }, profile);
    expect(fallback).toEqual(buildPayload(100, 0, {}, profile));
    expect(fallback).not.toHaveProperty('proteinPercent');
    expect(fallback).not.toHaveProperty('heartRate');
    expect(fallback).not.toHaveProperty('stress');
  });
});
