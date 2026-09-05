import { createCipheriv, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseZeppConfig, ZEPP_BASE_URL } from './zepp-config.js';

const LOGIN_URL = 'https://api-user.zepp.com/v2/registrations/tokens';
const REDIRECT_URL = 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html';
const WEB_APP = 'com.huami.webapp';
const MOBILE_APP = 'com.huami.midong';

const CredentialsSchema = z.object({
  username: z.string().trim().email(),
  password: z.string().min(1), // Preserve whitespace in passwords.
  country_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default('US'),
});

export interface ZeppSession {
  app_token: string;
  user_id: string;
  base_url: string;
  expires_at?: string;
}

export class ZeppAuthError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** APK xu40: AES-CBC + PKCS#7, raw bytes with x-hm-ekv: 1 (not base64).
 * Protocol constants corroborated by argrento/huami-token; see the Zepp guide.
 * These are public client protocol constants, not account credentials.
 */
function encodeLogin(form: URLSearchParams): Buffer {
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from('xeNtBVqzDc6tuNTh'),
    Buffer.from('MAAAYAAAAAAAAABg'),
  );
  return Buffer.concat([cipher.update(form.toString(), 'utf8'), cipher.final()]);
}

async function post(url: string, body: URLSearchParams | Buffer, app: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        app_name: app,
        appname: app,
        appplatform: 'android_phone',
        ...(Buffer.isBuffer(body) ? { 'x-hm-ekv': '1' } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ZeppAuthError('Zepp sign-in request failed or timed out');
  }
}

function rejectStatus(status: number): never {
  if (status === 429) {
    throw new ZeppAuthError('Zepp rate-limited sign-in; wait before trying again');
  }
  throw new ZeppAuthError(
    `Zepp sign-in failed (HTTP ${status}); check credentials and API compatibility`,
  );
}

/** Extract only the exporter credentials, rejecting untrusted regional origins. */
export function parseZeppSession(payload: unknown): ZeppSession {
  if (!object(payload) || payload.result !== 'ok' || !object(payload.token_info)) {
    throw new ZeppAuthError('Zepp did not issue a valid session');
  }
  const token = payload.token_info;
  const id = token.user_id;
  if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) {
    throw new ZeppAuthError('Zepp returned an invalid cloud account ID');
  }
  let baseUrl = ZEPP_BASE_URL;
  if (Array.isArray(payload.domains)) {
    const routing = payload.domains.find(
      (entry) => object(entry) && entry.host === 'api-mifit.zepp.com',
    );
    if (object(routing)) {
      if (!Array.isArray(routing.cnames) || typeof routing.cnames[0] !== 'string') {
        throw new ZeppAuthError('Zepp returned invalid regional routing');
      }
      baseUrl = `https://${routing.cnames[0]}`;
    }
  }
  let config;
  try {
    config = parseZeppConfig({
      app_token: token.app_token,
      user_id: String(id),
      base_url: baseUrl,
    });
  } catch {
    throw new ZeppAuthError('Zepp returned invalid session credentials or regional routing');
  }
  const ttl = token.app_ttl;
  return {
    app_token: config.appToken,
    user_id: config.userId,
    base_url: config.baseUrl,
    ...(typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 && ttl <= 31_536_000
      ? { expires_at: new Date(Date.now() + ttl * 1000).toISOString() }
      : {}),
  };
}

/** Use a web application session to avoid signing in as another mobile client.
 * Weight requests must still use appname=com.huami.midong to select the health data.
 * No automatic login retries, account creation, or health-data writes.
 */
export async function loginZepp(input: unknown): Promise<ZeppSession> {
  const checked = CredentialsSchema.safeParse(input);
  if (!checked.success) {
    throw new ZeppAuthError('Provide a Zepp email, password and two-letter country code');
  }
  const credentials = checked.data;
  const form = new URLSearchParams({
    emailOrPhone: credentials.username,
    password: credentials.password,
    state: 'REDIRECTION',
    client_id: 'HuaMi',
    region: 'us-west-2',
    country_code: credentials.country_code,
    redirect_uri: REDIRECT_URL,
  });
  form.append('token', 'access');
  form.append('token', 'refresh');
  const tokenResponse = await post(LOGIN_URL, encodeLogin(form), MOBILE_APP);
  await tokenResponse.body?.cancel();
  if (tokenResponse.status !== 303) rejectStatus(tokenResponse.status);
  let redirect: URL;
  try {
    redirect = new URL(tokenResponse.headers.get('location') ?? '');
  } catch {
    throw new ZeppAuthError('Zepp returned an invalid sign-in redirect');
  }
  const expected = new URL(REDIRECT_URL);
  if (
    redirect.origin !== expected.origin ||
    redirect.pathname !== expected.pathname ||
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    redirect.searchParams.get('state') !== 'REDIRECTION'
  ) {
    throw new ZeppAuthError('Zepp returned an unexpected sign-in redirect');
  }
  const access = redirect.searchParams.get('access');
  if (redirect.searchParams.has('error') || !access) {
    throw new ZeppAuthError('Zepp rejected sign-in; check your email and password in the app');
  }
  const countryCode = redirect.searchParams.get('country_code') || credentials.country_code;
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new ZeppAuthError('Zepp returned an invalid account country');
  }
  const response = await post(
    `${ZEPP_BASE_URL}/v2/client/login`,
    new URLSearchParams({
      third_name: 'huami',
      app_name: WEB_APP,
      grant_type: 'access_token',
      code: access,
      device_id: randomUUID(),
      device_model: 'android_phone',
      app_version: '10.8.1-play',
      country_code: countryCode,
      dn: 'api-mifit.zepp.com,api-user.zepp.com',
      allow_registration: 'false',
      lang: 'en',
    }),
    WEB_APP,
  );
  if (!response.ok) {
    await response.body?.cancel();
    rejectStatus(response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ZeppAuthError('Zepp returned an invalid session response');
  }
  return parseZeppSession(payload);
}
