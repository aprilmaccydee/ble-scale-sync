import { connect, type MqttClient } from 'mqtt';
import type { MqttConfig } from '../exporters/config.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Amazfit');

/** Persistent control connection; uses a different client ID from measurement exports. */
export class AmazfitMqttControl {
  private client?: MqttClient;
  private stress?: boolean;
  private state = 'waiting_for_scale';
  private detail = 'Wake the scale and step off to apply profiles';
  readonly baseTopic: string;
  readonly deviceId: string;

  constructor(
    private readonly config: MqttConfig,
    address: string,
    private readonly reset: () => void,
    private readonly setStress?: (enabled: boolean) => void,
  ) {
    const id = address.replace(/:/g, '').toLowerCase();
    this.baseTopic = `${config.topic}/amazfit/${id}`;
    this.deviceId = `ble-scale-sync-amazfit-${id}`;
  }

  start(): void {
    if (this.client) return;
    const client = connect(this.config.brokerUrl, {
      clientId: `${this.config.clientId}-amazfit-${this.deviceId.slice(-12)}`,
      username: this.config.username,
      password: this.config.password,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      clean: true,
      queueQoSZero: false,
      will: {
        topic: `${this.baseTopic}/availability`,
        payload: Buffer.from('offline'),
        qos: 1,
        retain: true,
      },
    });
    this.client = client;
    client.on('error', (error) => log.warn(`Profile MQTT: ${errMsg(error)}`));
    client.on('connect', () => {
      void this.initialize(client).catch((error) =>
        log.warn(`Profile MQTT setup: ${errMsg(error)}`),
      );
    });
    client.on('message', (topic, payload, packet) => {
      if (topic === 'homeassistant/status' && payload.toString() === 'online') {
        void this.publishDiscovery(client).catch((error) =>
          log.warn(`Profile discovery: ${errMsg(error)}`),
        );
      } else if (
        topic === `${this.baseTopic}/reset/set` &&
        payload.toString() === 'RESET' &&
        !packet.retain &&
        !packet.dup
      ) {
        // A retained command or retransmission must never reset accounts on reconnect.
        this.reset();
      } else if (topic === `${this.baseTopic}/stress/set` && !packet.retain && !packet.dup) {
        const value = payload.toString();
        if (value === 'ON' || value === 'OFF') this.setStress?.(value === 'ON');
      }
    });
  }

  private async initialize(client: MqttClient): Promise<void> {
    await client.subscribeAsync(
      [`${this.baseTopic}/reset/set`, `${this.baseTopic}/stress/set`, 'homeassistant/status'],
      {
        qos: 0,
      },
    );
    await this.publishDiscovery(client);
    await client.publishAsync(`${this.baseTopic}/availability`, 'online', { qos: 1, retain: true });
    await this.publishState(client);
    await this.publishStress(client);
  }

  private async publishDiscovery(client: MqttClient): Promise<void> {
    if (!this.config.haDiscovery) return;
    const common = {
      availability_topic: `${this.baseTopic}/availability`,
      device: {
        identifiers: [this.deviceId],
        name: `${this.config.haDeviceName} profiles`,
        manufacturer: 'Amazfit',
        model: 'Smart Scale A2003',
      },
    };
    await client.publishAsync(
      `homeassistant/button/${this.deviceId}/reset_profiles/config`,
      JSON.stringify({
        ...common,
        name: 'Reset scale profiles',
        unique_id: `${this.deviceId}_reset_profiles`,
        command_topic: `${this.baseTopic}/reset/set`,
        payload_press: 'RESET',
        retain: false,
        qos: 0,
        entity_category: 'config',
        icon: 'mdi:account-sync',
      }),
      { qos: 1, retain: true },
    );
    await client.publishAsync(
      `homeassistant/switch/${this.deviceId}/stress_measurement/config`,
      JSON.stringify({
        ...common,
        availability_topic: undefined,
        availability: [
          { topic: `${this.baseTopic}/availability` },
          { topic: `${this.baseTopic}/stress/availability` },
        ],
        availability_mode: 'all',
        name: 'Stress measurement',
        unique_id: `${this.deviceId}_stress_measurement`,
        command_topic: `${this.baseTopic}/stress/set`,
        state_topic: `${this.baseTopic}/stress/state`,
        payload_on: 'ON',
        payload_off: 'OFF',
        optimistic: false,
        retain: false,
        qos: 0,
        entity_category: 'config',
        icon: 'mdi:brain',
      }),
      { qos: 1, retain: true },
    );
    await client.publishAsync(
      `homeassistant/sensor/${this.deviceId}/profile_status/config`,
      JSON.stringify({
        ...common,
        name: 'Profile status',
        unique_id: `${this.deviceId}_profile_status`,
        state_topic: `${this.baseTopic}/state`,
        value_template: '{{ value_json.state }}',
        json_attributes_topic: `${this.baseTopic}/state`,
        entity_category: 'diagnostic',
      }),
      { qos: 1, retain: true },
    );
  }

  setStressState(enabled?: boolean): void {
    this.stress = enabled;
    if (this.client?.connected) {
      void this.publishStress(this.client).catch((error) =>
        log.warn(`Stress status: ${errMsg(error)}`),
      );
    }
  }

  private async publishStress(client: MqttClient): Promise<void> {
    if (this.stress !== undefined) {
      await client.publishAsync(`${this.baseTopic}/stress/state`, this.stress ? 'ON' : 'OFF', {
        qos: 1,
        retain: true,
      });
    }
    await client.publishAsync(
      `${this.baseTopic}/stress/availability`,
      this.stress === undefined ? 'offline' : 'online',
      { qos: 1, retain: true },
    );
  }

  setState(state: string, detail: string): void {
    this.state = state;
    this.detail = detail;
    if (this.client?.connected) {
      void this.publishState(this.client).catch((error) =>
        log.warn(`Profile status: ${errMsg(error)}`),
      );
    }
  }

  private async publishState(client: MqttClient): Promise<void> {
    await client.publishAsync(
      `${this.baseTopic}/state`,
      JSON.stringify({ state: this.state, detail: this.detail }),
      { qos: 1, retain: true },
    );
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    if (client.connected) {
      // QoS 0 avoids waiting indefinitely for a broker ACK during shutdown.
      await client
        .publishAsync(`${this.baseTopic}/availability`, 'offline', { qos: 0, retain: true })
        .catch(() => {});
    }
    await client.endAsync(true);
  }
}
