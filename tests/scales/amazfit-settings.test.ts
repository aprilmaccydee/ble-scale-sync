import { describe, expect, it, vi } from 'vitest';
import { reconcileStress } from '../../src/scales/amazfit/settings.js';

const channel = (...replies: string[]) => ({
  request: vi.fn(async () => Buffer.from(replies.shift()!, 'hex')),
});

describe('A2003 stress setting', () => {
  it('reads without changing the scale by default and avoids redundant writes', async () => {
    for (const desired of [undefined, true]) {
      const c = channel('030e000101');
      expect(await reconcileStress(c, desired)).toBe(true);
      expect(c.request.mock.calls).toHaveLength(1);
    }
  });

  it.each([true, false])(
    'writes %s only after reading and verifies the resulting setting',
    async (desired) => {
      const c = channel(
        desired ? '030e000100' : '030e000101',
        '030e0101',
        desired ? '030e000101' : '030e000100',
      );
      expect(await reconcileStress(c, desired)).toBe(desired);
      expect(c.request).toHaveBeenNthCalledWith(1, Buffer.from('030d00', 'hex'));
      expect(c.request).toHaveBeenNthCalledWith(2, Buffer.from([3, 13, 1, Number(desired)]));
      expect(c.request).toHaveBeenNthCalledWith(3, Buffer.from('030d00', 'hex'));
    },
  );

  it.each(['030e0000', '030e000102', '030e00010100', '01100800'])(
    'refuses to write after malformed readback %s',
    async (reply) => {
      const c = channel(reply);
      await expect(reconcileStress(c, true)).rejects.toThrow('readback');
      expect(c.request).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects failed acknowledgements and mismatched readback', async () => {
    await expect(reconcileStress(channel('030e000100', '030e0100'), true)).rejects.toThrow(
      'rejected',
    );
    await expect(
      reconcileStress(channel('030e000100', '030e0101', '030e000100'), true),
    ).rejects.toThrow('mismatch');
  });
});
