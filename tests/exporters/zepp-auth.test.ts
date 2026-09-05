import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginZepp, parseZeppSession } from '../../src/exporters/zepp-auth.js';
import { writeZeppExporterYaml } from '../../src/exporters/zepp-setup.js';
import { parseZeppConfig } from '../../src/exporters/zepp-config.js';
import { ZeppExporter } from '../../src/exporters/zepp.js';

const credentials = {
  username: 'person+scale@example.com',
  password: ' spaces &+? ',
  country_code: 'GB',
};
const success = {
  result: 'ok',
  token_info: { app_token: 'test-app-token', user_id: '90071992547409931', app_ttl: 2592000 },
  domains: [{ host: 'api-mifit.zepp.com', cnames: ['api-mifit-de2.zepp.com'] }],
};
const redirect = (
  query = 'state=REDIRECTION&access=test-access&refresh=test-refresh&country_code=GB',
) =>
  new Response(null, {
    status: 303,
    headers: {
      location: `https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?${query}`,
    },
  });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Zepp web session', () => {
  it('encrypts credentials, selects web login, then uses the mobile health-data namespace', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(json(success))
      .mockResolvedValueOnce(json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const session = await loginZepp(credentials);
    expect(session).toMatchObject({
      app_token: 'test-app-token',
      user_id: '90071992547409931',
      base_url: 'https://api-mifit-de2.zepp.com',
    });
    const [tokenUrl, tokenRequest] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://api-user.zepp.com/v2/registrations/tokens');
    expect(tokenRequest.redirect).toBe('manual');
    expect(tokenRequest.headers['x-hm-ekv']).toBe('1');
    expect(Buffer.from(tokenRequest.body).includes(Buffer.from(credentials.password))).toBe(false);
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from('xeNtBVqzDc6tuNTh'),
      Buffer.from('MAAAYAAAAAAAAABg'),
    );
    const cleartext = Buffer.concat([
      decipher.update(tokenRequest.body),
      decipher.final(),
    ]).toString('utf8');
    const form = new URLSearchParams(cleartext);
    expect(form.get('emailOrPhone')).toBe(credentials.username);
    expect(form.get('password')).toBe(credentials.password);
    expect(form.getAll('token')).toEqual(['access', 'refresh']);
    const [exchangeUrl, exchangeRequest] = fetchMock.mock.calls[1];
    expect(exchangeUrl).toBe('https://api-mifit.zepp.com/v2/client/login');
    expect(exchangeRequest.body.get('code')).toBe('test-access');
    expect(exchangeRequest.body.get('app_name')).toBe('com.huami.webapp');
    expect(exchangeRequest.headers.app_name).toBe('com.huami.webapp');
    expect(exchangeRequest.body.get('allow_registration')).toBe('false');
    expect(exchangeRequest.body.has('password')).toBe(false);
    expect(exchangeRequest.redirect).toBe('manual');
    expect(await new ZeppExporter(parseZeppConfig({ ...session })).healthcheck()).toEqual({
      success: true,
    });
    expect(fetchMock.mock.calls[2][1].headers.appname).toBe('com.huami.midong');
    expect(fetchMock.mock.calls[2][1].headers.apptoken).toBe('test-app-token');
  });

  it.each([401, 429, 500])('does not retry a failed credential request (%s)', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('sensitive server response', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginZepp(credentials)).rejects.toThrow(
      status === 429 ? 'rate-limited' : `HTTP ${status}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://evil.test/?state=REDIRECTION&access=secret',
    'https://s3-us-west-2.amazonaws.com/other?state=REDIRECTION&access=secret',
    'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?state=wrong&access=secret',
  ])('never follows unexpected redirects or exchanges their tokens', async (location) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 303, headers: { location } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginZepp(credentials)).rejects.toThrow('unexpected sign-in redirect');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an error redirect even if it includes an access value', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redirect('state=REDIRECTION&error=401&access=secret'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginZepp(credentials)).rejects.toThrow('rejected sign-in');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never reveals a remote response or transport exception', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('password=super-secret'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginZepp(credentials)).rejects.toThrow(
      'Zepp sign-in request failed or timed out',
    );
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(json({ error_code: 'super-secret', token_info: success.token_info }));
    await expect(loginZepp(credentials)).rejects.toThrow('Zepp did not issue a valid session');
  });

  it('validates input before any network calls', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginZepp({ ...credentials, password: '' })).rejects.toThrow(
      'Provide a Zepp email',
    );
    await expect(loginZepp({ ...credentials, country_code: 'GB&token=x' })).rejects.toThrow(
      'Provide a Zepp email',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe IDs, invalid session tokens and untrusted server routing', () => {
    for (const id of [9007199254740992, null, '../other']) {
      expect(() =>
        parseZeppSession({ ...success, token_info: { ...success.token_info, user_id: id } }),
      ).toThrow();
    }
    expect(() =>
      parseZeppSession({ ...success, token_info: { ...success.token_info, app_token: '' } }),
    ).toThrow();
    for (const host of [
      'evil.test',
      'api-mifit-de2.zepp.com.evil.test',
      'api-mifit.zepp.com/private',
    ]) {
      expect(() =>
        parseZeppSession({ ...success, domains: [{ host: 'api-mifit.zepp.com', cnames: [host] }] }),
      ).toThrow('regional routing');
    }
  });
});

describe('Zepp private YAML setup', () => {
  it('writes quoted account IDs, with private permissions, and safely replaces the old token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zepp-setup-'));
    dirs.push(dir);
    const path = join(dir, 'exporter.yaml');
    writeFileSync(path, 'old token', { mode: 0o644 });
    writeZeppExporterYaml(path, parseZeppSession(success));
    const text = readFileSync(path, 'utf8');
    expect(parse(text)).toEqual([
      expect.objectContaining({
        type: 'zepp',
        app_token: 'test-app-token',
        user_id: '90071992547409931',
        member_id: '-1',
        upload_mode: 'full',
      }),
    ]);
    expect(text).not.toContain(credentials.password);
    expect(text).not.toContain('login_token');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
