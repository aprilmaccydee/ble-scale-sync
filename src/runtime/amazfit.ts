import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';
import type { GattMaintenance, MaintenanceSession } from '../ble/maintenance.js';
import { normalizeUuid } from '../ble/types.js';
import type { MqttConfig } from '../exporters/config.js';
import { AmazfitChannel } from '../scales/amazfit/channel.js';
import { profileFingerprint, type AmazfitProfile } from '../scales/amazfit/profiles.js';
import { provisionProfiles, type ResetProgress } from '../scales/amazfit/provision.js';
import { reconcileStress } from '../scales/amazfit/settings.js';
import { resolveAmazfitProfiles } from '../config/resolve.js';
import { AmazfitMqttControl } from './amazfit-mqtt.js';
import type { AppContext } from './context.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Amazfit');

export interface AmazfitMaintenanceConfig {
  address: string;
  users: AmazfitProfile[];
  dryRun: boolean;
  mqtt?: MqttConfig;
}

export function amazfitConfig(ctx: AppContext): AmazfitMaintenanceConfig | undefined {
  const users = resolveAmazfitProfiles(ctx.config);
  if (!users.length) return undefined;
  const entry = ctx.config.global_exporters?.find((e) => e.type === 'mqtt');
  return {
    address: ctx.scaleMac!.toLowerCase(),
    users,
    dryRun: ctx.dryRun,
    mqtt: entry
      ? {
          brokerUrl: String(entry.broker_url),
          topic: (entry.topic as string) ?? 'scale/body-composition',
          username: entry.username as string | undefined,
          password: entry.password as string | undefined,
          clientId: (entry.client_id as string) ?? 'ble-scale-sync',
          haDiscovery: (entry.ha_discovery as boolean) ?? true,
          haDeviceName: (entry.ha_device_name as string) ?? 'BLE Scale',
          qos: 1,
          retain: true,
        }
      : undefined,
  };
}

/** Account maintenance is serialized with itself and releases GATT after every attempt. */
export class AmazfitMaintenance implements GattMaintenance {
  private config?: AmazfitMaintenanceConfig;
  private control?: AmazfitMqttControl;
  private pending = false;
  private profilesPending = false;
  private desiredStress?: boolean;
  private actualStress?: boolean;
  private stressRevision = 0;
  private reset?: ResetProgress;
  private task?: Promise<void>;
  private abort = new AbortController();
  private nextAttemptAt = 0;
  private generation = 0;
  private stopped = false;
  private started = false;
  private controlRevision = 0;
  private controlChange = Promise.resolve();
  private state = 'waiting_for_scale';
  private detail = 'Wake the scale and step off to apply profiles';

  constructor(config?: AmazfitMaintenanceConfig) {
    this.configure(config);
  }

  configure(config?: AmazfitMaintenanceConfig): void {
    const previous = this.config;
    const changed =
      config?.address !== previous?.address ||
      config?.dryRun !== previous?.dryRun ||
      profileFingerprint(config?.users ?? []) !== profileFingerprint(previous?.users ?? []);
    const mqttChanged =
      config?.address !== previous?.address ||
      config?.dryRun !== previous?.dryRun ||
      JSON.stringify(config?.mqtt) !== JSON.stringify(previous?.mqtt);
    this.config = config;
    if (changed) {
      this.generation++;
      this.abort.abort();
      this.abort = new AbortController();
      this.pending = !!config && !config.dryRun;
      this.profilesPending = this.pending;
      if (config?.address !== previous?.address || config?.dryRun !== previous?.dryRun) {
        this.desiredStress = undefined;
        this.actualStress = undefined;
        this.stressRevision++;
        this.control?.setStressState(undefined);
      }
      this.reset = undefined;
      this.nextAttemptAt = 0;
      this.status(
        this.pending ? 'waiting_for_scale' : 'disabled',
        this.pending ? 'Wake the scale and step off to apply profiles' : 'Profile writes disabled',
      );
    }
    if (mqttChanged && this.started) this.refreshControl();
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.refreshControl();
  }

  private refreshControl(): void {
    const revision = ++this.controlRevision;
    // Serialize reloads so an old client's offline/close cannot evict its replacement.
    this.controlChange = this.controlChange
      .then(async () => {
        await this.control?.stop();
        this.control = undefined;
        const config = this.config;
        if (revision !== this.controlRevision || this.stopped || !config?.mqtt || config.dryRun)
          return;
        this.control = new AmazfitMqttControl(
          config.mqtt,
          config.address,
          () => this.requestReset(),
          (enabled) => this.requestStress(enabled),
        );
        this.control.setStressState(this.actualStress);
        this.control.setState(this.state, this.detail);
        this.control.start();
      })
      .catch((error) => log.warn(`Profile controls: ${errMsg(error)}`));
  }

  requestReset(): void {
    if (!this.config || this.config.dryRun || this.stopped || this.reset || this.task) return;
    this.reset = { removed: new Set(), removalVerified: false };
    this.profilesPending = true;
    this.pending = true;
    this.nextAttemptAt = 0;
    this.status(
      'reset_pending',
      'Wake the scale and step off; configured accounts will be removed and recreated',
    );
  }

  requestStress(enabled: boolean): void {
    if (!this.config || this.config.dryRun || this.stopped) return;
    this.desiredStress = enabled;
    this.stressRevision++;
    this.pending = true;
    this.nextAttemptAt = 0;
    this.status(
      'stress_pending',
      `Wake the scale and step off to turn stress measurement ${enabled ? 'on' : 'off'}`,
    );
  }

  observe(
    info: BleDeviceInfo,
    address: string,
    adapterName: string,
    connect: () => Promise<MaintenanceSession>,
  ): boolean {
    const config = this.config;
    if (
      !config ||
      this.stopped ||
      config.dryRun ||
      address.toLowerCase() !== config.address ||
      adapterName !== 'Amazfit Smart Scale' ||
      !this.pending
    )
      return false;
    const frame = info.serviceData?.find(
      (sd) => normalizeUuid(sd.uuid) === normalizeUuid('fee0') && sd.data.length === 20,
    )?.data;
    if (!frame || this.task || Date.now() < this.nextAttemptAt) return true;
    const flags = frame.readUInt16LE(0);
    const result = (flags >>> 9) & 3;
    // Do not interrupt a person still measuring. A tap with no weight or a
    // completed step-off provides the idle connection window.
    if (!(flags & 0x8000) || (result !== 1 && result !== 2 && frame.readUInt16LE(7) >= 2000))
      return true;
    const generation = this.generation;
    const signal = this.abort.signal;
    const reset = this.reset;
    this.task = this.run(connect, config, signal, reset, generation).finally(() => {
      this.task = undefined;
    });
    return true;
  }

  private async run(
    connect: () => Promise<MaintenanceSession>,
    config: AmazfitMaintenanceConfig,
    signal: AbortSignal,
    reset: ResetProgress | undefined,
    generation: number,
  ): Promise<void> {
    let session: MaintenanceSession | undefined;
    let channel: AmazfitChannel | undefined;
    const profilesPending = this.profilesPending;
    const stressRevision = this.stressRevision;
    const desiredStress = this.desiredStress;
    this.status(
      reset ? 'resetting' : 'syncing',
      profilesPending
        ? 'Applying profiles and checking stress measurement'
        : 'Updating stress measurement',
    );
    try {
      session = await connect();
      signal.throwIfAborted();
      channel = new AmazfitChannel(session.charMap, session.device, signal);
      await channel.open();
      if (profilesPending) await provisionProfiles(channel, config.users, reset);
      const actualStress = await reconcileStress(channel, desiredStress);
      // Close before releasing the export gate; trailing broadcasts belong to
      // the maintenance wake-up and were already consumed by adapter dedup.
      channel.close();
      await session.close();
      session = undefined;
      if (generation === this.generation && !this.stopped) {
        this.profilesPending = false;
        this.reset = undefined;
        this.actualStress = actualStress;
        this.control?.setStressState(actualStress);
        this.pending = stressRevision !== this.stressRevision;
        if (!this.pending) this.desiredStress = undefined;
        this.status(
          this.pending ? 'stress_pending' : 'ready',
          this.pending
            ? 'Waiting to apply the latest stress measurement request'
            : `Verified ${config.users.length} profiles; stress measurement ${actualStress ? 'on' : 'off'}; ready for a new weigh-in`,
        );
      }
    } catch (error) {
      if (!signal.aborted && generation === this.generation) {
        this.actualStress = undefined;
        this.control?.setStressState(undefined);
        this.nextAttemptAt = Date.now() + 30_000;
        this.status('error', `${errMsg(error)}; will retry when the scale is awake`);
      }
    } finally {
      channel?.close();
      await session?.close().catch((error) => log.warn(`Profile disconnect: ${errMsg(error)}`));
    }
  }

  private status(state: string, detail: string): void {
    this.state = state;
    this.detail = detail;
    log.info(`Profiles ${state}: ${detail}`);
    this.control?.setState(state, detail);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controlRevision++;
    this.abort.abort();
    await this.controlChange;
    await this.control?.stop();
    await this.task;
  }
}
