import type { UserProfile } from '../../interfaces/scale-adapter.js';

/**
 * A2003 composition, recovered from Zepp 10.8.1's
 * libhtBodyfatBia4TwoLegs.so, BodyFatVersion 1.29.
 * SHA256: 1065c0fddddcab561629ac9b8626026ced453c2e0b446ee57e25189cec6efe4c
 *
 * The library uses unsigned integer intermediates and float32 JNI outputs.
 * Preserve its operation order, truncation and wraparound. Do not substitute
 * generic BIA formulas or simplify expressions across integer divisions.
 * Reference vectors come from executing the original ARM64 library offline.
 */
export interface AmazfitComposition {
  bmi: number;
  bodyFatPercent: number;
  waterPercent: number;
  boneMass: number;
  muscleMass: number;
  visceralFat: number;
  physiqueRating: number;
  bmr: number;
  metabolicAge: number;
  proteinPercent: number;
  skeletalMuscleMass: number;
  subcutaneousFatPercent: number;
  subcutaneousFatMass: number;
  bodyFatMass: number;
  fatFreeMass: number;
  musclePercent: number;
  idealWeight: number;
}

const u32 = (n: number): number => n >>> 0;
const div = (n: number, d: number): number => Math.floor(u32(n) / d);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));
const f32 = Math.fround;
const tenth = (n: number): number => f32(n / 10);

// First/last thresholds from the library's age-indexed body-fat tables at
// ELF 0x5188 (male) and 0x5278 (female). Entries 0..12 are ages 6..18,
// then entry 12 for 19..39, 13 for 40..59 and 14 for 60..99.
const FAT_LIMITS = {
  male: [
    [70, 300],
    [70, 300],
    [70, 300],
    [70, 300],
    [70, 300],
    [70, 300],
    [70, 300],
    [70, 300],
    [70, 290],
    [80, 290],
    [80, 280],
    [90, 280],
    [110, 270],
    [120, 280],
    [140, 300],
  ],
  female: [
    [80, 290],
    [90, 300],
    [100, 310],
    [100, 320],
    [110, 330],
    [130, 350],
    [140, 360],
    [150, 380],
    [170, 390],
    [180, 410],
    [190, 410],
    [200, 410],
    [210, 400],
    [220, 410],
    [230, 420],
  ],
} as const;

function bodyType(fat: number, muscle: number, h: number, age: number, male: boolean): number {
  const ageIndex = age <= 18 ? age - 6 : age < 40 ? 12 : age < 60 ? 13 : 14;
  const [fatLow, fatHigh] = FAT_LIMITS[male ? 'male' : 'female'][ageIndex];
  const [muscleLow, muscleHigh] = male
    ? h < 160
      ? [385, 465]
      : h < 170
        ? [440, 524]
        : [495, 594]
    : h < 160
      ? [291, 347]
      : h < 170
        ? [329, 375]
        : [365, 425];
  const fatBand = fat < fatLow ? 0 : fat <= fatHigh ? 1 : 2;
  const muscleBand = muscle < muscleLow ? 0 : muscle < muscleHigh ? 1 : 2;
  return fatBand * 3 + muscleBand + 1;
}

function bodyAge(bmi: number, age: number): number {
  let value = age - 3;
  const limit = bmi >= 300 ? 8 : 5;
  if (bmi >= 300) value = Math.max(0, value - div(14 * bmi - 3080, 100));
  else if (bmi <= 219) value = Math.max(0, value - div((220 - bmi) * 17, 100));
  else value = u32(value + div(17 * bmi - 3740, 100));
  return clamp(Math.max(Math.min(value, age + limit), u32(age - limit)), 6, 99);
}

function basalMetabolism(
  w: number,
  h: number,
  age: number,
  male: boolean,
  athlete: boolean,
): number {
  let value = male
    ? Math.max(0, div(div(w * 149, 10) + 8774 - div(h * 73, 10), 10) - age * 9)
    : div(div(w * 102, 10) + 8645 - h * 4 - age * 62, 10);
  if (athlete) value = u32(div(value * 116, 100) - 149);
  return clamp(value, 500, 5000);
}

function visceralFat(w: number, h: number, age: number, male: boolean, athlete: boolean): number {
  let value: number;
  if (male) {
    value =
      h > div(16 * w, 100) + 63
        ? Math.max(0, div((7650 - 15 * h) * w, 10000) + div(15 * age, 10) - div(143 * h, 100) - 50)
        : Math.max(
            0,
            div(305 * w, div(826 * h * h - 4000 * h + 480000, 10000)) + div(15 * age, 10) - 29,
          );
  } else {
    value =
      w > 5 * h - 130
        ? u32(div(w * 500000, u32((1158 * h + 14500) * h - 1200000)) * 10 + div(7 * age, 10) - 60)
        : Math.max(0, div((6910 - 24 * h) * w, 10000) + div(7 * age, 10) - div(27 * h, 100) - 105);
  }
  const rounded = u32(value + 4);
  value = div(rounded, 10);
  if (athlete) {
    if (rounded < 20) value = 1;
    else if (rounded <= 99) value = u32(value - 2);
    else if (rounded < 200) value = div(value * 8, 10);
    else value = div(value * 85, 100);
  }
  return clamp(value, 1, 50);
}

/** Inputs are kg/cm/years/decoded integer ohms; null means the library rejects them. */
export function computeAmazfitComposition(
  weight: number,
  impedance: number,
  profile: UserProfile,
): AmazfitComposition | null {
  const kg = f32(weight);
  const cm = f32(profile.height);
  const age = profile.age;
  if (
    !Number.isFinite(kg) ||
    kg < 10 ||
    kg > 200 ||
    !Number.isFinite(cm) ||
    cm < 90 ||
    cm > 220 ||
    !Number.isInteger(age) ||
    age < 6 ||
    age > 99 ||
    !Number.isInteger(impedance) ||
    impedance < 200 ||
    impedance > 1200 ||
    !['male', 'female'].includes(profile.gender) ||
    typeof profile.isAthlete !== 'boolean'
  )
    return null;

  const w = Math.trunc(f32(kg * 10));
  const h = Math.trunc(cm);
  const h2 = h * h;
  const male = profile.gender === 'male';
  const athlete = profile.isAthlete;
  const bmi = clamp(div(div(w * 100000, h2) + 5, 10), 100, 900);

  // getFFM 0x31f0; bone is calculated BEFORE the sex/weight fat adjustments.
  let leanCoefficient = div(
    div(h2 * 9058, 1000) + w * 320 - impedance * 68 - age * 542 + 122260,
    100,
  );
  const boneCoefficient = u32(div(leanCoefficient * 52, 1000) - (male ? 18 : 25));
  const boneRounded = u32(boneCoefficient + (boneCoefficient > 220 ? 10 : -10) + 5);
  let bone = div(boneRounded, 10);
  if (athlete) bone += boneRounded < 200 ? 1 : boneRounded < 300 ? 2 : 3;
  bone = clamp(bone, 5, 80);

  // getBodyFatRate 0x3350 maintains a separate pre-athlete fat value for water.
  if (male) {
    leanCoefficient = u32(leanCoefficient - 80);
    if (w <= 609) leanCoefficient = div(leanCoefficient * 98, 100);
  } else {
    leanCoefficient = u32(leanCoefficient - (age < 50 ? 925 : 725));
    if (w < 500) leanCoefficient = div(leanCoefficient * 102, 100);
    else if (w >= 601) leanCoefficient = div(leanCoefficient * 96, 100);
    if (h >= 161) leanCoefficient = div(leanCoefficient * 103, 100);
  }
  let fat = 50;
  if (w * 10 > leanCoefficient) {
    let fatCoefficient = w * 10 - leanCoefficient;
    if (athlete)
      fatCoefficient = u32(div(fatCoefficient * (male ? 778 : 992), 1000) - (male ? 93 : 150));
    fat = div(fatCoefficient * 100, w);
  }
  fat = clamp(fat, 50, 750);
  const leanRate = div(leanCoefficient * 100, w);
  const fatBeforeAthlete = clamp(leanRate < 1000 ? 1000 - leanRate : 50, 50, 750);
  const fatDeciKg = div(fat * w, 1000);
  const muscle = clamp(u32(w - fatDeciKg - bone), 5, 1200);

  // getWaterRate 0x3b4c and getProteinRate 0x3c34.
  const waterBase = 7000 - 7 * fatBeforeAthlete;
  let water = div(div(waterBase * (waterBase >>> 3 > 624 ? 98 : 102), 100) + 5, 10);
  if (athlete) water = div(water * (male ? 996 : 985), 1000) + (male ? 4 : 9);
  water = clamp(water, 350, 750);
  const protein = clamp(u32(1000 - fat - div(water * 108, 100) - div(bone * 1000, w)), 20, 300);

  // getBodyfatSubcutKg 0x3990 uses a signed intermediate, unlike the rest.
  const subcutCoefficient = clamp(
    Math.trunc(((31 * impedance + 940 * bmi + 1049 * age - 210772) | 0) / 1000),
    10,
    300,
  );
  let subcut = Math.max(0, fatDeciKg - div(subcutCoefficient * 94, 340));
  if (athlete) subcut = div(subcut * 85, 100);
  subcut = clamp(subcut, div(w, 100), div(w * 6, 10));
  const skeletal = div(div(w * water, 1000) * 832 - 27354, 1000);

  return {
    bmi: tenth(bmi),
    bodyFatPercent: tenth(fat),
    waterPercent: tenth(water),
    boneMass: tenth(bone),
    muscleMass: tenth(muscle),
    visceralFat: visceralFat(w, h, age, male, athlete),
    physiqueRating: bodyType(fat, muscle, h, age, male),
    bmr: basalMetabolism(w, h, age, male, athlete),
    metabolicAge: bodyAge(bmi, age),
    proteinPercent: tenth(protein),
    skeletalMuscleMass: tenth(skeletal),
    subcutaneousFatPercent: f32(f32(subcut * 100) / w),
    subcutaneousFatMass: tenth(subcut),
    bodyFatMass: f32(f32(fat * w) / 10000),
    // The JNI wrapper subtracts WHOLE kg of fat here; preserve that quirk.
    fatFreeMass: f32(tenth(w) - div(fat * w, 10000)),
    musclePercent: f32(f32(muscle * 100) / w),
    idealWeight: tenth(div(h2 * 220, 10000)),
  };
}
