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
    snippet: 'prisma.member.findUnique({ where: { phone: body.phone }',
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

function findUnscopedReads(): Finding[] {
  const findings: Finding[] = [];

  for (const file of sourceFiles(ROUTES_DIR)) {
    const relative = file.slice(file.lastIndexOf('routes') + 'routes'.length + 1);
    const source = readFileSync(file, 'utf8');
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
  }

  return findings;
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
