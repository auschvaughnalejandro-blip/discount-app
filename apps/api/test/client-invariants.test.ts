/**
 * Client-side invariants that must survive styling.
 *
 * This file was `no-styling.test.ts` for stages 0–14, where it also asserted
 * that no stylesheet, `className` or styling dependency existed anywhere —
 * BUILD-PLAN §0 rule 1, "ugly is correct at this stage".
 *
 * Those three assertions were retired deliberately at the start of Stage 16
 * (see ROADMAP.md §3 and DECISIONS.md), because rule 1 was a staging discipline
 * for the period when logic was being built and it has now served its purpose.
 * The QR quiet zone was what forced the issue: a scannable code needs a white
 * margin, and that is function rather than decoration.
 *
 * The two groups below were never about styling and are still load-bearing.
 * They are kept, and kept together, because a documented claim decays the
 * moment someone adds a "remember me" checkbox or a helpful default.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

const CLIENT_APPS = ['web-member', 'web-admin'];

function existingClients(): string[] {
  return CLIENT_APPS.map((name) => join(REPO_ROOT, 'apps', name)).filter((dir) => existsSync(dir));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') {
      return [];
    }
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : [full];
  });
}

describe('the client apps exist to be checked', () => {
  it('has at least one client app', () => {
    // Otherwise every test below passes by describing nothing.
    expect(existingClients().length).toBeGreaterThan(0);
  });
});

/**
 * Field names crossing the wire, which no typecheck can see.
 *
 * The server schemas are `.strict()`, so a request carrying a field the schema
 * does not name is a 400 — not a silently ignored extra. That is the right
 * behaviour and it makes a rename on one side a runtime break on the other,
 * invisible to `tsc` whenever both fields are strings.
 *
 * This is not hypothetical: `requestBenefit` sent `benefitId` for a while after
 * the endpoint moved to `benefitKey`, and every attempt to ask for a benefit
 * answered "Invalid request." The typecheck was clean throughout.
 */
describe('client request payloads use the field names the server accepts', () => {
  /**
   * `[client dir, the call, the field the server requires]`
   *
   * Only calls that hand-write their payload belong here. A call that forwards
   * a typed parameter (`body: input`) already has its field names checked by
   * `tsc` at every call site — `recordRedemption` is one of those, and adding
   * it would assert something the compiler proves better.
   */
  const CONTRACTS: [string, string, string][] = [['web-member', 'requestBenefit', 'benefitKey']];

  it.each(CONTRACTS)('%s %s sends %s', (clientDir, call, field) => {
    const api = join(REPO_ROOT, 'apps', clientDir, 'src', 'api.ts');
    if (!existsSync(api)) {
      return;
    }
    const source = readFileSync(api, 'utf8');
    const start = source.indexOf(`${call}:`);
    expect(start, `${call} not found in ${clientDir}/src/api.ts`).toBeGreaterThan(-1);

    // Only what is actually posted. Deliberately *not* the whole function: the
    // parameter is usually named after the field, so a wider window matches the
    // signature and passes while the body still sends the wrong key — which is
    // precisely how the original defect survived a check written in a hurry.
    const region = source.slice(start, start + 700);
    const bodyAt = region.indexOf('body:');
    expect(bodyAt, `${call} posts no body`).toBeGreaterThan(-1);

    const payload = region.slice(bodyAt, region.indexOf('}', bodyAt) + 1);
    expect(payload, `${call} posts ${payload.trim()}`).toContain(field);
  });
});

/**
 * R14, from the client side: the API refusing to hardcode a benefit value is no
 * use if the client quietly defaults one when a fetch fails. This is the
 * project's headline requirement — changing the F&B discount must be a form
 * field, not a deployment.
 */
describe('the member client hardcodes no benefit values', () => {
  it('contains no percentage, guest cap or reservation number', () => {
    const dir = join(REPO_ROOT, 'apps', 'web-member');
    if (!existsSync(dir)) {
      return;
    }

    const forbidden = ['4020 1720', '4020 1666', '4020 1625', 'F&B Outlets', 'Rooms & Suites'];

    const offenders = sourceFiles(dir)
      .filter((file) => /\.(tsx|ts)$/i.test(file))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return forbidden.some((needle) => source.includes(needle));
      });

    expect(offenders).toEqual([]);
  });
});

/**
 * security-implementation.md §4: "Never `localStorage` — any XSS flaw becomes
 * total account theft", and "No tokens in URLs. They reach logs, history and
 * referrer headers."
 *
 * Comments are stripped first: all three clients discuss `localStorage` in
 * comments explaining why they avoid it.
 */
describe('clients store no token where a script or a log can reach it', () => {
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\*.*$/gm, '')
      .replace(/\/\/.*$/gm, '');
  }

  it.each(CLIENT_APPS)('%s uses no web storage API', (name) => {
    const dir = join(REPO_ROOT, 'apps', name);
    if (!existsSync(dir)) {
      return;
    }

    const offenders = sourceFiles(dir)
      .filter((file) => /\.(ts|tsx)$/i.test(file))
      .filter((file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        return /localStorage|sessionStorage|document\.cookie/.test(code);
      });

    expect(offenders).toEqual([]);
  });

  it.each(CLIENT_APPS)('%s puts no token in a URL', (name) => {
    const dir = join(REPO_ROOT, 'apps', name);
    if (!existsSync(dir)) {
      return;
    }

    const offenders = sourceFiles(dir)
      .filter((file) => /\.(ts|tsx)$/i.test(file))
      .filter((file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        return /[?&](access_?token|token|jwt)=/i.test(code);
      });

    expect(offenders).toEqual([]);
  });
});

/**
 * A redemption's `occurredAt` is recorded to the millisecond and must be *read*
 * to the second. The clients all used to render it with `toLocaleDateString()`,
 * which keeps the day and throws the clock away — the record was right and the
 * screen was lossy.
 *
 * This decays silently in two ways, neither of which looks like a bug: someone
 * reaches for `toLocaleDateString()` again out of habit, or softens the shared
 * formatter to `timeStyle: 'short'`, which drops seconds while still plainly
 * showing a time. In both cases every screen still renders. The cost only
 * appears months later, when two entries on the same day cannot be told apart
 * and there is nothing left to reconstruct the order from.
 */
describe('a redemption is shown at the second it was recorded', () => {
  const formatter = join(REPO_ROOT, 'packages', 'ui', 'src', 'format.ts');

  it('formats timestamps with seconds, not to the nearest minute', () => {
    if (!existsSync(formatter)) {
      return;
    }
    const source = readFileSync(formatter, 'utf8');
    // 'medium' is the shortest style carrying seconds; 'short' silently omits them.
    expect(source).toMatch(/timeStyle:\s*'medium'/);
    expect(source).not.toMatch(/timeStyle:\s*'short'/);
  });

  it.each(CLIENT_APPS)('%s renders no date without its time', (name) => {
    const dir = join(REPO_ROOT, 'apps', name);
    if (!existsSync(dir)) {
      return;
    }

    // `toLocaleDateString` is date-only by construction. `toLocaleString` on a
    // date stops at the minute — but on a *number* it is the correct way to
    // group thousands, which is what the charts use it for, so it is only an
    // offence when the receiver is a date.
    //
    // Both are replaced by the shared formatter, whose `formatDate` marks a
    // day-only value as a deliberate choice rather than an accident of which
    // method came to hand.
    const dateOnly = /toLocaleDateString\(/;
    const dateToMinute = /new Date\([^)]*\)\s*\.toLocaleString\(/;

    const offenders = sourceFiles(dir)
      .filter((file) => /\.(ts|tsx)$/i.test(file))
      .filter((file) => {
        const code = readFileSync(file, 'utf8');
        return dateOnly.test(code) || dateToMinute.test(code);
      });

    expect(offenders).toEqual([]);
  });
});

/**
 * Stage 16. The credential is only useful if a camera can read it, and the two
 * ways to break that silently are removing the quiet zone (the library renders
 * modules edge to edge, so the margin is ours to supply) and dropping the error
 * correction level back to the library default of "L".
 *
 * Neither failure is visible by looking at the screen — the QR still renders,
 * it just stops scanning reliably on a phone held at arm's length. Hence a test.
 */
describe('the guest QR is gone and does not come back', () => {
  /**
   * The client verifies a member by typing their PG number. There is no scanned
   * credential anywhere in the guest-facing path, and reintroducing one is a
   * product decision rather than an implementation detail — so it fails here
   * rather than arriving quietly with a dependency bump.
   *
   * `web-admin` is deliberately absent from this list: it renders an
   * `otpauth://` QR for staff authenticator enrollment, which is a different
   * mechanism entirely and load-bearing for MFA.
   */
  const guestSurfaces = ['web-member'] as const;

  it.each(guestSurfaces)('%s declares no QR or barcode dependency', (surface) => {
    const manifest = join(REPO_ROOT, 'apps', surface, 'package.json');
    if (!existsSync(manifest)) {
      return;
    }
    const deps = Object.keys(
      (JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> })
        .dependencies ?? {},
    );
    expect(deps.filter((name) => /qr|zxing|barcode/i.test(name))).toEqual([]);
  });

  it.each(guestSurfaces)('%s renders no QR and opens no camera', (surface) => {
    const dir = join(REPO_ROOT, 'apps', surface, 'src');
    if (!existsSync(dir)) {
      return;
    }
    const pending = [dir];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      for (const file of readdirSync(current)) {
        const path = join(current, file);
        if (statSync(path).isDirectory()) {
          pending.push(path);
          continue;
        }
        const source = readFileSync(path, 'utf8');
        expect(source).not.toMatch(/QRCode|react-qr-code|zxing|getUserMedia|BarcodeDetector/i);
      }
    }
  });

  it('no longer exposes an identity-code endpoint', () => {
    const routes = join(REPO_ROOT, 'apps', 'api', 'src', 'routes');
    for (const file of readdirSync(routes)) {
      expect(readFileSync(join(routes, file), 'utf8')).not.toMatch(/identity-code/);
    }
  });
});

/**
 * Stage 23. The member app is installable, which means a service worker sits
 * between it and the API — and the thing that must never be cached is the state
 * of a benefit request.
 *
 * A stale "approved" sends a member to a counter expecting a discount that was
 * declined an hour ago, and nothing on screen explains why. The failure is
 * invisible in development because the service worker is disabled there, so it
 * is asserted against the Vite config rather than discovered at a spa desk.
 */
describe('the installable member app never caches an approval', () => {
  const viteConfig = join(REPO_ROOT, 'apps', 'web-member', 'vite.config.ts');

  it('serves request state from the network only', () => {
    if (!existsSync(viteConfig)) {
      return;
    }
    const source = readFileSync(viteConfig, 'utf8');
    const rule = /requests\$\/,\s*handler:\s*'NetworkOnly'/;
    expect(rule.test(source)).toBe(true);
  });

  it('serves auth from the network only', () => {
    if (!existsSync(viteConfig)) {
      return;
    }
    const source = readFileSync(viteConfig, 'utf8');
    expect(source).toMatch(/api\\\/auth\\\/.*handler:\s*'NetworkOnly'/s);
  });

  it('lets a benefit change reach members without a deployment (R14)', () => {
    // NetworkFirst, never CacheFirst: an administrator changing a percentage
    // must not be overridden by a stale cache. The offline copy is a fallback.
    if (!existsSync(viteConfig)) {
      return;
    }
    const source = readFileSync(viteConfig, 'utf8');
    expect(source).toMatch(/benefits\$\/,\s*handler:\s*'NetworkFirst'/);
    expect(source).not.toMatch(/benefits\$\/,\s*handler:\s*'CacheFirst'/);
  });

  it('does not enable the service worker in development', () => {
    // A service worker caching a dev bundle is the most confusing class of
    // "my change didn't apply" bug there is.
    if (!existsSync(viteConfig)) {
      return;
    }
    expect(readFileSync(viteConfig, 'utf8')).toMatch(/devOptions:\s*\{[^}]*enabled:\s*false/s);
  });
});

/**
 * Deployment settings that are silent when wrong.
 *
 * Both of these were set in `.env.example`, set in `docker-compose.prod.yml`,
 * documented as mandatory in DEPLOYMENT.md — and had no effect whatsoever,
 * because nothing read them. Neither failure is visible on localhost, and
 * neither produces an error in production: the app comes up, serves traffic,
 * and quietly does the wrong thing.
 */
describe('the deployment configuration is actually wired up', () => {
  it('reads TRUST_PROXY and hands it to Fastify', () => {
    const env = readFileSync(join(REPO_ROOT, 'apps', 'api', 'src', 'config', 'env.ts'), 'utf8');
    expect(env).toMatch(/TRUST_PROXY/);

    // Set but not passed is the same as not set at all: every per-IP rate limit
    // shares one bucket and every audited address is the proxy's.
    const app = readFileSync(join(REPO_ROOT, 'apps', 'api', 'src', 'app.ts'), 'utf8');
    expect(app).toMatch(/trustProxy:\s*env\.TRUST_PROXY/);
  });

  it('proxies /api on every hostname that serves a client', () => {
    const caddyfile = join(REPO_ROOT, 'docker', 'caddy', 'Caddyfile');
    if (!existsSync(caddyfile)) {
      return;
    }
    const source = readFileSync(caddyfile, 'utf8');

    // Both clients call a relative /api path. A hostname that serves a client
    // without proxying it answers every API call with index.html — the app
    // loads and then silently fails.
    expect(source).toMatch(/\(api_proxy\)/);
    for (const host of ['my', 'admin']) {
      const block = source.slice(source.indexOf(`${host}.{$DOMAIN} {`));
      expect(block.slice(0, block.indexOf('\n}')), `${host} host`).toMatch(/import api_proxy/);
    }
  });

  it('restricts /api/admin/* wherever the API is proxied', () => {
    const caddyfile = join(REPO_ROOT, 'docker', 'caddy', 'Caddyfile');
    if (!existsSync(caddyfile)) {
      return;
    }
    const source = readFileSync(caddyfile, 'utf8');

    // Otherwise the member app's own public hostname proxies the admin routes,
    // and the IP restriction on admin.<domain> is one URL away from useless.
    const snippet = source.slice(source.indexOf('(api_proxy)'));
    const body = snippet.slice(0, snippet.indexOf('\n}\n'));
    expect(body).toMatch(/path \/api\/admin\/\*/);
    expect(body).toMatch(/not remote_ip \{\$INTERNAL_CIDR\}/);
  });
});

describe('the member can initiate the benefit workflow', () => {
  it('renders the request action and wires it to the request API', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps', 'web-member', 'src', 'screens', 'OfferDetail.tsx'),
      'utf8',
    );

    expect(source).toContain('api.requestBenefit');
    expect(source).toContain('Request this benefit');
    expect(source).toContain("currentRequest?.status === 'PENDING'");
    expect(source).toContain("currentRequest?.status === 'APPROVED'");
    expect(source).toContain("currentRequest?.status === 'DECLINED'");
    expect(source).toContain("currentRequest?.status === 'FULFILLED'");
  });
});

/**
 * The seed creates an administrator whose password is a constant in the
 * repository. DEPLOYMENT.md says seeding is for development; this makes that a
 * control rather than a sentence, because running the wrong npm script against
 * the wrong DATABASE_URL is an ordinary end-of-deployment mistake and the
 * failure would be silent — a live administrator account with a publicly known
 * password, and nothing on any screen to say so.
 */
describe('the seed cannot be run against production by accident', () => {
  it('refuses when NODE_ENV is production', () => {
    const seed = readFileSync(join(REPO_ROOT, 'apps', 'api', 'prisma', 'seed.ts'), 'utf8');
    expect(seed).toMatch(/NODE_ENV'\]\s*===\s*'production'/);
    expect(seed).toMatch(/Refusing to seed/);
  });

  it('still ships a development-only password, which is why the guard matters', () => {
    // If this constant ever disappears the guard may no longer be needed — but
    // it is here today, and the two facts belong together.
    const seed = readFileSync(join(REPO_ROOT, 'apps', 'api', 'prisma', 'seed.ts'), 'utf8');
    expect(seed).toMatch(/DEV_PASSWORD/);
  });
});
