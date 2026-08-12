/**
 * The API client.
 *
 * Every value shown to a member comes from here. Nothing in this app hardcodes
 * a discount, a guest cap, a reservation number or a term — R14 means the
 * dashboard is the only place those live, and a client that "helpfully"
 * defaults one would break that as surely as the server would.
 */

const BASE = '/api';

/**
 * The access token lives here, in memory, and nowhere else.
 *
 * security-implementation.md §4 forbids `localStorage` — any XSS flaw against
 * web storage becomes total account theft for every member who ever opened the
 * app. A module variable is unreadable by an injected script and gone when the
 * tab closes.
 *
 * **The refresh token is not here at all.** It is an `httpOnly` cookie the
 * server sets, which this code cannot read and does not need to: the browser
 * attaches it to `/auth/refresh` by itself. That is what makes a session
 * survive a page reload without putting a thirty-day credential somewhere a
 * script can reach — see `src/security/session-cookie.ts` on the server.
 */
let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function setTokens(next: { accessToken: string }): void {
  accessToken = next.accessToken;
}

export function clearTokens(): void {
  accessToken = null;
}

/**
 * Try to pick up an existing session on page load.
 *
 * The refresh cookie outlives the page; the access token does not. Without this
 * the cookie would sit there unused and every reload would still demand a fresh
 * sign-in — which is exactly the problem the cookie was introduced to solve.
 *
 * Returns false for the ordinary case of nobody being signed in, so the caller
 * shows the sign-in screen rather than an error.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshPromise !== null) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        clearTokens();
        return false;
      }
      setTokens((await response.json()) as { accessToken: string });
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export async function resumeSession(): Promise<boolean> {
  return refreshSession();
}

export function isSignedIn(): boolean {
  return accessToken !== null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * The rest of the error body.
     *
     * Some refusals carry what the screen needs next — a 422 asking which outlet
     * the guest means arrives with the list of outlets attached. Dropping it here
     * would mean a second round trip to fetch something the server already sent.
     */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function call<T>(
  path: string,
  options: RequestOptions = {},
  retryOnUnauthorized = true,
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (auth && accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // One retry on 401, after rotating the refresh token. Access tokens are 30
  // minutes for the member app, so this is the ordinary path, not an edge case.
  //
  // No token is sent: the refresh cookie goes on its own. `credentials` is
  // 'same-origin' by default and the API is same-origin here — through Vite's
  // proxy in development, and through Caddy in production — so nothing needs
  // setting. If the API ever moves to its own origin this breaks, loudly, at
  // exactly this line.
  if (response.status === 401 && auth && retryOnUnauthorized) {
    if (await refreshSession()) {
      return call<T>(path, options, false);
    }
    clearTokens();
  } else if (response.status === 401 && auth) {
    clearTokens();
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    } & Record<string, unknown>;
    const { error: _code, message: _message, ...details } = payload;
    throw new ApiError(
      response.status,
      payload.error ?? 'unknown',
      payload.message ?? 'Something went wrong.',
      details,
    );
  }

  return (await response.json()) as T;
}

// ── Types, mirroring what the API returns ────────────────────────────────

export interface Benefit {
  key: string;
  title: string;
  category: string;
  discountPct: string;
  secondaryLabel: string | null;
  secondaryPct: string | null;
  childRules: Record<string, number> | null;
  maxGuests: number | null;
  minGuests: number | null;
  reservationPhone: string | null;
  terms: string;
  sortOrder: number;
}

export interface ConsentState {
  channel: string;
  granted: boolean;
  wordingVersion: string;
  recordedAt: string;
}

export interface MemberProfile {
  id: string;
  memberNumber: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  status: string;
  joinedAt: string;
  claimedAt: string | null;
  consent: Record<string, ConsentState | null>;
  /**
   * The signed code the card carries — the same value printed on the back of the
   * physical card, so a guest can present either one.
   *
   * It identifies and grants nothing: staff still have to be signed in at an
   * outlet to record anything against it.
   */
  cardCode: string;
}

export interface Redemption {
  id: string;
  partySize: number | null;
  /**
   * The rate given on *this visit*, recorded at the time. Deliberately not
   * `benefit.discountPct` — that is today's offer, and showing it against a
   * past visit tells a member they received something they did not.
   */
  discountPctApplied: string;
  /**
   * What this visit saved, in fils, computed by the server from the bill and
   * the rate applied.
   *
   * Null when no bill was captured — an ordinary outcome, since recording a
   * redemption never required an amount. It stays distinguishable from a
   * genuine zero so the screen can say the amount is unknown rather than claim
   * the visit saved nothing. Negative on a reversal, so a total nets.
   */
  savedMinor: number | null;
  occurredAt: string;
  reversesId: string | null;
  benefit: { key: string; title: string };
  outlet: { name: string };
}

export interface OutletChoice {
  id: string;
  name: string;
  kind: string;
}

/**
 * A member telling an outlet they are coming, and what happened next.
 *
 * Nothing approves this — the member is already entitled to every published
 * benefit, so `SENT` means the outlet has been told and the guest can simply turn
 * up. `FULFILLED` is the only state that means the benefit was actually given;
 * `NOT_USED` means the visit did not happen and leaves the entitlement intact.
 *
 * The other three are historical, from when an administrator stood in the middle.
 * They appear only on old rows.
 */
export interface BenefitRequest {
  id: string;
  status: 'SENT' | 'FULFILLED' | 'NOT_USED' | 'PENDING' | 'APPROVED' | 'DECLINED';
  requestedAt: string;
  note: string | null;
  closedAt: string | null;
  closedReason: string | null;
  fulfilledAt: string | null;
  benefit: { key: string; title: string; discountPct: string };
  outlet: { id: string; name: string } | null;
}

/**
 * The server refusing to guess which outlet a guest meant.
 *
 * Returned as a 422 with the choices attached, rather than as an error the client
 * has to translate — the list is what the screen needs to show next.
 */
export interface OutletChoiceRequired {
  error: 'outlet_required' | 'outlet_not_valid';
  message: string;
  outlets: OutletChoice[];
}

// ── Calls ────────────────────────────────────────────────────────────────

export const api = {
  /**
   * Activation, in one call. The invitation code arrived in the member's inbox,
   * so receiving it already proved they control that address — there is no
   * second code to wait for.
   */
  claimComplete: (input: {
    claimCode: string;
    phone: string;
    consent: { email: boolean; sms: boolean };
  }) =>
    call<{ memberNumber: string; accessToken: string }>('/member/claim', {
      method: 'POST',
      body: input,
      auth: false,
    }),

  signInRequestOtp: (phone: string) =>
    call<{ message: string }>('/auth/member/request-otp', {
      method: 'POST',
      body: { phone },
      auth: false,
    }),

  signInVerifyOtp: (phone: string, code: string) =>
    call<{ accessToken: string }>('/auth/member/verify-otp', {
      method: 'POST',
      body: { phone, code },
      auth: false,
    }),

  benefits: (fresh = false) =>
    call<{ benefits: Benefit[] }>(fresh ? `/benefits?refresh=${Date.now()}` : '/benefits'),
  me: () => call<MemberProfile>('/member/me'),

  /**
   * The member's visit history.
   *
   * `fresh` matters more here than anywhere else. This history is written by an
   * outlet, on their device, and the member's copy is a cache in two senses: the
   * service worker holds the last response (NetworkFirst, see `vite.config.ts`)
   * and the app holds the parsed result in session state. A visit recorded at
   * the counter invalidates both, and nothing tells either of them so.
   *
   * The query parameter is what reaches past the service worker: its rule is
   * anchored on `…/redemptions$`, so a URL carrying a search string does not
   * match it and goes to the network unconditionally. That anchor is load-
   * bearing — `client-invariants.test.ts` holds both halves together.
   *
   * The server has no querystring schema on this route, so the parameter is
   * read by nothing and changes no response.
   */
  redemptions: (fresh = false) =>
    call<{ redemptions: Redemption[] }>(
      fresh ? `/member/me/redemptions?refresh=${Date.now()}` : '/member/me/redemptions',
    ),

  requests: () => call<{ requests: BenefitRequest[] }>('/member/me/requests'),

  /** Where a benefit can be used, for the picker. */
  benefitOutlets: (benefitKey: string) =>
    call<{ outlets: OutletChoice[] }>(
      `/member/me/benefits/${encodeURIComponent(benefitKey)}/outlets`,
    ),

  /**
   * `benefitKey` — the public key ("spa"), not an internal id. `GET /benefits`
   * never sends a member an id, so there is none to quote back, and the server
   * schema is strict: an unknown field is a 400, not a silently ignored one.
   *
   * `outletId` is omitted when only one outlet honours the benefit; the server
   * fills it in. When several do, leaving it out comes back as a 422 carrying the
   * list — which is how the screen learns it needs to ask.
   */
  announceVisit: (benefitKey: string, input: { outletId?: string; note?: string } = {}) =>
    call<BenefitRequest>('/member/me/requests', {
      method: 'POST',
      body: {
        benefitKey,
        ...(input.outletId ? { outletId: input.outletId } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    }),

  updateConsent: (body: { email?: boolean; sms?: boolean }) =>
    call<{ consent: Record<string, ConsentState | null> }>('/member/me/consent', {
      method: 'PATCH',
      body,
    }),
};
