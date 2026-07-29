/**
 * The verification page's API client.
 *
 * Deliberately narrow. There is no list call, no search call and no member
 * endpoint of any kind here beyond resolving the one person standing at the
 * counter — R11 requires that path to be absent rather than hidden, and the
 * server refuses it for this role regardless, but a client that offered the
 * button would still be wrong.
 */

const BASE = '/api';

/**
 * security-implementation.md §4 requires the verification page to hold its
 * session in an `httpOnly; Secure; SameSite=Strict` cookie, never
 * `localStorage`, because this runs on a shared device behind a counter.
 *
 * The API returns tokens in the response body today, so this holds them in a
 * module variable — out of any storage an injected script can read, and gone
 * when the tab closes, which on a shared machine is the behaviour you want
 * anyway. Moving to cookies is a server change; recorded in PROGRESS.md.
 */
let accessToken: string | null = null;

export function setToken(token: string): void {
  accessToken = token;
}

export function clearToken(): void {
  accessToken = null;
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

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

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

export interface Entitlement {
  id: string;
  key: string;
  title: string;
  discountPct: string;
  secondaryLabel: string | null;
  secondaryPct: string | null;
  maxGuests: number | null;
  minGuests: number | null;
  terms: string;
}

export interface ResolvedMember {
  verificationSession: string;
  verificationSessionExpiresIn: number;
  member: {
    id: string;
    memberNumber: string;
    fullName: string;
    status: string;
    joinedAt: string;
    valid: boolean;
  };
  entitlements: Entitlement[];
  recentUse: {
    id: string;
    partySize: number | null;
    occurredAt: string;
    benefit: { key: string; title: string };
    outlet: { name: string };
  }[];
}

export const api = {
  login: (email: string, password: string) =>
    call<{ accessToken: string; refreshToken: string }>('/auth/staff/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),

  /** R12: an exact membership number or a scanned payload. Nothing else. */
  resolve: (input: { membershipNumber?: string; payload?: string }) =>
    call<ResolvedMember>('/verify/resolve', { method: 'POST', body: input }),

  record: (input: {
    verificationSession: string;
    memberId: string;
    benefitId: string;
    partySize?: number;
    billAmountMinor?: number;
    idempotencyKey: string;
  }) => call<{ id: string; idempotent: boolean }>('/verify/redemptions', {
    method: 'POST',
    body: input,
  }),
};
