import type { Role } from '@prisma/client';

/**
 * The permission catalogue and the role matrix, derived from
 * security-implementation.md §5 and product-definition.md §7.
 *
 * Adding a permission here is not enough to grant it — `ROLE_PERMISSIONS`
 * below is the only place a role gains anything, and it is exhaustive.
 */

export const PERMISSIONS = [
  // Members
  'members:create',
  'members:list',
  'members:read',
  'members:update',
  'members:suspend',
  'members:issue-claim',

  // Benefits
  'benefits:read-published',
  'benefits:read-all',
  'benefits:manage',

  // Verification and redemption
  'verify:resolve',
  'redemptions:record',
  'redemptions:list',
  'redemptions:reverse',

  // Reporting
  'reports:read',
  'reports:export',

  // Staff administration
  'staff:manage',

  // A member acting on their own record
  'member:self',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * `public` is the only way to register a route with no principal. It is a
 * deliberate, greppable declaration — not the absence of one, which fails
 * startup (R17).
 */
export type RoutePermission = Permission | 'public';

/** Which kind of principal a permission belongs to. */
export type Actor = 'MEMBER' | 'STAFF';

const PERMISSION_ACTORS: Record<Permission, Actor> = {
  'members:create': 'STAFF',
  'members:list': 'STAFF',
  'members:read': 'STAFF',
  'members:update': 'STAFF',
  'members:suspend': 'STAFF',
  'members:issue-claim': 'STAFF',
  'benefits:read-published': 'MEMBER',
  'benefits:read-all': 'STAFF',
  'benefits:manage': 'STAFF',
  'verify:resolve': 'STAFF',
  'redemptions:record': 'STAFF',
  'redemptions:list': 'STAFF',
  'redemptions:reverse': 'STAFF',
  'reports:read': 'STAFF',
  'reports:export': 'STAFF',
  'staff:manage': 'STAFF',
  'member:self': 'MEMBER',
};

/**
 * The role matrix, stated exhaustively rather than by inheritance or
 * wildcards. `administrator` is spelled out in full even though the document
 * says "everything", so that adding a permission to the catalogue never
 * silently grants it to anyone — including the administrator.
 *
 * security-implementation.md §5:
 *   administrator | Everything: members, benefits, reports, staff, exports | —
 *   manager       | Member list, member detail, reports | Edit benefits, manage staff, export
 *   outlet_staff  | Verification page only | Member list, search, reports, any member not just scanned
 *   support       | Single member by exact ID | Listing, browsing, exporting
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMINISTRATOR: [
    'members:create',
    'members:list',
    'members:read',
    'members:update',
    'members:suspend',
    'members:issue-claim',
    'benefits:read-all',
    'benefits:manage',
    'verify:resolve',
    'redemptions:record',
    'redemptions:list',
    'redemptions:reverse',
    'reports:read',
    'reports:export',
    'staff:manage',
  ],

  /**
   * TODO(open-question): the two authoritative documents describe this role at
   * different resolutions. security-implementation.md §5's "can reach" column
   * lists screens — "Member list, member detail, reports" — while its
   * "explicitly cannot" column names exactly three prohibitions: edit
   * benefits, manage staff, export. product-definition.md §7 says "Members and
   * reports; no benefit or staff configuration", where the Members section of
   * the dashboard (§7) includes creating and suspending.
   *
   * Implemented as: full member operations, reports, no benefits/staff/export.
   * That satisfies every explicit prohibition in both documents and matches
   * the Stage 12 acceptance test ("a manager account cannot reach benefit
   * editing or export"). Recorded in PROGRESS.md — if the intent was
   * read-only member access, remove the four write permissions here and
   * nothing else changes.
   */
  MANAGER: [
    'members:create',
    'members:list',
    'members:read',
    'members:update',
    'members:suspend',
    'members:issue-claim',
    'benefits:read-all',
    'redemptions:list',
    'reports:read',
  ],

  /**
   * "Verification page only." Deliberately holds no `members:list`,
   * `members:read`, `reports:*` or any other enumerating permission —
   * R11 requires the endpoint be absent for this role, not filtered.
   */
  OUTLET_STAFF: ['verify:resolve', 'redemptions:record'],

  /** "Single member by exact ID." No listing, browsing or exporting. */
  SUPPORT: ['members:read'],
};

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

export function isRoutePermission(value: unknown): value is RoutePermission {
  return value === 'public' || isPermission(value);
}

export function actorFor(permission: Permission): Actor {
  return PERMISSION_ACTORS[permission];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
