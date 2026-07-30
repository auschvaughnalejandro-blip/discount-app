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

export function setToken(token: string): void {
  accessToken = token;
}
export function clearToken(): void {
  accessToken = null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
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

export interface AdminBenefit {
  id: string;
  key: string;
  title: string;
  category: string;
  discountPct: string;
  secondaryLabel: string | null;
  secondaryPct: string | null;
  maxGuests: number | null;
  minGuests: number | null;
  reservationPhone: string | null;
  terms: string;
  published: boolean;
  version: number;
  updatedAt: string;
  updatedBy: { id: string; fullName: string } | null;
}

/**
 * What `POST /auth/staff/login` returns since Stage 19.
 *
 * A dashboard account never gets tokens from a password — §3 requires a second
 * factor, so the password yields a challenge and nothing else. `stage` says
 * whether the account still has to enrol.
 */
export type StaffLoginResult =
  | { mfaRequired: true; stage: 'enroll' | 'verify'; challengeToken: string }
  | { mfaRequired?: false; accessToken: string; refreshToken: string };

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
    call<{ accessToken: string; refreshToken: string; recoveryCodes: string[] }>(
      '/auth/staff/mfa/enroll/confirm',
      { method: 'POST', body: { challengeToken, code }, auth: false },
    ),

  /** A TOTP code, or a recovery code in place of one. */
  mfaVerify: (challengeToken: string, input: { code?: string; recoveryCode?: string }) =>
    call<{ accessToken: string; refreshToken: string; recoveryCodesRemaining?: number }>(
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
  updateBenefit: (id: string, body: Record<string, unknown>) =>
    call<AdminBenefit>(`/admin/benefits/${id}`, { method: 'PATCH', body }),
  publishBenefit: (id: string, published: boolean) =>
    call<{ published: boolean; version: number }>(`/admin/benefits/${id}/publish`, {
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
        member: { memberNumber: string; fullName: string };
        benefit: { title: string; discountPct: string };
        outlet: { name: string };
        staffUser: { fullName: string };
      }[];
    }>('/admin/redemptions'),

  reverse: (id: string, reason: string) =>
    call<{ id: string }>(`/admin/redemptions/${id}/reverse`, {
      method: 'POST',
      body: { reason, idempotencyKey: crypto.randomUUID() },
    }),
};
