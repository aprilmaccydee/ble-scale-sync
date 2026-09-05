import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loginZepp, type ZeppSession } from './zepp-auth.js';
import { parseZeppConfig, type ZeppConfig } from './zepp-config.js';

const pending = new Map<string, Promise<ZeppSession>>();
const failedUntil = new Map<string, number>();
const REFRESH_MARGIN_MS = 60_000;
const FAILURE_COOLDOWN_MS = 5 * 60_000;

export class ZeppSessionManager {
  private current?: ZeppSession;
  private readonly accountKey: string;
  private readonly lockKey: string;
  private readonly cachePath: string;

  constructor(private readonly config: ZeppConfig) {
    const c = config.credentials;
    this.accountKey = createHash('sha256')
      .update(`${c?.username.toLowerCase()}\0${c?.country_code}\0com.huami.webapp`)
      .digest('hex');
    this.cachePath = join(resolve(config.tokenDir), `${this.accountKey}.json`);
    // A changed password can retry immediately; passwords never enter cache files or logs.
    this.lockKey = `${this.cachePath}:${createHash('sha256')
      .update(c?.password ?? '')
      .digest('hex')}`;
  }

  private fresh(session: ZeppSession | undefined): session is ZeppSession {
    return !!session?.expires_at && Date.parse(session.expires_at) > Date.now() + REFRESH_MARGIN_MS;
  }

  private async load(): Promise<ZeppSession | undefined> {
    try {
      const cached = JSON.parse(await readFile(this.cachePath, 'utf8'));
      if (
        cached.version !== 1 ||
        cached.account_key !== this.accountKey ||
        cached.login_app !== 'com.huami.webapp'
      )
        return;
      const config = parseZeppConfig({
        app_token: cached.app_token,
        user_id: cached.user_id,
        base_url: cached.base_url,
      });
      if (typeof cached.expires_at !== 'string' || !Number.isFinite(Date.parse(cached.expires_at)))
        return;
      return {
        app_token: config.appToken,
        user_id: config.userId,
        base_url: config.baseUrl,
        expires_at: cached.expires_at,
      };
    } catch {
      return; // Missing/invalid cache is rebuilt from configured credentials.
    }
  }

  private async loginAndSave(): Promise<ZeppSession> {
    const session = await loginZepp(this.config.credentials);
    session.expires_at ??= new Date(Date.now() + 3_600_000).toISOString();
    const directory = resolve(this.config.tokenDir);
    const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          account_key: this.accountKey,
          login_app: 'com.huami.webapp',
          ...session,
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, this.cachePath);
    } catch {
      throw new Error('Zepp cannot save its session cache; check token_dir permissions');
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return session;
  }

  pauseSignIn(): void {
    this.current = undefined;
    failedUntil.set(this.lockKey, Date.now() + FAILURE_COOLDOWN_MS);
  }

  async get(rejectedToken?: string): Promise<ZeppSession> {
    if (!this.config.credentials) {
      return {
        app_token: this.config.appToken,
        user_id: this.config.userId,
        base_url: this.config.baseUrl,
      };
    }
    if (!this.config.credentials.username || !this.config.credentials.password) {
      throw new Error('Zepp is unconfigured: fill username and password in config.yaml');
    }
    if ((failedUntil.get(this.lockKey) ?? 0) > Date.now()) {
      throw new Error(
        'Zepp sign-in is paused for five minutes after a failure; check the configured credentials',
      );
    }
    this.current ??= await this.load();
    if (this.fresh(this.current) && this.current.app_token !== rejectedToken) return this.current;
    if (rejectedToken) {
      const disk = await this.load();
      if (this.fresh(disk) && disk.app_token !== rejectedToken) return (this.current = disk);
    }
    let login = pending.get(this.lockKey);
    if (!login) {
      login = this.loginAndSave();
      pending.set(this.lockKey, login);
    }
    try {
      this.current = await login;
      failedUntil.delete(this.lockKey);
      return this.current;
    } catch (error) {
      failedUntil.set(this.lockKey, Date.now() + FAILURE_COOLDOWN_MS);
      throw error;
    } finally {
      if (pending.get(this.lockKey) === login) pending.delete(this.lockKey);
    }
  }
}
