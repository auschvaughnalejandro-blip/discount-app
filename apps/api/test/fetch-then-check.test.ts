/**
 * Stage 3 acceptance, criterion 4:
 *   "No handler loads a record and then checks permission afterwards —
 *    scope is in the query."
 *
 * That is a property of the source, not of a running server, so it is checked
 * by reading src/routes. The guard is deliberately structural rather than
 * clever: any Prisma read of a scoped model inside a route file must have a
 * `scopeFor…` call in the same statement, or be explicitly exempted below
 * with a reason.
 *
 * At Stage 3 there are no such reads yet — the value of this test is from
 * Stage 4 onward, when member and redemption endpoints arrive. It is written
 * now because the mistake it prevents is one you make while writing those
 * endpoints, not one you go looking for afterwards.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROUTES_DIR = resolve(import.meta.dirname, '..', 'src', 'routes');

/** Models whose rows belong to, or are visible to, only some principals. */
const SCOPED_MODELS = ['member', 'redemption', 'consentRecord', 'claimCode'] as const;

const READ_METHODS = ['findFirst', 'findMany', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow'];

/**
 * Reads that are legitimately unscoped, each with the reason it is safe.
 * Anything not listed here must carry a scope fragment.
 */
const EXEMPT: { file: string; snippet: string; reason: string }[] = [
  {
    file: 'auth.ts',
    // `{ phone }` since the number is normalised into a local before the
    // lookup — 55550003 and +97455550003 must find the same member.
    snippet: 'prisma.member.findUnique({ where: { phone }',
    reason:
      'Pre-authentication OTP lookup (request-otp and verify-otp). There is no principal yet, so ' +
      'there is nothing to scope to — establishing who the caller is IS the purpose of the call. ' +
      'The record never reaches the response: request-otp answers identically whether or not the ' +
      'number is registered, and verify-otp only proceeds on a correct code ' +
      '(security-implementation.md §3, account enumeration).',
  },
  {
    file: 'auth.ts',
    snippet: 'prisma.member.findUnique({ where: { id: identity.subjectId }',
    reason:
      'Refresh: the subject id comes from the presented refresh token, which was already matched ' +
      'against its stored hash. The lookup is scoped to that subject by construction — possession ' +
      'of the token is the authorization, and the record never reaches the response.',
  },
  {
    file: 'member.ts',
    snippet: 'prisma.claimCode.findUnique({ where: { codeHash: hashClaimCode(body.claimCode) }',
    reason:
      'Activation, pre-authentication. Possession of the claim code IS the authorization being ' +
      'established, so there is no principal to scope to — scoping here would be circular. The ' +
      'row never reaches the response: every failure path returns the same generic invalid_claim ' +
      'response, so an unknown, expired, used or wrong-phone code are indistinguishable ' +
      '(security-implementation.md §3).',
  },
  {
    file: 'member.ts',
    snippet: 'prisma.member.findUnique({ where: { phone: body.phone }',
    reason:
      'Activation, pre-authentication: checks whether the phone number the member typed is already ' +
      'bound to a different membership. Selects only the id, compares it, and discards it — the ' +
      'result reaches the response only as the same generic invalid_claim used for every other ' +
      'failure, so it discloses nothing about who holds that number.',
  },
  {
    file: 'verify.ts',
    snippet: 'prisma.member.findUnique({ where: { id: memberId }',
    reason:
      'POST /verify/resolve, by scanned payload. scopeForMember returns MATCHES_NOTHING for ' +
      'outlet_staff by design (R11 — no member is reachable by browsing), so applying it here ' +
      'would make the verification page unable to do the one thing it exists for. The ' +
      'authorization is what §5 specifies for this endpoint instead: a valid, in-window HMAC ' +
      'signature over the member reference, the verify:resolve permission, and a hard per-staff ' +
      'rate limit. Both outcomes are audit-logged.',
  },
  {
    file: 'verify.ts',
    snippet: "prisma.member.findUnique({ where: { memberNumber: body.membershipNumber ?? '' }",
    reason:
      'POST /verify/resolve, by exact membership number — the printed-card path (wireframes ' +
      'screen 9 note 2). Same reasoning as the payload lookup above. Exact equality only: no ' +
      'contains, startsWith or case-insensitive match, any of which would turn this into the ' +
      'search endpoint R11 forbids. Rate limited hard because the numbers are sequential, and ' +
      'failures are logged as probing.',
  },
  {
    file: 'verify.ts',
    snippet: 'prisma.member.findUnique({ where: { id: body.memberId }',
    reason:
      'POST /verify/redemptions. Reached only after verifyVerificationSession confirms an ' +
      'unexpired HMAC binding this staff account to this member id, issued by /verify/resolve ' +
      'minutes earlier — which is the "short-lived verification session" §5 requires. The scope ' +
      'is that binding; scopeForMember would again resolve nothing for outlet_staff.',
  },
  {
    file: 'verify.ts',
    snippet: 'prisma.redemption.findUnique({ where: { reversesId: original.id }',
    reason:
      'Reversal. `original` was already fetched through scopeForRedemption, so this asks only ' +
      'whether a reversal exists for a row the caller may already see, and selects nothing but ' +
      'its id.',
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

interface Finding {
  file: string;
  line: number;
  statement: string;
}

/**
 * How far back to look for the assignment of a hoisted `where` variable.
 * Deliberately short: a scope fragment defined far from the query it guards
 * is hard to review, and the guard should not bless that.
 */
const ASSIGNMENT_LOOKBEHIND = 25;

/**
 * A query may pass its `where` as a variable rather than inline — the list
 * endpoint builds one and shares it between `count` and `findMany`. Resolve
 * that identifier back to its assignment and check *that* for a scope.
 *
 * Returns true only when the assignment is found and is scoped; an unresolved
 * identifier counts as unscoped, so the fail-closed default is preserved.
 */
function whereVariableIsScoped(lines: string[], callStart: number, call: string): boolean {
  // `where,` / `where }` (shorthand), or `where: someIdentifier`.
  const shorthand = /\bwhere\s*[,}]/.test(call);
  const named = /\bwhere\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(call);

  const identifier = named?.[1] ?? (shorthand ? 'where' : undefined);
  if (!identifier) {
    return false;
  }

  const from = Math.max(0, callStart - ASSIGNMENT_LOOKBEHIND);
  const preceding = lines.slice(from, callStart);

  const assignment = new RegExp(`\\b(?:const|let)\\s+${identifier}\\b`);
  for (const [offset, candidate] of preceding.entries()) {
    if (!assignment.test(candidate)) {
      continue;
    }
    // The assignment may itself wrap over several lines — `scopedWhere` with
    // an inline filter object runs to about ten.
    const body = preceding.slice(offset, offset + 12).join('\n');
    if (body.includes('scopeFor')) {
      return true;
    }
  }

  return false;
}

/** The analyzer, over one file's text. Separated so it can be tested itself. */
function scanSource(relative: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const model of SCOPED_MODELS) {
      for (const method of READ_METHODS) {
        const pattern = `prisma.${model}.${method}`;
        if (!line.includes(pattern)) {
          continue;
        }

        // Look at the whole call, which may wrap across several lines.
        const statement = lines.slice(index, index + 8).join('\n');
        const callEnd = statement.indexOf('});');
        const call = callEnd === -1 ? statement : statement.slice(0, callEnd);

        if (call.includes('scopeFor')) {
          continue;
        }

        if (whereVariableIsScoped(lines, index, call)) {
          continue;
        }

        const exempt = EXEMPT.some(
          (entry) =>
            relative.endsWith(entry.file) &&
            call.replace(/\s+/g, ' ').includes(entry.snippet.replace(/\s+/g, ' ')),
        );
        if (exempt) {
          continue;
        }

        findings.push({ file: relative, line: index + 1, statement: call.trim() });
      }
    }
  }

  return findings;
}

function findUnscopedReads(): Finding[] {
  return sourceFiles(ROUTES_DIR).flatMap((file) =>
    scanSource(file.slice(file.lastIndexOf('routes') + 'routes'.length + 1), readFileSync(file, 'utf8')),
  );
}

describe('no handler fetches a scoped record and checks permission afterwards', () => {
  it('finds every Prisma read of a scoped model carrying a scope fragment', () => {
    const findings = findUnscopedReads();

    const report = findings
      .map((f) => `  ${f.file}:${f.line}\n${f.statement.replace(/^/gm, '      ')}`)
      .join('\n\n');

    expect(
      findings,
      findings.length === 0
        ? ''
        : `Unscoped read of a scoped model in a route handler.\n\n${report}\n\n` +
            `Put the scope in the WHERE clause:\n` +
            `  where: { id: req.params.id, ...scopeForMember(principal) }\n` +
            `then 404 on a miss. Loading first and checking after leaks the record's ` +
            `existence through timing, errors and logs (security-implementation.md §5).\n` +
            `If the read is genuinely unscoped, add it to EXEMPT with a reason.`,
    ).toEqual([]);
  });

  it('scans the route files that actually exist', () => {
    // Guards against the check silently passing because the directory moved.
    const files = sourceFiles(ROUTES_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('auth.ts'))).toBe(true);
  });
});

/**
 * The analyzer accepts a `where` passed as a variable, which is a real
 * pattern (the member list shares one between `count` and `findMany`) but
 * also the obvious way for the check to become a no-op. These fix what it
 * must still catch.
 */
describe('the guard itself still detects what it is for', () => {
  it('flags a plain unscoped read', () => {
    const findings = scanSource(
      'synthetic.ts',
      `const m = await app.prisma.member.findFirst({ where: { id: req.params.id } });`,
    );

    expect(findings).toHaveLength(1);
  });

  it('flags the fetch-then-check pattern §5 warns about', () => {
    const findings = scanSource(
      'synthetic.ts',
      [
        `const m = await app.prisma.member.findUnique({ where: { id: req.params.id } });`,
        `if (!can(principal, m)) { throw new ForbiddenError(); }`,
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
  });

  it('flags a read whose where variable was built without a scope', () => {
    const findings = scanSource(
      'synthetic.ts',
      [
        `const where = { id: req.params.id };`,
        `const m = await app.prisma.member.findFirst({ where });`,
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
  });

  it('flags a read with no where clause at all', () => {
    const findings = scanSource('synthetic.ts', `const all = await app.prisma.member.findMany();`);

    expect(findings).toHaveLength(1);
  });

  it('accepts an inline scope fragment', () => {
    const findings = scanSource(
      'synthetic.ts',
      `const m = await app.prisma.member.findFirst({
         where: scopedWhere({ id: req.params.id }, scopeForMember(principal)),
       });`,
    );

    expect(findings).toEqual([]);
  });

  it('accepts a where variable that was built with a scope', () => {
    const findings = scanSource(
      'synthetic.ts',
      [
        `const where = scopedWhere(filters, scopeForMember(principal));`,
        `const m = await app.prisma.member.findMany({ where, take: 10 });`,
      ].join('\n'),
    );

    expect(findings).toEqual([]);
  });

  it('does not accept a scope assigned to a different variable', () => {
    const findings = scanSource(
      'synthetic.ts',
      [
        `const scoped = scopedWhere({}, scopeForMember(principal));`,
        `const where = { id: req.params.id };`,
        `const m = await app.prisma.member.findFirst({ where });`,
      ].join('\n'),
    );

    expect(findings).toHaveLength(1);
  });

  it('does not look past the lookbehind window for the assignment', () => {
    const findings = scanSource(
      'synthetic.ts',
      [
        `const where = scopedWhere(filters, scopeForMember(principal));`,
        ...Array.from({ length: ASSIGNMENT_LOOKBEHIND + 5 }, () => '// filler'),
        `const m = await app.prisma.member.findMany({ where });`,
      ].join('\n'),
    );

    // A scope fragment defined far from the query it guards is hard to
    // review, so the guard declines to bless it rather than searching further.
    expect(findings).toHaveLength(1);
  });
});
