/**
 * Phone normalisation.
 *
 * This existed as a bug before it existed as a module: numbers were stored as
 * `+97455550003` and matched on exact equality, so a member typing `55550003`
 * — the way they would actually say it — silently failed to match, and the
 * sign-in error was indistinguishable from a wrong code.
 */
import { describe, expect, it } from 'vitest';

import { normalizePhone } from '../src/security/phone.js';

const qatar = { defaultCountryCode: '+974' };

describe('every way a Qatari member might type their number', () => {
  it.each([
    ['55550003', 'bare local'],
    ['5555 0003', 'local with a space'],
    ['5555-0003', 'local with a dash'],
    ['+97455550003', 'full E.164'],
    ['+974 5555 0003', 'E.164 with spaces'],
    ['+974 (5555) 0003', 'E.164 with brackets'],
    ['0097455550003', 'international prefix'],
    ['00974 5555 0003', 'international prefix with spaces'],
    ['97455550003', 'country code without a plus'],
    ['  55550003  ', 'surrounding whitespace'],
  ])('normalises %o (%s)', (input) => {
    expect(normalizePhone(input, qatar)).toBe('+97455550003');
  });
});

describe('numbers it refuses rather than guesses at', () => {
  it.each(['', '   ', 'abc', '+', '+974', '12345', 'not-a-number', '+974abc0003'])(
    'returns null for %o',
    (input) => {
      // Conservative on purpose: storing a number in a shape that will fail to
      // match later is worse than rejecting it at the door.
      expect(normalizePhone(input, qatar)).toBeNull();
    },
  );
});

describe('other countries', () => {
  it('applies whatever default it is given', () => {
    expect(normalizePhone('7911123456', { defaultCountryCode: '+44' })).toBe('+447911123456');
    expect(normalizePhone('2025550123', { defaultCountryCode: '+1' })).toBe('+12025550123');
  });

  it('leaves an explicit country code alone, whatever the default', () => {
    // A member abroad, or a number entered in full — the default must not
    // override what was actually typed.
    expect(normalizePhone('+447911123456', qatar)).toBe('+447911123456');
    expect(normalizePhone('+12025550123', qatar)).toBe('+12025550123');
  });
});

describe('it is idempotent', () => {
  it('normalising an already-normalised number changes nothing', () => {
    const once = normalizePhone('55550003', qatar);
    expect(once).not.toBeNull();
    expect(normalizePhone(once ?? '', qatar)).toBe(once);
  });
});
