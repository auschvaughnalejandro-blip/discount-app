/**
 * Phone number normalisation.
 *
 * A member types their number the way they say it — `5555 0003`, `55550003`,
 * `+974 5555 0003`, `00974 55550003` — and every one of those has to reach the
 * same stored value, or sign-in fails for a reason that looks like the app
 * being broken. It stored `+97455550003` and matched on exact equality, so
 * anything else silently missed.
 *
 * Normalising on the way in also matters for uniqueness: without it, one
 * member could be created as `+97455550003` and another as `55550003`, and the
 * unique index would not notice they are the same person.
 *
 * The default country code is configuration rather than a constant here, so a
 * second property in another country needs no code change.
 */

export interface NormalizePhoneOptions {
  /** E.164 country code applied to a bare local number, e.g. `+974`. */
  defaultCountryCode: string;
}

/**
 * Returns the number in E.164 form, or `null` if it cannot be one.
 *
 * Deliberately conservative: it corrects formatting, it does not guess at
 * malformed input. A number it cannot normalise is rejected rather than
 * stored in a shape that will fail to match later.
 */
export function normalizePhone(input: string, options: NormalizePhoneOptions): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Everything a human might separate digits with.
  let cleaned = trimmed.replace(/[\s()\-.]/g, '');

  // 00 is the international prefix in most of the world, including Qatar.
  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`;
  }

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    return /^\d{6,15}$/.test(digits) ? `+${digits}` : null;
  }

  if (!/^\d+$/.test(cleaned)) {
    return null;
  }

  const countryDigits = options.defaultCountryCode.replace(/\D/g, '');

  // Already carries the country code without a plus, e.g. 97455550003.
  if (cleaned.startsWith(countryDigits) && cleaned.length > countryDigits.length) {
    return `+${cleaned}`;
  }

  // A bare local number.
  return /^\d{6,15}$/.test(cleaned) ? `+${countryDigits}${cleaned}` : null;
}
