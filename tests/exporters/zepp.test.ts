import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import { buildZeppRecord, ZeppExporter } from '../../src/exporters/zepp.js';
import { parseZeppConfig } from '../../src/exporters/zepp-config.js';
import { createExporterFromEntry } from '../../src/exporters/registry.js';
import { createExporters } from '../../src/exporters/index.js';
import { loadExporterConfig } from '../../src/exporters/config.js';
import { loadEnvConfig } from '../../src/config/env-load.js';
import { resolveExportersForUser } from '../../src/config/resolve.js';
import { loadYamlConfig } from '../../src/config/yaml-load.js';
import { AppConfigSchema } from '../../src/config/schema.js';

const config = parseZeppConfig({
  app_token: 'test-session-token',
  user_id: '90071992547409931',
  device_id: 'AA:BB:CC:DD:EE:FF',
  device_source: 104,
  base_url: 'https://api-mifit-de.zepp.com',
  time_zone: 'Europe/London',
});
const timestamp = new Date('2026-09-05T10:20:30.456Z');
const sample: BodyComposition = {
  weight: 80,
  impedance: 553,
  bmi: 24.69,
  bodyFatPercent: 20,
  waterPercent: 55,
  boneMass: 3,
  muscleMass: 61,
  visceralFat: 7,
  physiqueRating: 5,
  bmr: 1700,
  metabolicAge: 32,
  proteinPercent: 18,
  skeletalMuscleMass: 31,
  subcutaneousFatPercent: 16,
  subcutaneousFatMass: 12.8,
  bodyFatMass: 16,
  fatFreeMass: 64,
  musclePercent: 76.25,
  idealWeight: 71.2,
  heartRate: 72,
  stress: 39,
};
const context = {
  timestamp,
  userProfile: { height: 180, age: 35, gender: 'male' as const, isAthlete: false },
};
const record = buildZeppRecord(config, sample, context);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Zepp APK payload mapping', () => {
  it('sends exactly weight and impedance as measurements in raw mode', () => {
    expect(
      buildZeppRecord({ ...config, uploadMode: 'weight_impedance' }, sample, context).summary,
    ).toEqual({
      weight: 80,
      impedance: 553,
      deviceType: 1,
      source: 1,
      dataSourceType: 1,
      timeZone: 'Europe/London',
      syncHealthConnect: false,
    });
  });

  it('uses the current time for live exports and the supplied time for history', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T22:15:23.900Z'));
    expect(buildZeppRecord(config, sample).generatedTime).toBe(1788646523);
    expect(buildZeppRecord(config, sample, context).generatedTime).toBe(1788603630);
  });
  it('preserves cloud IDs, seconds, kg/% fields, and decimal-string pulse', () => {
    expect(record).toEqual({
      userId: '90071992547409931',
      memberId: '-1',
      deviceSource: 104,
      appName: '',
      deviceId: 'AA:BB:CC:DD:EE:FF',
      generatedTime: 1788603630,
      createTime: 1788603630,
      weightType: 0,
      dataSource: 1,
      summary: {
        weight: 80,
        height: 180,
        age: 35,
        bmi: 24.69,
        deviceType: 1,
        source: 1,
        dataSourceType: 1,
        timeZone: 'Europe/London',
        syncHealthConnect: false,
        impedance: 553,
        fatRate: 20,
        bodyWaterRate: 55,
        boneMass: 3,
        metabolism: 1700,
        muscleRate: 61,
        muscleAge: 32,
        proteinRatio: 18,
        standBodyWeight: 71.2,
        visceralFat: 7,
        subcutaneousFat: 12.8,
        skeletalMuscle: 31,
        heartRateData: '72',
      },
    });
  });

  it('omits composition without impedance instead of uploading estimated/sentinel values', () => {
    const result = buildZeppRecord(
      config,
      { ...sample, impedance: 0, heartRate: undefined },
      context,
    );
    expect(result.summary).toEqual({
      weight: 80,
      height: 180,
      age: 35,
      bmi: 24.69,
      deviceType: 1,
      source: 1,
      dataSourceType: 1,
      timeZone: 'Europe/London',
      syncHealthConnect: false,
    });
  });

  it('honours composition opt-out and rejects invalid weight/time before sending anything', async () => {
    expect(
      buildZeppRecord({ ...config, uploadMode: 'weight_impedance' }, sample).summary,
    ).not.toHaveProperty('fatRate');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const weight of [NaN, Infinity, -1, 0]) {
      expect((await new ZeppExporter(config).export({ ...sample, weight })).success).toBe(false);
    }
    expect(
      (await new ZeppExporter(config).export(sample, { timestamp: new Date('invalid') })).success,
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits missing/invalid optional values and unrelated local metrics', () => {
    const result = buildZeppRecord(
      config,
      { ...sample, bodyFatPercent: NaN, proteinPercent: -1, waterPercent: 101, heartRate: 999 },
      context,
    );
    for (const key of [
      'fatRate',
      'proteinRatio',
      'bodyWaterRate',
      'heartRateData',
      'singleStress',
      'bodyStyle',
      'bodyScore',
      'encryptImpedance',
    ]) {
      expect(result.summary).not.toHaveProperty(key);
    }
  });
});

describe('Zepp upload and readback', () => {
  it('sends one JSON array POST with token in a header, then verifies persisted measurements', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [record], next: null }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new ZeppExporter(config).export(sample, context)).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://api-mifit-de.zepp.com/users/90071992547409931/members/-1/weightRecords',
    );
    expect(options.method).toBe('POST');
    expect(options.redirect).toBe('error');
    expect(options.headers.apptoken).toBe('test-session-token');
    expect(JSON.parse(options.body)).toEqual([record]);
    expect(String(url)).not.toContain('test-session-token');
    const [readUrl, readOptions] = fetchMock.mock.calls[1];
    expect(readOptions.method).toBe('GET');
    expect(readUrl.searchParams.get('fromTime')).toBe('1788603629');
    expect(readUrl.searchParams.get('toTime')).toBe('1788603631');
  });

  it('waits for visibility without repeating the POST', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ items: [record] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = new ZeppExporter(config).export(sample, context);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ success: true });
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'GET', 'GET']);
  });

  it.each(['missing', 'wrong-account', 'lost-field', 'wrong-units'])(
    'does not claim success for %s readback',
    async (scenario) => {
      vi.useFakeTimers();
      const changed = structuredClone(record);
      if (scenario === 'wrong-account') changed.userId = '777';
      if (scenario === 'lost-field') delete changed.summary.proteinRatio;
      if (scenario === 'wrong-units') changed.summary.muscleRate = 76.25;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockImplementation(async () => json({ items: scenario === 'missing' ? [] : [changed] }));
      vi.stubGlobal('fetch', fetchMock);
      const result = new ZeppExporter(config).export(sample, context);
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({
        success: false,
        error: expect.stringContaining('readback did not confirm'),
      });
      expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(1);
    },
  );

  it.each([401, 403, 429, 500])('reports HTTP %i without retrying a write', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'test-session-token' }, status));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new ZeppExporter(config).export(sample, context);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(`HTTP ${status}`),
    });
    expect(result.error).not.toContain('test-session-token');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports an ambiguous transport failure without leaking request details or retrying', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('failed: test-session-token'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new ZeppExporter(config).export(sample, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No further upload attempt');
    expect(result.error).not.toContain('test-session-token');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('healthcheck only reads, and rejects login HTML or a 200 error envelope', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(new Response('<html>login</html>'))
      .mockResolvedValueOnce(json({ error_code: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new ZeppExporter(config);
    expect(await exporter.healthcheck()).toEqual({ success: true });
    expect((await exporter.healthcheck()).success).toBe(false);
    expect((await exporter.healthcheck()).success).toBe(false);
    expect(fetchMock.mock.calls.every((c) => c[1].method === 'GET')).toBe(true);
  });
});

describe('Zepp configuration integration', () => {
  it('loads per-user Zepp credentials from config.yaml with no environment variables', () => {
    const app = loadYamlConfig('tests/fixtures/zepp-config.yaml');
    const first = resolveExportersForUser(app, app.users[0]);
    const second = resolveExportersForUser(app, app.users[1]);
    expect(first[0]).toMatchObject({
      type: 'zepp',
      user_id: '90071992547409931',
      app_token: 'first-test-token',
    });
    expect(second[0]).toMatchObject({
      type: 'zepp',
      user_id: '90071992547409932',
      app_token: 'second-test-token',
    });
    expect(createExporterFromEntry(first[0])).toBeInstanceOf(ZeppExporter);
    expect(createExporterFromEntry(second[0])).toBeInstanceOf(ZeppExporter);
    const invalid = structuredClone(app);
    delete invalid.users[0].exporters![0].app_token;
    expect(AppConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it.each([
    'http://api-mifit.zepp.com',
    'https://api-mifit.zepp.com.evil.test',
    'https://evil.test',
    'https://secret@api-mifit.zepp.com',
    'https://api-mifit.zepp.com/?token=x',
    'https://api-mifit.zepp.com/other',
  ])('rejects unsafe origins: %s', (baseUrl) => {
    expect(() => new ZeppExporter({ ...config, baseUrl })).toThrow('Invalid Zepp config');
  });

  it('requires cloud IDs as strings and validates member mapping, time zone and upload mode', () => {
    const raw = { app_token: 'test-session-token', user_id: '123' };
    expect(parseZeppConfig({ ...raw, member_id: '123' }).memberId).toBe('-1');
    for (const invalid of [
      { user_id: 123 },
      { user_id: '../other' },
      { member_id: '0' },
      { time_zone: 'bad/tz' },
      { upload_mode: 'false' },
    ]) {
      expect(() => parseZeppConfig({ ...raw, ...invalid })).toThrow('Invalid Zepp config');
    }
    expect(createExporterFromEntry({ type: 'zepp', ...raw })).toBeInstanceOf(ZeppExporter);
    expect(createExporters({ exporters: ['zepp'], zepp: config })[0]).toBeInstanceOf(ZeppExporter);
  });

  it('round-trips legacy environment config and keeps separate per-user account destinations', () => {
    vi.stubEnv('EXPORTERS', 'zepp');
    vi.stubEnv('ZEPP_APP_TOKEN', 'test-session-token');
    vi.stubEnv('ZEPP_USER_ID', '123');
    vi.stubEnv('ZEPP_DEVICE_SOURCE', '104');
    vi.stubEnv('USER_HEIGHT', '180');
    vi.stubEnv('USER_BIRTH_DATE', '1991-01-01');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'false');
    const loaded = loadExporterConfig();
    expect(loaded.zepp?.deviceSource).toBe(104);
    const app = loadEnvConfig();
    const entry = app.global_exporters![0];
    expect(createExporterFromEntry(entry)).toBeInstanceOf(ZeppExporter);
    const first = { ...app.users[0], slug: 'first', exporters: [{ ...entry, user_id: '123' }] };
    const second = { ...app.users[0], slug: 'second', exporters: [{ ...entry, user_id: '456' }] };
    app.global_exporters = [];
    expect(resolveExportersForUser(app, first)[0].user_id).toBe('123');
    expect(resolveExportersForUser(app, second)[0].user_id).toBe('456');
  });
});
