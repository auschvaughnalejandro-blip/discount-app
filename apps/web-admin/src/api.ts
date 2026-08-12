/**
 * The admin dashboard's API client.
 *
 * Nothing here computes a benefit value. The whole point of Stage 12 is that
 * an administrator changes a discount through a form field and the member app
 * reflects it — so this sends what was typed and shows what comes back.
 */

const BASE = '/api';

/**
 * §4 requires an `httpOnly; Secure; SameSite=Strict` cookie for the dashboard,
 * never `localStorage`. The API returns tokens in the body today, so this
 * holds them in a module variable: unreadable by injected script, and gone
 * when the tab closes — which on a shared back-office machine is the right
 * default anyway. Moving to cookies is a server change; see PROGRESS.md.
 */
let accessToken: string | null = null;

/**
 * The one rotation in flight, if any — and the fix for a dashboard that used to
 * die ten minutes after sign-in.
 *
 * ## What was actually happening
 *
 * A dashboard access token lasts ten minutes (§4); the refresh cookie behind it
 * lasts twelve hours. An administrator who left the Overview open should
 * therefore have kept working all afternoon, and instead lost the session
 * outright at the ten-minute mark, with every panel reporting "Authentication
 * required."
 *
 * The cause was concurrency, not expiry. `Overview` opens with five requests at
 * once (`Promise.all`), and `Reports` with four. The moment the access token
 * expires, all five come back 401 together — and each one used to POST
 * `/auth/refresh` on its own. Five parallel rotations, all presenting the *same*
 * cookie.
 *
 * Rotation is deliberately single-use: the first request consumes the token, and
 * the other four then present one that is already spent. `rotateRefreshToken`
 * cannot distinguish that from a stolen token being replayed, so it does the
 * only safe thing and revokes the whole family (security-implementation.md §4).
 * That revocation takes the winner's brand-new token with it, so the *next*
 * refresh fails too and the session is unrecoverable without signing in again.
 *
 * Holding one promise makes the four followers await the same rotation instead
 * of racing it. The member and outlet clients have always done this; the
 * dashboard was the one that did not, and it is also the only one that opens
 * with a five-way fan-out — which is why it was the only one that broke.
 */
let refreshPromise: Promise<boolean> | null = null;

/** See `onSessionEnd`. */
let sessionEndedHandler: (() => void) | null = null;

export function setTokens(tokens: { accessToken: string }): void {
  accessToken = tokens.accessToken;
}

/**
 * Deliberately not exported. It was, and the "Sign out" button called it and
 * nothing else — dropping the access token while leaving the refresh cookie
 * intact, so the next load signed the administrator straight back in. Callers
 * outside this module want `signOut` (deliberate) or get `endSession`
 * (involuntary); neither case is served by forgetting half a session.
 */
function clearTokens(): void {
  accessToken = null;
}

/**
 * Register the callback that returns the dashboard to its sign-in screen.
 *
 * Forgetting the access token is not enough on its own. `App` decides what to
 * render from its own `signedIn` state, so a session that ended in the
 * background left the whole dashboard mounted and every panel showing the API's
 * "Authentication required." — an error message standing where a sign-in form
 * belonged, and no way forward but a manual page reload.
 *
 * Returns an unsubscribe, so a remount in development does not leave a stale
 * handler pointing at an unmounted tree.
 */
export function onSessionEnd(handler: () => void): () => void {
  sessionEndedHandler = handler;
  return () => {
    if (sessionEndedHandler === handler) {
      sessionEndedHandler = null;
    }
  };
}

/**
 * The session is over: forget the token and tell the UI.
 *
 * Only fires the callback if there was a session to end, so the ordinary
 * "nobody is signed in yet" refresh on page load stays silent — `resumeSession`
 * returning false is how `App` learns about that case.
 */
function endSession(): void {
  const hadSession = accessToken !== null;
  accessToken = null;
  if (hadSession) {
    sessionEndedHandler?.();
  }
}

/**
 * Rotate the refresh cookie for a new access token, at most once at a time.
 *
 * Every caller that sees a 401 comes through here rather than calling
 * `/auth/refresh` directly — that funnelling is the whole point; see
 * `refreshPromise` above.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshPromise !== null) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        // The server refused: the cookie is spent, revoked or expired. This is
        // the one path that genuinely ends a session.
        endSession();
        return false;
      }
      setTokens((await response.json()) as { accessToken: string });
      return true;
    } catch {
      // `fetch` threw, so the request never reached a verdict — a dropped
      // connection, not a dead session. The token stays put and the caller
      // surfaces the failure, rather than throwing the administrator back to
      // the sign-in form because the Wi-Fi blinked.
      return false;
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
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
export async function resumeSession(): Promise<boolean> {
  return refreshSession();
}

/**
 * Sign out for real.
 *
 * `clearTokens` alone was what this used to do, and it only dropped the access
 * token held in this module — the refresh cookie survived untouched, so the very
 * next page load called `resumeSession`, presented the cookie, and signed the
 * administrator straight back in. On a shared back-office machine that is not a
 * cosmetic bug: the "Sign out" button did not end the session, it just hid it.
 *
 * `/auth/logout` revokes the token family server-side and clears the cookie.
 * Failures are swallowed deliberately — the local state is cleared either way,
 * because a button labelled "Sign out" must never leave somebody signed in.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    // Offline. The cookie outlives this, but the tab no longer holds a token.
  }
  clearTokens();
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
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

  /**
   * One retry on a 401, after rotating the refresh token.
   *
   * A dashboard access token lasts ten minutes (§4). Without this, every
   * button in the dashboard begins failing ten minutes after sign-in — and
   * because the failure arrives as a 401 rather than an exception, it surfaces
   * as an error message rather than as a prompt to sign in again.
   *
   * `retryOnUnauthorized` is what stops the retry retrying. The recursive call
   * used to pass `options` unchanged, so a route that answers 401 for a reason a
   * fresh token cannot fix would refresh and retry for as long as the server
   * kept saying no.
   */
  if (response.status === 401 && auth) {
    if (retryOnUnauthorized && (await refreshSession())) {
      return call<T>(path, options, false);
    }

    // A 401 that survived a *successful* refresh is the session itself being
    // refused — `tokenVersion` bumped by a sign-out elsewhere, or the account
    // suspended mid-session. Nothing else will work either, so end it here.
    // When the refresh is what failed, `refreshSession` has already decided
    // whether this was a dead session or just a dropped connection.
    if (!retryOnUnauthorized) {
      endSession();
    }
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

/**
 * Fetch an endpoint that returns a file rather than JSON.
 *
 * Not `call`, which parses the body as JSON. It also cannot be a plain `<a
 * href>`: the request needs an Authorization header, and putting a token in a
 * URL would leak it into browser history, server logs and referrer headers (§4).
 *
 * The 401 retry mirrors `call`, and did not exist while the redemption export
 * was the only download — so that button began failing ten minutes after
 * sign-in, when the access token expired (§4), and reported it as "Could not
 * export" rather than refreshing the way every other button in the dashboard
 * does. Both downloads now share the one implementation and the fix.
 */
async function downloadFile(
  path: string,
  fallbackName: string,
  retry = true,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`${BASE}${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });

  if (response.status === 401 && retry) {
    // Through `refreshSession`, not a bare `fetch`, so a download that starts
    // while the panels behind it are already refreshing joins that rotation
    // rather than racing it into family revocation — see `refreshPromise`.
    if (await refreshSession()) {
      // Once only — a second 401 is a real refusal, not an expired token.
      return downloadFile(path, fallbackName, false);
    }
  } else if (response.status === 401) {
    endSession();
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(
      response.status,
      payload.error ?? 'unknown',
      payload.message ?? 'Could not export.',
    );
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), filename: match?.[1] ?? fallbackName };
}

/**
 * What a notice's state can be.
 *
 * `SENT` and its two endings are the live set. The other three are historical,
 * from when an administrator approved or declined every request — kept so old
 * rows still render rather than falling through to a blank cell.
 */
export type RequestStatus =
  | 'SENT'
  | 'FULFILLED'
  | 'NOT_USED'
  | 'PENDING'
  | 'APPROVED'
  | 'DECLINED';

export interface MemberRow {
  id: string;
  memberNumber: string;
  fullName: string;
  /** Null where no contact number was captured — a real state, not missing data. */
  phone: string | null;
  status: string;
  joinedAt: string;
  appClaimed: boolean;
  totalUses: number;
  lastUsedAt: string | null;
}

/**
 * A figure the server withheld because fewer than `minCohortSize` distinct
 * members stand behind it (R13, security-implementation.md §6).
 *
 * It arrives as this sentinel *string*, not a number and not `null` — so any
 * code rendering a report figure is forced to decide what to display. The
 * previous typing here was `Record<string, unknown>`, and the dashboard did
 * `String(summary['redemptions'])`, which printed the raw sentinel
 * `insufficient_data` into the page. Typing it is what makes that unwritable.
 */
export const INSUFFICIENT_DATA = 'insufficient_data';

export type Figure = number | typeof INSUFFICIENT_DATA;

export function isWithheld(value: Figure): value is typeof INSUFFICIENT_DATA {
  return value === INSUFFICIENT_DATA;
}

/** `GET /admin/reports/summary`. */
export interface ReportSummary {
  /** True when the four cohort figures below were withheld as a group. */
  suppressed: boolean;
  redemptions: Figure;
  guests: Figure;
  activeMembers: Figure;
  estValueMinor: Figure;
  /**
   * Membership totals describe the programme rather than a filtered slice of
   * member behaviour, so they are never withheld — see the comment in
   * `routes/reports.ts`. That makes them the figures the overview can always
   * lead with, even on a database too small to report on.
   */
  totalMembers: number;
  neverUsed: number;
  minCohortSize: number;
}

/**
 * A member as the *report* endpoints return one — narrower than `MemberRow`.
 *
 * `dormant-members` and `unclaimed` were typed as returning `MemberRow`, which
 * declares `appClaimed`, `totalUses` and `lastUsedAt` as required. The server
 * sends none of the three (verified against a live response), so anything
 * rendering `member.totalUses` from one of those lists would have printed
 * `undefined` with nothing failing to warn it. These lists exist to name people
 * to follow up, so the identifying fields are all they carry.
 */
export interface ReportMember {
  id: string;
  memberNumber: string;
  fullName: string;
  status: string;
  joinedAt: string;
  /** Returned by `dormant-members`; absent from `unclaimed`. */
  claimedAt?: string | null;
}

/** One row of `GET /admin/reports/by-benefit`, at the default metric. */
export interface BenefitGroup {
  label: string;
  suppressed: boolean;
  redemptions: Figure;
}

export interface StaffRow {
  id: string;
  fullName: string;
  email: string;
  role: 'ADMINISTRATOR';
  status: string;
  createdAt: string;
  /** Null until they have set up a second factor. Never the secret itself. */
  mfaEnrolledAt: string | null;
}

/** A counter device. The plaintext credential is returned only when issued. */
export interface OutletDeviceRow {
  id: string;
  fullName: string;
  status: string;
  createdAt: string;
  outletId: string | null;
  outletTokenIssuedAt: string;
  outletTokenLastUsedAt: string | null;
}

export interface AdminBenefit {
  id: string;
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
  outletKind: 'DINING' | 'SPA' | 'ROOMS' | 'EVENTS' | 'OTHER' | null;
  published: boolean;
  version: number;
  updatedAt: string;
  updatedBy: { id: string; fullName: string } | null;
}

export type UpdateBenefitInput = Partial<
  Pick<
    AdminBenefit,
    | 'title'
    | 'category'
    | 'discountPct'
    | 'secondaryLabel'
    | 'secondaryPct'
    | 'childRules'
    | 'maxGuests'
    | 'minGuests'
    | 'reservationPhone'
    | 'terms'
    | 'sortOrder'
    | 'outletKind'
  >
> & { expectedVersion: number };

/**
 * What `POST /auth/staff/login` returns.
 *
 * Normally a password yields a challenge and nothing else — §3 requires a second
 * factor, so `stage` says only whether the account still has to enrol.
 *
 * The signed-in variant appears when the server runs with
 * `STAFF_MFA_REQUIRED=false`, which it refuses to do in production. It is a
 * local-development convenience: the second factor is a TOTP code, and without
 * an authenticator app that means reading `npm run mfa:code` in another terminal
 * on every single sign-in.
 *
 * A discriminated union rather than optional fields, so the caller cannot read
 * `challengeToken` off a response that has none — which is the mistake this
 * shape exists to make unwritable.
 */
export type StaffLoginResult =
  | { mfaRequired: true; stage: 'enroll' | 'verify'; challengeToken: string }
  | { mfaRequired: false; accessToken: string };

export const api = {
  login: (email: string, password: string) =>
    call<StaffLoginResult>('/auth/staff/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),

  /** Issues a fresh secret and the URI an authenticator app scans. */
  mfaEnrollStart: (challengeToken: string) =>
    call<{ otpauthUri: string; secret: string }>('/auth/staff/mfa/enroll', {
      method: 'POST',
      body: { challengeToken },
      auth: false,
    }),

  /** Confirms enrollment and returns tokens plus the one-time recovery codes. */
  mfaEnrollConfirm: (challengeToken: string, code: string) =>
    call<{ accessToken: string; recoveryCodes: string[] }>(
      '/auth/staff/mfa/enroll/confirm',
      { method: 'POST', body: { challengeToken, code }, auth: false },
    ),

  /** A TOTP code, or a recovery code in place of one. */
  mfaVerify: (challengeToken: string, input: { code?: string; recoveryCode?: string }) =>
    call<{ accessToken: string; recoveryCodesRemaining?: number }>(
      '/auth/staff/mfa/verify',
      { method: 'POST', body: { challengeToken, ...input }, auth: false },
    ),

  members: (query = '') =>
    call<{ total: number; limit: number; offset: number; members: MemberRow[] }>(
      `/admin/members${query}`,
    ),

  member: (id: string) => call<Record<string, unknown>>(`/admin/members/${id}`),

  createMember: (body: { fullName: string; phone?: string; email?: string }) =>
    call<{
      id: string;
      memberNumber: string;
      claimCode: { code: string; expiresAt: string };
    }>('/admin/members', { method: 'POST', body }),

  suspend: (id: string) =>
    call<{ status: string }>(`/admin/members/${id}/suspend`, { method: 'POST', body: {} }),
  reinstate: (id: string) =>
    call<{ status: string }>(`/admin/members/${id}/reinstate`, { method: 'POST', body: {} }),
  resendClaim: (id: string) =>
    call<{ claimCode: { code: string; expiresAt: string } }>(`/admin/members/${id}/resend-claim`, {
      method: 'POST',
      body: {},
    }),

  benefits: () => call<{ benefits: AdminBenefit[] }>('/admin/benefits'),
  updateBenefit: (id: string, body: UpdateBenefitInput) =>
    call<AdminBenefit>(`/admin/benefits/${id}`, { method: 'PATCH', body }),
  publishBenefit: (id: string, published: boolean) =>
    call<AdminBenefit>(`/admin/benefits/${id}/publish`, {
      method: 'POST',
      body: { published },
    }),

  summary: () => call<ReportSummary>('/admin/reports/summary'),
  byBenefit: () =>
    call<{ minCohortSize: number; groups: BenefitGroup[] }>('/admin/reports/by-benefit'),
  dormant: () =>
    call<{ members: ReportMember[]; total: number }>('/admin/reports/dormant-members'),
  unclaimed: () => call<{ members: ReportMember[]; total: number }>('/admin/reports/unclaimed'),

  redemptions: () =>
    call<{
      total: number;
      redemptions: {
        id: string;
        partySize: number | null;
        billAmountMinor: number | null;
        occurredAt: string;
        reversesId: string | null;
        // The rate recorded on the visit, not the benefit's current one.
        discountPctApplied: string;
        benefitVersion: number;
        member: { memberNumber: string; fullName: string };
        benefit: { title: string };
        outlet: { name: string };
        staffUser: { fullName: string };
      }[];
    }>('/admin/redemptions'),

  /**
   * The notice monitor. **Read-only** — there is nothing here to decide.
   *
   * A guest is entitled to every published benefit already, so a notice is not a
   * petition: it tells one outlet to expect somebody. The outlet closes it out by
   * confirming the visit or recording that it never happened. `PENDING`,
   * `APPROVED` and `DECLINED` appear only on rows that predate that change.
   */
  requests: (status?: RequestStatus) =>
    call<{
      total: number;
      requests: {
        id: string;
        status: RequestStatus;
        requestedAt: string;
        note: string | null;
        /** When the outlet first looked at its list after this arrived. */
        seenAt: string | null;
        notifiedAt: string | null;
        notifyStatus: string | null;
        closedAt: string | null;
        closedReason: string | null;
        fulfilledAt: string | null;
        member: { id: string; memberNumber: string; fullName: string; status: string };
        benefit: { id: string; key: string; title: string; discountPct: string };
        outlet: { id: string; name: string } | null;
        closedBy: { fullName: string } | null;
      }[];
    }>(`/admin/requests${status ? `?status=${status}` : ''}`),

  /** Outlets with their notice address and token-backed counter devices. */
  manageOutlets: () =>
    call<{
      outlets: {
        id: string;
        name: string;
        kind: string;
        active: boolean;
        notifyEmail: string | null;
        devices: OutletDeviceRow[];
      }[];
    }>('/admin/outlets/manage'),

  updateOutlet: (id: string, input: { notifyEmail?: string | null; active?: boolean }) =>
    call<{ id: string; notifyEmail: string | null; active: boolean }>(
      `/admin/outlets/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: input },
    ),

  /** The token is present in this response once and is never returned by a GET. */
  createOutletDevice: (outletId: string, input: { label: string }) =>
    call<{ device: OutletDeviceRow; token: string }>(
      `/admin/outlets/${encodeURIComponent(outletId)}/devices`,
      { method: 'POST', body: input },
    ),

  /** Invalidates the old credential and returns its replacement exactly once. */
  rotateOutletDevice: (id: string) =>
    call<{ device: OutletDeviceRow; token: string }>(
      `/admin/outlets/devices/${encodeURIComponent(id)}/rotate`,
      { method: 'POST', body: {} },
    ),

  /** Revocation is one-way; recovering a device means issuing a replacement. */
  revokeOutletDevice: (id: string) =>
    call<{ id: string; status: string }>(
      `/admin/outlets/devices/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', body: {} },
    ),

  /** The redemption export, as the file itself. See `downloadFile`. */
  exportCsv: () => downloadFile('/admin/reports/export', 'redemptions.csv'),

  /**
   * The card-print export: membership number, name and card code, for the
   * bureau that manufactures the physical cards.
   *
   * Separately permissioned from the redemption export (`members:export-cards`),
   * because this one carries names and that one deliberately does not — see the
   * route in `admin-members.ts`.
   *
   * `since` takes an ISO timestamp and exists for a top-up run: the members
   * added since the last batch, rather than re-exporting and reprinting the
   * whole membership.
   */
  exportCardsCsv: (filters: { status?: 'ACTIVE' | 'SUSPENDED'; since?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.since) params.set('since', filters.since);
    const query = params.toString();
    return downloadFile(
      `/admin/members/card-export${query ? `?${query}` : ''}`,
      'privilege-guest-cards.csv',
    );
  },

  /** Settings needed before sign-in. Public; see routes/health.ts. */
  config: () => call<{ defaultCountryCode: string }>('/config', { auth: false }),

  staff: () => call<{ staff: StaffRow[] }>('/admin/staff'),

  createStaff: (body: {
    fullName: string;
    email: string;
    password: string;
  }) => call<StaffRow>('/admin/staff', { method: 'POST', body }),

  setStaffStatus: (id: string, suspend: boolean) =>
    call<StaffRow>(`/admin/staff/${id}/${suspend ? 'suspend' : 'reinstate'}`, {
      method: 'POST',
      body: {},
    }),

  resetStaffMfa: (id: string) =>
    call<{ id: string; message: string }>(`/admin/staff/${id}/reset-mfa`, {
      method: 'POST',
      body: {},
    }),

  setStaffPassword: (id: string, password: string) =>
    call<{ id: string }>(`/admin/staff/${id}/set-password`, { method: 'POST', body: { password } }),

  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    call<{ id: string; message: string }>('/auth/staff/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  outlets: () =>
    call<{ outlets: { id: string; name: string; kind: string }[] }>('/admin/outlets'),

  /**
   * Marks a benefit used. `requestId` links it to the approval it spends; a
   * member who simply turned up is recorded without one.
   */
  recordRedemption: (input: {
    memberId: string;
    benefitId: string;
    outletId: string;
    partySize?: number;
    billAmountMinor?: number;
    requestId?: string;
    idempotencyKey: string;
  }) => call<{ id: string; occurredAt: string }>('/admin/redemptions', { method: 'POST', body: input }),

  reverse: (id: string, reason: string) =>
    call<{ id: string }>(`/admin/redemptions/${id}/reverse`, {
      method: 'POST',
      body: { reason, idempotencyKey: crypto.randomUUID() },
    }),
};
