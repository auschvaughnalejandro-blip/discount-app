/**
 * The outlet screen's API client.
 *
 * Same token discipline as the other two clients: the access token lives in a
 * module variable and nowhere a script or a log can reach it (§4 forbids
 * `localStorage` — an XSS flaw there becomes total session theft).
 *
 * The browser holds the rotating refresh token in an httpOnly cookie and ignores
 * the body copy returned for non-browser clients. Browser code never persists
 * either token in web storage. A reload resumes from the cookie and asks
 * `/outlet/me` which outlet the device belongs to.
 */

const BASE = '/api';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function isSignedIn(): boolean {
  return accessToken !== null;
}

export function clearTokens(): void {
  accessToken = null;
}

function setTokens(next: { accessToken: string }): void {
  accessToken = next.accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function refreshSession(): Promise<boolean> {
  if (refreshPromise !== null) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The browser's httpOnly cookie is the only refresh credential.
        body: '{}',
      });
      if (!response.ok) {
        clearTokens();
        return false;
      }
      const next = (await response.json()) as { accessToken: string };
      setTokens(next);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

/** Resume a browser session without showing the sign-in form first. */
export function resumeSession(): Promise<boolean> {
  return refreshSession();
}

/**
 * End the server-side refresh session as well as dropping the access token here.
 *
 * Clearing memory alone leaves a shared counter device able to resume on its
 * next reload. The endpoint always receives an empty object because the browser's
 * httpOnly cookie is the credential and deliberately cannot be read here.
 */
export async function logout(): Promise<void> {
  try {
    const response = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error('Sign-out was not confirmed.');
  } finally {
    clearTokens();
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
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // One retry on 401 after rotating. The staff access token is ten minutes, so a
  // screen left open through a service period hits this constantly — it is the
  // ordinary path, not an edge case.
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

// ── Types, mirroring what the API returns ──────────────────────────────────

export interface Outlet {
  id: string;
  name: string;
  kind: string;
}

export interface QueuedBenefit {
  id: string;
  key: string;
  title: string;
  discountPct: string;
  maxGuests: number | null;
  minGuests: number | null;
  terms: string;
}

/**
 * A guest telling this outlet they are coming.
 *
 * Carries the membership number and never the name (§9) — staff match it against
 * the card in the guest's hand, which shows the same number.
 */
export interface QueuedRequest {
  id: string;
  status: 'SENT' | 'FULFILLED' | 'NOT_USED';
  requestedAt: string;
  note: string | null;
  seenAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  fulfilledAt: string | null;
  /** True only on the call that first discovered it, so the screen can highlight. */
  isNew: boolean;
  member: { memberNumber: string };
  benefit: QueuedBenefit;
}

export interface ResolvedBenefit extends QueuedBenefit {
  outletKind: string | null;
  /** The notice to confirm instead of recording a second, unlinked visit. */
  openRequestId: string | null;
}

export interface ResolvedMember {
  verificationSession: string;
  verificationSessionExpiresIn: number;
  member: { id: string; memberNumber: string; fullName: string };
  benefits: ResolvedBenefit[];
  recentAtThisOutlet: Array<{
    id: string;
    occurredAt: string;
    partySize: number | null;
    benefit: { title: string };
  }>;
}

/**
 * A key the server uses to collapse a retry into the original write (R8).
 *
 * Generated per attempt and reused across retries of that same attempt, which is
 * the only way it means anything: a fresh key on every click would record two
 * visits for one guest the moment somebody double-tapped a slow button.
 */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}

export const api = {
  /** Exchange this device's long-lived credential for a normal staff session. */
  signInWithToken: async (token: string) => {
    const result = await call<{
      accessToken: string;
      accessTokenExpiresIn: number;
      refreshToken: string;
      outlet: Outlet;
    }>('/outlet/auth/token', {
      method: 'POST',
      body: { token },
      auth: false,
    });
    // The refresh-token body field exists for native clients. This browser uses
    // only the httpOnly cookie set by the response.
    setTokens({ accessToken: result.accessToken });
    return result;
  },

  me: () => call<{ outlet: Outlet }>('/outlet/me'),

  requests: (status: 'SENT' | 'FULFILLED' | 'NOT_USED' = 'SENT') =>
    call<{ requests: QueuedRequest[] }>(`/outlet/requests?status=${status}`),

  confirm: (
    id: string,
    input: { partySize?: number; billAmountMinor?: number; idempotencyKey: string },
  ) =>
    call<{ id: string }>(`/outlet/requests/${id}/confirm`, {
      method: 'POST',
      body: {
        // First, and not for tidiness: R8's key is the one field this call cannot
        // omit, and `client-invariants.test.ts` reads the start of the posted body
        // to check the name still matches the server's schema.
        idempotencyKey: input.idempotencyKey,
        ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
        ...(input.billAmountMinor !== undefined
          ? { billAmountMinor: input.billAmountMinor }
          : {}),
      },
    }),

  notUsed: (id: string, reason?: string) =>
    call<{ id: string; status: string }>(`/outlet/requests/${id}/not-used`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),

  /** Exactly one of the two. The server refuses both together. */
  resolve: (input: { payload?: string; membershipNumber?: string }) =>
    call<ResolvedMember>('/outlet/resolve', { method: 'POST', body: input }),

  recordScan: (input: {
    verificationSession: string;
    memberId: string;
    benefitId: string;
    partySize?: number;
    billAmountMinor?: number;
    idempotencyKey: string;
  }) =>
    call<{ id: string }>('/outlet/redemptions', {
      method: 'POST',
      body: {
        idempotencyKey: input.idempotencyKey,
        verificationSession: input.verificationSession,
        memberId: input.memberId,
        benefitId: input.benefitId,
        ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
        ...(input.billAmountMinor !== undefined
          ? { billAmountMinor: input.billAmountMinor }
          : {}),
      },
    }),
};
