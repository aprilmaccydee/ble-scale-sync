import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmazfitMaintenanceConfig } from '../../src/runtime/amazfit.js';
import type { MaintenanceSession } from '../../src/ble/maintenance.js';

const h = vi.hoisted(() => ({
  provision: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  stress: vi.fn(),
}));
vi.mock('../../src/scales/amazfit/channel.js', () => ({
  AmazfitChannel: class {
    open = h.open;
    close = h.close;
  },
}));
vi.mock('../../src/scales/amazfit/provision.js', () => ({ provisionProfiles: h.provision }));
vi.mock('../../src/scales/amazfit/settings.js', () => ({ reconcileStress: h.stress }));

const { AmazfitMaintenance } = await import('../../src/runtime/amazfit.js');
const config: AmazfitMaintenanceConfig = {
  address: 'aa:bb:cc:dd:ee:ff',
  dryRun: false,
  users: [
    {
      id: 1,
      slug: 'aaa',
      name: 'AAA',
      profile: {
        height: 170,
        age: 36,
        birthDate: '1990-01-01',
        gender: 'female',
        isAthlete: false,
        lastKnownWeight: 70,
      },
    },
  ],
};
const advertisement = (hex = 'bb83ea270b933f8255f3488a5100010000000000') => ({
  localName: 'Amazfit Scale',
  serviceUuids: ['fee0'],
  serviceData: [{ uuid: 'fee0', data: Buffer.from(hex, 'hex') }],
});
const session: MaintenanceSession = {
  charMap: new Map(),
  device: { onDisconnect: vi.fn() },
  close: vi.fn(async () => {}),
};
const connect = vi.fn(async () => session);
const controllers: InstanceType<typeof AmazfitMaintenance>[] = [];
function controller(value = config) {
  const result = new AmazfitMaintenance(value);
  controllers.push(result);
  return result;
}
const observe = (c: InstanceType<typeof AmazfitMaintenance>) =>
  c.observe(advertisement(), config.address, 'Amazfit Smart Scale', connect);
beforeEach(() => {
  vi.clearAllMocks();
  h.provision.mockResolvedValue(undefined);
  h.open.mockResolvedValue(undefined);
  h.stress.mockResolvedValue(false);
});
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.stop()));
  vi.restoreAllMocks();
});

describe('Amazfit service maintenance', () => {
  it('provisions on the next settled step-off, gates that reading, and releases GATT before ready', async () => {
    const c = controller();
    expect(
      c.observe(
        advertisement('0b80ea270bd3bdcc5b0000000000000000000000'),
        config.address,
        'Amazfit Smart Scale',
        connect,
      ),
    ).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(observe(c)).toBe(true);
    expect(observe(c)).toBe(true);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    expect(h.provision).toHaveBeenCalledWith(expect.anything(), config.users, undefined);
    expect(observe(c)).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated reset requests and retries with the same deletion progress', async () => {
    const c = controller();
    c.requestReset();
    c.requestReset();
    h.provision.mockRejectedValueOnce(new Error('lost connection'));
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    const progress = h.provision.mock.calls[0][2];
    expect(progress).toEqual({ removed: new Set(), removalVerified: false });
    expect(observe(c)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1); // backoff
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(2));
    expect(h.provision.mock.calls[1][2]).toBe(progress);
    expect(observe(c)).toBe(false);
  });

  it('does nothing in dry run or for a different scale', async () => {
    const dry = controller({ ...config, dryRun: true });
    dry.requestReset();
    expect(observe(dry)).toBe(false);
    const c = controller();
    expect(c.observe(advertisement(), '00:00:00:00:00:00', 'Amazfit Smart Scale', connect)).toBe(
      false,
    );
    expect(c.observe(advertisement(), config.address, 'Other Scale', connect)).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it('reconciles profile changes but ignores a routine weight-anchor update', async () => {
    const c = controller();
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    c.configure({
      ...config,
      users: [{ ...config.users[0], profile: { ...config.users[0].profile, lastKnownWeight: 71 } }],
    });
    expect(observe(c)).toBe(false);
    c.configure({ ...config, users: [{ ...config.users[0], name: 'BBB' }] });
    expect(observe(c)).toBe(true);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(2));
  });

  it('closes a late connection without writing after shutdown', async () => {
    let release: (s: MaintenanceSession) => void = () => {};
    connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const c = controller();
    observe(c);
    const stopped = c.stop();
    release(session);
    await stopped;
    expect(h.provision).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });
  it('applies queued stress changes without rewriting profiles, including a newer request during GATT', async () => {
    const c = controller();
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    expect(h.stress).toHaveBeenLastCalledWith(expect.anything(), undefined);
    c.requestStress(true);
    let resolveStress!: (v: boolean) => void;
    h.stress.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStress = resolve;
        }),
    );
    observe(c);
    await vi.waitFor(() => expect(h.stress).toHaveBeenCalledTimes(2));
    c.requestStress(false);
    resolveStress(true);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(2));
    expect(observe(c)).toBe(true);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(3));
    expect(h.stress.mock.calls.map((args) => args[1])).toEqual([undefined, true, false]);
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(observe(c)).toBe(false);
  });

  it('retries stress failures after backoff and suppresses dry-run writes', async () => {
    const c = controller();
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    c.requestStress(true);
    h.stress.mockRejectedValueOnce(new Error('readback mismatch'));
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(2));
    observe(c);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    observe(c);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledTimes(3));
    expect(h.stress).toHaveBeenLastCalledWith(expect.anything(), true);
    const dry = controller({ ...config, dryRun: true });
    dry.requestStress(true);
    expect(observe(dry)).toBe(false);
  });
});
