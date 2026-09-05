import { setTimeout as delay } from 'node:timers/promises';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import { parseZeppConfig, type ZeppConfig } from './zepp-config.js';
import { ZeppSessionManager } from './zepp-session.js';

export const zeppSchema: ExporterSchema = {
  name: 'zepp',
  displayName: 'Zepp (experimental)',
  description: 'Upload weight and body composition to Zepp with automatic web-session renewal',
  supportsGlobal: false,
  supportsPerUser: true,
  fields: [
    { key: 'username', label: 'Zepp email', type: 'string', required: true },
    { key: 'password', label: 'Zepp password', type: 'password', required: true },
    {
      key: 'country_code',
      label: 'Country code (e.g. GB)',
      type: 'string',
      required: false,
      default: 'US',
    },
    {
      key: 'member_id',
      label: 'Zepp family member ID (-1 for account owner)',
      type: 'string',
      required: false,
      default: '-1',
    },
    {
      key: 'token_dir',
      label: 'Session cache directory',
      type: 'string',
      required: false,
      default: './zepp-tokens',
    },
    { key: 'device_id', label: 'Scale device ID / Bluetooth MAC', type: 'string', required: false },
    {
      key: 'device_source',
      label: 'Zepp device source (-1 unknown, 104 Amazfit Smart Scale)',
      type: 'number',
      required: false,
      default: -1,
    },
    { key: 'time_zone', label: 'Measurement time zone', type: 'string', required: false },
    {
      key: 'upload_mode',
      label: 'Measurements to upload',
      type: 'select',
      required: false,
      default: 'full',
      choices: [
        { label: 'Weight and calculated body composition', value: 'full' },
        { label: 'Weight and impedance only', value: 'weight_impedance' },
      ],
    },
  ],
};

export interface ZeppWeightRecord {
  userId: string;
  memberId: string;
  deviceSource: number;
  appName: string;
  generatedTime: number;
  createTime: number;
  weightType: number;
  dataSource: number;
  deviceId?: string;
  summary: Record<string, number | string | boolean>;
}

/** Zepp 10.8.1: i19.b -> dni0.R -> j19/hec1. See docs/guide/zepp.md. */
export function buildZeppRecord(
  config: ZeppConfig,
  data: BodyComposition,
  context: ExportContext = {},
  timestamp = context.timestamp ?? new Date(),
): ZeppWeightRecord {
  if (!Number.isFinite(data.weight) || data.weight <= 0) {
    throw new Error('Zepp requires a finite, positive weight in kilograms');
  }
  const seconds = Math.floor(timestamp.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('Zepp requires a valid measurement timestamp');
  }
  const summary: ZeppWeightRecord['summary'] = {
    weight: data.weight,
    deviceType: 1, // HMDeviceType.WEIGHT
    source: 1, // SourceType.ANDROID (the app upload format)
    dataSourceType: 1, // DataSourceType.WEIGHTING_SCALE
    timeZone: config.timeZone,
    syncHealthConnect: false,
  };
  const add = (key: string, value: number | undefined, max = Infinity, integer = false) => {
    if (value !== undefined && Number.isFinite(value) && value > 0 && value <= max) {
      summary[key] = integer ? Math.trunc(value) : value;
    }
  };
  const full = config.uploadMode === 'full';
  add('impedance', data.impedance, Infinity, true);
  if (full) {
    add('height', context.userProfile?.height);
    add('age', context.userProfile?.age, Infinity, true);
    add('bmi', data.bmi);
  }
  if (full && Number.isFinite(data.impedance) && data.impedance > 0) {
    add('fatRate', data.bodyFatPercent, 100);
    add('bodyWaterRate', data.waterPercent, 100);
    add('boneMass', data.boneMass, data.weight);
    add('metabolism', data.bmr, Infinity, true);
    add('muscleRate', data.muscleMass, data.weight); // Despite its name, this is kg.
    add('muscleAge', data.metabolicAge, Infinity, true);
    add('proteinRatio', data.proteinPercent, 100);
    add('standBodyWeight', data.idealWeight);
    add('visceralFat', data.visceralFat);
    add('subcutaneousFat', data.subcutaneousFatMass, data.weight); // kg, not %.
    add('skeletalMuscle', data.skeletalMuscleMass, data.weight);
  }
  if (full && Number.isInteger(data.heartRate) && data.heartRate! > 0 && data.heartRate! <= 255) {
    // This endpoint uses a decimal string, unlike the separate HR endpoint's base64.
    summary.heartRateData = String(data.heartRate);
  }
  // No proven mapping for physiqueRating/bodyStyle or stress: dni0.R omits singleStress.
  return {
    userId: config.userId,
    memberId: config.memberId,
    deviceSource: config.deviceSource,
    appName: '',
    generatedTime: seconds,
    createTime: seconds,
    weightType: 0, // WeightingType.NORMAL
    dataSource: 1,
    ...(config.deviceId ? { deviceId: config.deviceId } : {}),
    summary,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(actual: unknown, expected: number | string | boolean): boolean {
  if (typeof expected !== 'number') return actual === expected;
  return (
    typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= 0.0001
  );
}

function matchesRecord(value: unknown, expected: ZeppWeightRecord): boolean {
  if (!object(value) || !object(value.summary)) return false;
  if (
    String(value.userId) !== expected.userId ||
    (String(value.memberId) !== expected.memberId &&
      !(expected.memberId === '-1' && String(value.memberId) === expected.userId)) ||
    value.generatedTime !== expected.generatedTime
  )
    return false;
  const summary = value.summary;
  // Verify all submitted measurements. Server-managed source/sync metadata may change.
  return Object.entries(expected.summary)
    .filter(
      ([key]) =>
        !['deviceType', 'source', 'dataSourceType', 'timeZone', 'syncHealthConnect'].includes(key),
    )
    .every(([key, expectedValue]) => sameValue(summary[key], expectedValue));
}

export class ZeppExporter implements Exporter {
  readonly name = 'zepp';
  readonly supportsBackdate = true;
  private readonly config: ZeppConfig;
  private readonly sessions: ZeppSessionManager;
  private accountId?: string;

  constructor(config: ZeppConfig) {
    // Revalidate even when called directly, before attaching a token to any URL.
    this.config = parseZeppConfig({
      ...(config.credentials
        ? config.credentials
        : { app_token: config.appToken, user_id: config.userId }),
      token_dir: config.tokenDir,
      member_id: config.memberId,
      base_url: config.baseUrl,
      device_id: config.deviceId,
      device_source: config.deviceSource,
      time_zone: config.timeZone,
      upload_mode: config.uploadMode,
    });
    this.sessions = new ZeppSessionManager(this.config);
    this.accountId = this.config.userId || undefined;
  }

  private async authenticate(rejectedToken?: string): Promise<ZeppConfig> {
    const session = await this.sessions.get(rejectedToken);
    if (this.accountId && this.accountId !== session.user_id)
      throw new Error('Zepp account changed during renewal; no measurement was sent');
    this.accountId = session.user_id;
    return {
      ...this.config,
      appToken: session.app_token,
      userId: session.user_id,
      baseUrl: session.base_url,
      memberId: this.config.memberId === session.user_id ? '-1' : this.config.memberId,
    };
  }

  private url(c: ZeppConfig): URL {
    return new URL(`/users/${c.userId}/members/${c.memberId}/weightRecords`, c.baseUrl);
  }

  private async request(url: URL, body?: string, canRenew = true): Promise<Response> {
    const config = await this.authenticate();
    let response: Response;
    try {
      response = await fetch(new URL(url.pathname + url.search, config.baseUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          apptoken: config.appToken,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          appname: 'com.huami.midong',
          appplatform: 'android_phone',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Transport exceptions can contain request URLs/headers. Do not log them.
      throw new Error('Zepp request failed or timed out');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        if (this.config.credentials && canRenew) {
          await this.authenticate(config.appToken);
          // Only a definite authentication rejection permits replaying the POST.
          return this.request(url, body, false);
        }
        if (this.config.credentials) this.sessions.pauseSignIn();
        throw new Error(
          `Zepp HTTP ${response.status}: check the session token, account ID and regional API origin`,
        );
      }
      throw new Error(`Zepp HTTP ${response.status}`);
    }
    return response;
  }

  private async records(from: number, to: number, limit: number): Promise<unknown[]> {
    const url = this.url(await this.authenticate());
    url.searchParams.set('fromTime', String(from));
    url.searchParams.set('toTime', String(to));
    url.searchParams.set('limit', String(limit));
    const response = await this.request(url);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Zepp returned an invalid record-list response');
    }
    if (!object(payload) || !Array.isArray(payload.items)) {
      throw new Error(
        'Zepp did not return a record list; check authentication and API compatibility',
      );
    }
    return payload.items;
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    let submitted = false;
    try {
      const record = buildZeppRecord(this.config, data, context);
      const config = await this.authenticate();
      record.userId = config.userId;
      record.memberId = config.memberId;
      const body = JSON.stringify([record]);
      // No transport/server-error retries; a definite 401/403 may renew once.
      submitted = true;
      const response = await this.request(this.url(config), body);
      await response.body?.cancel();
      for (const waitMs of [0, 250, 1000]) {
        if (waitMs) await delay(waitMs);
        const items = await this.records(record.generatedTime - 1, record.generatedTime + 1, 300);
        if (items.some((item) => matchesRecord(item, record))) return { success: true };
      }
      throw new Error(
        'Zepp accepted the upload, but readback did not confirm all submitted measurements',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Zepp export failed';
      return {
        success: false,
        error: `${message}${submitted ? '. No further upload attempt was made; inspect Zepp before resubmitting.' : ''}`,
      };
    }
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      await this.records(1, Math.floor(Date.now() / 1000), 1);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Zepp healthcheck failed',
      };
    }
  }
}
