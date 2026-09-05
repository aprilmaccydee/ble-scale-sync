import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZeppSessionManager } from '../../src/exporters/zepp-session.js';
import { parseZeppConfig } from '../../src/exporters/zepp-config.js';
import { ZeppExporter } from '../../src/exporters/zepp.js';
import { loadYamlConfig } from '../../src/config/yaml-load.js';
import { resolveExportersForUser } from '../../src/config/resolve.js';
import { AppConfigSchema } from '../../src/config/schema.js';

const dirs: string[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function config(username = 'first@example.com', tokenDir?: string) {
  tokenDir ??= mkdtempSync(join(tmpdir(), 'zepp-session-'));
  if (!dirs.includes(tokenDir)) dirs.push(tokenDir);
  return parseZeppConfig({
    username,
    password: 'test-password',
    country_code: 'GB',
    token_dir: tokenDir,
  });
}
function login(fetchMock: ReturnType<typeof vi.fn>, token = 'first-token', userId = '123') {
  fetchMock
    .mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: {
          location:
            'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?state=REDIRECTION&access=test-access&country_code=GB',
        },
      }),
    )
    .mockResolvedValueOnce(
      json({
        result: 'ok',
        token_info: { app_token: token, user_id: userId, app_ttl: 2592000 },
        domains: [{ host: 'api-mifit.zepp.com', cnames: ['api-mifit-de2.zepp.com'] }],
      }),
    );
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Zepp automatic sessions', () => {
  it('logs in once, shares concurrent requests, and reuses a private cache after restart', async () => {
    const c = config();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    login(fetchMock);
    const [a, b] = await Promise.all([
      new ZeppSessionManager(c).get(),
      new ZeppSessionManager(c).get(),
    ]);
    expect(a).toEqual(b);
    expect(await new ZeppSessionManager(c).get()).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const file = join(c.tokenDir, readdirSync(c.tokenDir)[0]);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain('test-password');
    expect(saved).not.toContain('first@example.com');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('renews an expiring cache and keeps two accounts separate in one directory', async () => {
    const c = config();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    login(fetchMock);
    await new ZeppSessionManager(c).get();
    const file = join(c.tokenDir, readdirSync(c.tokenDir)[0]);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.expires_at = new Date(Date.now() + 30_000).toISOString();
    writeFileSync(file, JSON.stringify(saved));
    login(fetchMock, 'renewed-token');
    expect((await new ZeppSessionManager(c).get()).app_token).toBe('renewed-token');
    login(fetchMock, 'second-token', '456');
    expect(
      (await new ZeppSessionManager(config('second@example.com', c.tokenDir)).get()).user_id,
    ).toBe('456');
    expect((await new ZeppSessionManager(c).get()).user_id).toBe('123');
    expect(readdirSync(c.tokenDir)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('renews once after a definite authentication rejection and verifies the uploaded record', async () => {
    const c = config();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    login(fetchMock);
    fetchMock.mockResolvedValueOnce(json({}, 401));
    login(fetchMock, 'renewed-token');
    let uploaded: unknown;
    fetchMock
      .mockImplementationOnce(async (_url, request) => {
        uploaded = JSON.parse(request.body)[0];
        expect(request.headers.apptoken).toBe('renewed-token');
        return json({});
      })
      .mockImplementationOnce(async () => json({ items: [uploaded] }));
    const result = await new ZeppExporter(c).export({ weight: 80, impedance: 500 });
    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)[0]).toEqual(uploaded);
  });

  it('pauses repeated sign-ins if even the renewed session is rejected', async () => {
    const c = config();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    login(fetchMock);
    fetchMock.mockResolvedValueOnce(json({}, 401));
    login(fetchMock, 'renewed-token');
    fetchMock.mockResolvedValueOnce(json({}, 403));
    const exporter = new ZeppExporter(c);
    expect((await exporter.healthcheck()).error).toContain('HTTP 403');
    expect((await exporter.healthcheck()).error).toContain('paused');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each(['timeout', 'server error'])(
    'does not repeat a POST or log in again after %s',
    async (failure) => {
      const c = config();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      login(fetchMock);
      if (failure === 'timeout')
        fetchMock.mockRejectedValueOnce(new Error('private transport details'));
      else fetchMock.mockResolvedValueOnce(json({}, 500));
      expect((await new ZeppExporter(c).export({ weight: 80, impedance: 500 })).success).toBe(
        false,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it('does not send a measurement when renewal unexpectedly changes the cloud account', async () => {
    const c = config();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    login(fetchMock);
    fetchMock.mockResolvedValueOnce(json({}, 401));
    login(fetchMock, 'other-token', '456');
    expect((await new ZeppExporter(c).export({ weight: 80, impedance: 500 })).error).toContain(
      'account changed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('accepts YAML credential entries and skips blank placeholders while preserving other exporters', () => {
    const app = loadYamlConfig('tests/fixtures/zepp-config.yaml');
    app.global_exporters = [{ type: 'csv', file: './test.csv' }];
    app.users[0].exporters = [
      { type: 'zepp', username: 'first@example.com', password: '', country_code: 'GB' },
    ];
    app.users[1].exporters = [
      {
        type: 'zepp',
        username: 'second@example.com',
        password: 'test-password',
        country_code: 'GB',
      },
    ];
    expect(AppConfigSchema.safeParse(app).success).toBe(true);
    expect(resolveExportersForUser(app, app.users[0]).map((e) => e.type)).toEqual(['csv']);
    expect(resolveExportersForUser(app, app.users[1]).map((e) => e.type)).toEqual(['zepp', 'csv']);
  });
});
