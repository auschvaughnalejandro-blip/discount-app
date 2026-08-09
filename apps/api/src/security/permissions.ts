import type { Role } from '@prisma/client';

/**
 * The permission catalogue and the administrator permission matrix.
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

  // Benefit requests — a member asks, a person decides, an outlet fulfils
  'requests:create',
  'requests:read',
  'requests:decide',

  // Redemption
  'redemptions:record',
  'redemptions:list',
  'redemptions:reverse',

  // Reporting
  'reports:read',
  'reports:export',

  // Staff administration
  'staff:manage',
  // A staff member acting on their own account — changing their own password.
  // Separate from staff:manage so holding it grants nothing over anyone else.
  'staff:self',

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
  'requests:create': 'MEMBER',
  'requests:read': 'STAFF',
  'requests:decide': 'STAFF',
  'redemptions:record': 'STAFF',
  'redemptions:list': 'STAFF',
  'redemptions:reverse': 'STAFF',
  'reports:read': 'STAFF',
  'reports:export': 'STAFF',
  'staff:manage': 'STAFF',
  'staff:self': 'STAFF',
  'member:self': 'MEMBER',
};

/**
 * The product now has two surfaces: the administrator dashboard and the
 * member app. `MANAGER`, `OUTLET_STAFF` and `SUPPORT` remain database enum
 * values only so historical rows can keep naming the account that performed
 * an action. They deliberately hold no permission and cannot authenticate.
 *
 * Administrator permissions are stated exhaustively rather than by wildcard,
 * so adding a permission to the catalogue never silently grants it.
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
    'requests:read',
    'requests:decide',
    'redemptions:record',
    'redemptions:list',
    'redemptions:reverse',
    'reports:read',
    'reports:export',
    'staff:manage',
    'staff:self',
  ],

  // Historical enum values only. Fail closed if an old account or token ever
  // reaches authorization despite the login and principal checks.
  MANAGER: [],
  OUTLET_STAFF: [],
  SUPPORT: [],
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
