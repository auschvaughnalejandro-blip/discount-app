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
 * security-implementation.md §4 requires the member app to hold tokens in the
 * platform keystore (iOS Keychain, Android Keystore) and forbids
 * `localStorage`, because any XSS flaw then becomes total account theft.
 *
 * This is a browser build, where neither keystore exists. Holding the token in
 * a module-scoped variable keeps it out of any storage an injected script can
 * read, at the cost of a sign-in on every reload. That is the honest trade
 * here; a native shell would replace this with the keystore, and a browser
 * deployment intended for production would need the httpOnly cookie flow §4
 * specifies for the other two surfaces.
 */
let accessToken: string | null = null;
let refreshToken: string | null = null;

export function setTokens(next: { accessToken: string; refreshToken: string }): void {
  accessToken = next.accessToken;
  refreshToken = next.refreshToken;
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
}

export function isSignedIn(): boolean {
  return accessToken !== null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function call<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
  if (response.status === 401 && auth && refreshToken) {
    const refreshed = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (refreshed.ok) {
      const tokens = (await refreshed.json()) as { accessToken: string; refreshToken: string };
      setTokens(tokens);
      return call<T>(path, options);
    }

    clearTokens();
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(
      response.status,
      payload.error ?? 'unknown',
      payload.message ?? 'Something went wrong.',
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
}

export interface Redemption {
  id: string;
  partySize: number | null;
  occurredAt: string;
  reversesId: string | null;
  benefit: { key: string; title: string; discountPct: string };
  outlet: { name: string };
}

export interface IdentityCode {
  payload: string;
  windowHours: number;
  issuedAt: string;
}

// ── Calls ────────────────────────────────────────────────────────────────

export const api = {
  /** Phase 1 of activation: validates the code and sends an OTP. */
  claimRequestOtp: (claimCode: string, phone: string) =>
    call<{ message: string }>('/member/claim', {
      method: 'POST',
      body: { claimCode, phone },
      auth: false,
    }),

  /** Phase 2: verifies the OTP, captures consent, completes the claim. */
  claimComplete: (input: {
    claimCode: string;
    phone: string;
    otp: string;
    email?: string;
    consent: { email: boolean; sms: boolean };
  }) =>
    call<{ memberNumber: string; accessToken: string; refreshToken: string }>('/member/claim', {
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
    call<{ accessToken: string; refreshToken: string }>('/auth/member/verify-otp', {
      method: 'POST',
      body: { phone, code },
      auth: false,
    }),

  benefits: () => call<{ benefits: Benefit[] }>('/benefits'),
  me: () => call<MemberProfile>('/member/me'),
  redemptions: () => call<{ redemptions: Redemption[] }>('/member/me/redemptions'),
  identityCode: () => call<IdentityCode>('/member/me/identity-code'),

  updateConsent: (body: { email?: boolean; sms?: boolean }) =>
    call<{ consent: Record<string, ConsentState | null> }>('/member/me/consent', {
      method: 'PATCH',
      body,
    }),
};
