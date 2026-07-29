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
  status: string;
  joinedAt: string;
  appClaimed: boolean;
  totalUses: number;
  lastUsedAt: string | null;
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

export const api = {
  login: (email: string, password: string) =>
    call<{ accessToken: string; refreshToken: string }>('/auth/staff/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),

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

  summary: () => call<Record<string, unknown>>('/admin/reports/summary'),
  byBenefit: () =>
    call<{ minCohortSize: number; groups: Record<string, unknown>[] }>('/admin/reports/by-benefit'),
  dormant: () => call<{ members: MemberRow[]; total: number }>('/admin/reports/dormant-members'),
  unclaimed: () => call<{ members: MemberRow[]; total: number }>('/admin/reports/unclaimed'),

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
