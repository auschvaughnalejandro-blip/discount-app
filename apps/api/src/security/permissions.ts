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
  /**
   * The card-print export: membership number, name and card code, for the
   * bureau that manufactures the physical cards.
   *
   * Separate from `reports:export` because the two disclose different things.
   * That one is deliberately a list of membership numbers and no names at all
   * (§12, asserted by `reporting.test.ts`); this one cannot be, because the
   * name is what gets printed on the card. Holding one must never imply the
   * other, and only a distinct permission can express that.
   */
  'members:export-cards',

  // Benefits
  'benefits:read-published',
  'benefits:read-all',
  'benefits:manage',

  // Benefit requests — a member announces, the outlet confirms. Nobody decides:
  // the guest is already entitled, so there is no approval permission any more.
  'requests:create',
  'requests:read',

  // The outlet surface. Narrow on purpose — an outlet account works its own
  // queue and resolves a card in front of it, and can do nothing else. Notably
  // absent: any form of member listing, which is what keeps a shared counter
  // credential from being a route to the membership list (§5).
  'outlet:queue',
  'outlet:fulfil',
  'outlet:resolve',

  // Redemption
  'redemptions:record',
  'redemptions:list',
  'redemptions:reverse',

  // Reporting
  'reports:read',
  'reports:export',

  // Outlets: their notification address and which token-backed devices may work them.
  // Separate from staff:manage because it is a different question — that one is
  // "who may reach the dashboard", this one is "which room may record a visit".
  'outlets:manage',

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
  'members:export-cards': 'STAFF',
  'benefits:read-published': 'MEMBER',
  'benefits:read-all': 'STAFF',
  'benefits:manage': 'STAFF',
  'requests:create': 'MEMBER',
  'requests:read': 'STAFF',
  'outlet:queue': 'STAFF',
  'outlet:fulfil': 'STAFF',
  'outlet:resolve': 'STAFF',
  'redemptions:record': 'STAFF',
  'redemptions:list': 'STAFF',
  'redemptions:reverse': 'STAFF',
  'reports:read': 'STAFF',
  'reports:export': 'STAFF',
  'outlets:manage': 'STAFF',
  'staff:manage': 'STAFF',
  'staff:self': 'STAFF',
  'member:self': 'MEMBER',
};

/**
 * Three surfaces: the member app, the administrator dashboard, and the outlet
 * screen. `MANAGER` and `SUPPORT` remain database enum values only so
 * historical rows can keep naming the account that performed an action; they
 * deliberately hold no permission and cannot authenticate.
 *
 * Permissions are stated exhaustively per role rather than by wildcard, so
 * adding one to the catalogue never silently grants it to anybody.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMINISTRATOR: [
    'members:create',
    'members:list',
    'members:read',
    'members:update',
    'members:suspend',
    'members:issue-claim',
    'members:export-cards',
    'benefits:read-all',
    'benefits:manage',
    'requests:read',
    'redemptions:record',
    'redemptions:list',
    'redemptions:reverse',
    'reports:read',
    'reports:export',
    'outlets:manage',
    'staff:manage',
    'staff:self',
  ],

  /**
   * An outlet account: a shared credential on a counter device.
   *
   * It reads its own outlet's notices, confirms or closes them, and resolves the
   * card a guest is holding. It cannot list members, read another outlet's work,
   * see any report, record a redemption outside its own outlet, reverse
   * anything, or reach account management.
   *
   * `redemptions:record` is **not** here even though confirming a notice writes
   * a redemption. The outlet routes call the recording logic directly with the
   * outlet fixed from the account, so granting the general permission would only
   * add a way to record against an outlet the account does not belong to.
   */
  OUTLET_STAFF: ['outlet:queue', 'outlet:fulfil', 'outlet:resolve'],

  // Historical enum values only. Fail closed if an old account or token ever
  // reaches authorization despite the login and principal checks.
  MANAGER: [],
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
