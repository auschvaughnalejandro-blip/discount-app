import type { PrismaClient } from '@prisma/client';

import {
  generateOutletLoginToken,
  hashOutletLoginToken,
} from '../src/security/outlet-login-token.js';

/**
 * Creates a real active TOKEN principal for tests that exercise outlet
 * authorization below the login exchange. Production seed deliberately creates
 * no phantom devices; each suite owns and removes the actor it needs.
 */
export async function createOutletDeviceFixture(
  prisma: PrismaClient,
  outletId: string,
  label: string,
) {
  const token = generateOutletLoginToken();
  return prisma.staffUser.create({
    data: {
      fullName: label,
      email: null,
      passwordHash: null,
      googleSubject: null,
      authMethod: 'TOKEN',
      role: 'OUTLET_STAFF',
      status: 'ACTIVE',
      outletId,
      outletTokenHash: hashOutletLoginToken(token),
      outletTokenIssuedAt: new Date(),
    },
  });
}
