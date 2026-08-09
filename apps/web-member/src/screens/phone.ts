/**
 * The dial code the sign-in and activation screens show as a static prefix.
 *
 * It mirrors the server's `DEFAULT_PHONE_COUNTRY_CODE`, which defaults to
 * `+974` and is what `normalizePhone` applies to a bare local number. The two
 * have to agree: the member types eight digits, this app sends them with the
 * prefix attached, and the server stores E.164.
 *
 * Duplicating it here is the one concession — a single-property hotel in Doha
 * has one dial code, and fetching a constant before the sign-in form can render
 * would put a network round trip in front of the first screen. If a second
 * property in another country ever exists, this moves to an unauthenticated
 * config endpoint rather than growing a second constant.
 */
export const DIAL_CODE = '+974';

/**
 * Is this plausibly a mobile number, enough to enable the button?
 *
 * Deliberately shallow. The server normalises and is the authority on what it
 * will accept; this only exists so the primary action is not enabled over an
 * obviously incomplete field. Qatari mobile numbers are eight digits, so that
 * is the whole test — no leading-digit rule, because guessing at which prefixes
 * the regulator has issued is how a valid number gets rejected by a form.
 */
export function looksLikeMobile(national: string): boolean {
  return /^\d{8}$/.test(national.replace(/\s/g, ''));
}

/** Digits only, so paste of "3312 3456" or "+974 3312 3456" behaves. */
export function toNationalDigits(input: string): string {
  return input.replace(/\D/g, '').replace(/^974/, '').slice(0, 8);
}

/** E.164, the shape the server stores. */
export function toE164(national: string): string {
  return `${DIAL_CODE}${national.replace(/\s/g, '')}`;
}

/** "3312 3456" — grouped the way the number is said aloud. */
export function formatNational(national: string): string {
  const digits = national.replace(/\D/g, '');
  return digits.length <= 4 ? digits : `${digits.slice(0, 4)} ${digits.slice(4)}`;
}
