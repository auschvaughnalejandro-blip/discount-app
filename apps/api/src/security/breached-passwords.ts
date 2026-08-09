import { createHash } from 'node:crypto';

/**
 * Screening a password against known breaches.
 *
 * security-implementation.md §3: "Minimum length rather than composition rules,
 * screened against a breached-password list." Composition rules ("one capital,
 * one symbol") reliably produce `Password1!` and nothing better; what actually
 * distinguishes a weak password is whether it has already appeared in a dump.
 *
 * ## The password never leaves this process
 *
 * This uses Have I Been Pwned's range API, which is built on k-anonymity: we
 * send the **first five characters** of the SHA-1 hash and receive every
 * suffix HIBP holds under that prefix — several hundred of them. The
 * comparison happens here. HIBP learns five hex characters, which describes
 * roughly one in a million passwords and identifies nothing.
 *
 * SHA-1 is not a security choice here; it is the protocol HIBP speaks. The
 * password is still stored with Argon2id and a pepper.
 */

const RANGE_API = 'https://api.pwnedpasswords.com/range';

/** §3 states a minimum length and explicitly rejects composition rules. */
export const MINIMUM_PASSWORD_LENGTH = 12;

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'too_short' }
  | { ok: false; reason: 'breached'; occurrences: number };

export interface ScreenOptions {
  /**
   * Time to wait on HIBP. Short: this sits inside a staff member choosing a
   * password, and a slow answer is a support call.
   */
  timeoutMs?: number;
  /** Injected by tests, so the suite never depends on an external service. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns whether the password may be used.
 *
 * **Fails open on a network error**, deliberately, and says so in the return
 * value so the caller can log it. The alternative is that an HIBP outage stops
 * the hotel from onboarding staff or changing a compromised password — and
 * "you cannot change your password right now" is a worse security position than
 * an unscreened one, because the passwords people most urgently want to change
 * are the ones already known to be compromised.
 *
 * The length rule is local and therefore always enforced.
 */
export async function screenPassword(
  password: string,
  options: ScreenOptions = {},
): Promise<PasswordCheck & { screened: boolean }> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { ok: false, reason: 'too_short', screened: false };
  }

  const { timeoutMs = 2500, fetchImpl = fetch } = options;

  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let body: string;
    try {
      const response = await fetchImpl(`${RANGE_API}/${prefix}`, {
        signal: controller.signal,
        // Pads the response with random entries, so its *length* leaks nothing
        // about how many real matches the prefix has.
        headers: { 'Add-Padding': 'true' },
      });
      if (!response.ok) {
        return { ok: true, screened: false };
      }
      body = await response.text();
    } finally {
      clearTimeout(timer);
    }

    for (const line of body.split('\n')) {
      const [candidate, count] = line.trim().split(':');
      if (candidate === suffix) {
        const occurrences = Number(count ?? 0);
        // Padding entries are returned with a count of 0 and are not real hits.
        if (occurrences > 0) {
          return { ok: false, reason: 'breached', occurrences, screened: true };
        }
      }
    }

    return { ok: true, screened: true };
  } catch {
    return { ok: true, screened: false };
  }
}
