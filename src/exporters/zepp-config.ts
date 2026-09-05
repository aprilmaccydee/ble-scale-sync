import { z } from 'zod';

export const ZEPP_BASE_URL = 'https://api-mifit.zepp.com';

function isZeppOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /^api-mifit(?:-[a-z0-9-]+)?\.(zepp|huami)\.com$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const ZeppConfigSchema = z
  .object({
    username: z
      .string()
      .trim()
      .refine((v) => v === '' || z.email().safeParse(v).success, 'Use your Zepp email')
      .optional(),
    password: z.string().optional(),
    country_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Use a two-letter country code')
      .default('US'),
    token_dir: z.string().min(1).default('./zepp-tokens'),
    app_token: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]+$/, 'A Zepp app token is required')
      .optional(),
    // Keep account/member IDs as strings: cloud IDs can exceed JS integer precision.
    user_id: z
      .string()
      .regex(/^[1-9]\d*$/, 'Quote the numeric Zepp cloud user ID')
      .optional(),
    member_id: z
      .string()
      .regex(/^(?:-1|[1-9]\d*)$/, 'Use -1 or a quoted cloud member ID')
      .default('-1'),
    base_url: z
      .string()
      .refine(isZeppOrigin, 'Use an HTTPS api-mifit Zepp/Huami origin')
      .default(ZEPP_BASE_URL),
    device_id: z
      .string()
      .regex(/^[A-Za-z0-9:_-]+$/)
      .optional(),
    device_source: z.number().int().min(-1).max(2147483647).default(-1),
    time_zone: z.string().refine(isTimeZone, 'Use a valid IANA time zone').optional(),
    upload_mode: z.enum(['full', 'weight_impedance']).default('full'),
  })
  .superRefine((c, ctx) => {
    const credentials = c.username !== undefined || c.password !== undefined;
    if (credentials) {
      if (c.username === undefined || c.password === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: 'Provide both username and password (empty strings leave Zepp unconfigured)',
        });
      }
      if (c.app_token !== undefined || c.user_id !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['app_token'],
          message: 'Use username/password or app_token/user_id, not both',
        });
      }
    } else if (!c.app_token || !c.user_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['app_token'],
        message: 'Provide username/password or app_token/user_id',
      });
    }
  });

/** Explicit blank credential entries are placeholders, excluded from runtime exporters. */
export function isZeppPlaceholder(entry: Record<string, unknown>): boolean {
  return (
    entry.type === 'zepp' &&
    typeof entry.username === 'string' &&
    typeof entry.password === 'string' &&
    (!entry.username.trim() || entry.password.length === 0)
  );
}

export interface ZeppConfig {
  credentials?: { username: string; password: string; country_code: string };
  tokenDir: string;
  appToken: string;
  userId: string;
  memberId: string;
  baseUrl: string;
  deviceId?: string;
  deviceSource: number;
  timeZone: string;
  uploadMode: 'full' | 'weight_impedance';
}

export function parseZeppConfig(input: Record<string, unknown>): ZeppConfig {
  const result = ZeppConfigSchema.safeParse(input);
  if (!result.success) {
    // Never include supplied values (especially tokens) in config diagnostics.
    throw new Error(
      `Invalid Zepp config: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const c = result.data;
  return {
    ...(c.username !== undefined && c.password !== undefined
      ? {
          credentials: { username: c.username, password: c.password, country_code: c.country_code },
        }
      : {}),
    tokenDir: c.token_dir,
    appToken: c.app_token ?? '',
    userId: c.user_id ?? '',
    memberId: c.member_id === c.user_id ? '-1' : c.member_id,
    baseUrl: new URL(c.base_url).origin,
    deviceId: c.device_id,
    deviceSource: c.device_source,
    timeZone: c.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    uploadMode: c.upload_mode,
  };
}
