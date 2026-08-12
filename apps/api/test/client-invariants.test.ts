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

const CLIENT_APPS = ['web-member', 'web-admin', 'web-outlet'];

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
 * This is not hypothetical: the announce call sent `benefitId` for a while after
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
  const CONTRACTS: [string, string, string][] = [
    ['web-member', 'announceVisit', 'benefitKey'],
    ['web-outlet', 'confirm', 'idempotencyKey'],
  ];

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
 * Every client refreshes through one shared promise, never a bare `fetch`.
 *
 * ## The defect this exists to prevent recurring
 *
 * Refresh tokens rotate single-use, and presenting a spent one revokes the whole
 * family (security-implementation.md §4) — correctly, because from the server it
 * is indistinguishable from a stolen token being replayed.
 *
 * That makes *concurrency* the hazard. A screen that opens with `Promise.all`
 * sees every request come back 401 together the moment its access token expires,
 * and a client that refreshes per-request then rotates the same cookie N times in
 * parallel. One wins; the rest are read as replay; the family dies, including the
 * winner's fresh token. The admin dashboard did exactly this and lost its session
 * ten minutes after every sign-in, reporting "Authentication required." — a
 * twelve-hour refresh token thrown away by a ten-minute access token.
 *
 * A single in-flight promise is the fix, and it is invisible to `tsc`: a second
 * `fetch('/auth/refresh')` added anywhere compiles perfectly and reintroduces the
 * bug. Hence a static check.
 */
describe('clients rotate the refresh token one call at a time', () => {
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\*.*$/gm, '')
      .replace(/\/\/.*$/gm, '');
  }

  /** Every client that holds a session. */
  const SESSION_CLIENTS = CLIENT_APPS;

  it.each(SESSION_CLIENTS)('%s funnels every refresh through one promise', (name) => {
    const api = join(REPO_ROOT, 'apps', name, 'src', 'api.ts');
    if (!existsSync(api)) {
      return;
    }
    const code = stripComments(readFileSync(api, 'utf8'));

    // The guard itself: a module-level promise, returned while one is in flight.
    expect(code, `${name}/src/api.ts holds no in-flight refresh promise`).toMatch(
      /refreshPromise\s*(:|=)/,
    );
    expect(code, `${name} does not return the in-flight refresh to a second caller`).toMatch(
      /if\s*\(\s*refreshPromise\s*!==\s*null\s*\)/,
    );
  });

  it.each(SESSION_CLIENTS)('%s calls /auth/refresh from exactly one place', (name) => {
    const dir = join(REPO_ROOT, 'apps', name);
    if (!existsSync(dir)) {
      return;
    }

    // Counted across the whole client, not just api.ts: a screen that "helpfully"
    // refreshes on mount races the funnel just as effectively as a second copy
    // inside the client would.
    const sites = sourceFiles(dir)
      .filter((file) => /\.(ts|tsx)$/i.test(file))
      .flatMap((file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        const matches = code.match(/['"`][^'"`]*\/auth\/refresh/g) ?? [];
        return matches.map(() => file.slice(REPO_ROOT.length + 1));
      });

    expect(sites, `${name} rotates the refresh cookie from ${sites.length} places`).toHaveLength(1);
  });
});

/**
 * An outlet email is notification metadata, not an identity. The live product
 * has exactly one outlet-login path: a labelled device exchanges its `pgo_`
 * credential. These checks are intentionally static as well as route-tested;
 * an unused-looking OAuth button, helper script or env key is enough to tell an
 * operator there is a second supported path when there is not.
 */
describe('outlet authentication is device-token-only', () => {
  const retiredSettings = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'GOOGLE_WORKSPACE_DOMAIN',
    'OUTLET_ACCOUNTS',
    'OUTLET_SIGNIN_ALLOWLIST',
  ];

  it('exposes one sign-in form and one exchange call in the outlet client', () => {
    const dir = join(REPO_ROOT, 'apps', 'web-outlet', 'src');
    const source = sourceFiles(dir)
      .filter((file) => /\.(ts|tsx)$/i.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).toContain('/outlet/auth/token');
    expect(source).toContain('pgo_');
    expect(source).not.toMatch(
      /\/outlet\/auth\/(?:start|callback|google)|startSignIn|completeSignIn|Google sign-in|Development sign-in|adoptDevelopmentSession|outlet:dev-session/i,
    );
  });

  it('offers no Google outlet-account controls in the admin client', () => {
    const dir = join(REPO_ROOT, 'apps', 'web-admin', 'src');
    const source = sourceFiles(dir)
      .filter((file) => /\.(ts|tsx)$/i.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).toContain('Outlet email');
    expect(source).toMatch(/notices only[\s\S]{0,100}cannot sign in/i);
    expect(source).toMatch(/\/admin\/outlets\/\$\{encodeURIComponent\(outletId\)\}\/devices/);
    expect(source).not.toMatch(
      /Optional Google sign-in|Google outlet account|createGoogle|suspendGoogle/i,
    );
  });

  it('ships no compatibility provisioner or development session minter', () => {
    for (const script of ['outlet-accounts.ts', 'outlet-token.ts']) {
      expect(existsSync(join(REPO_ROOT, 'apps', 'api', 'scripts', script)), script).toBe(false);
    }

    for (const manifest of ['package.json', join('apps', 'api', 'package.json')]) {
      const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8')) as {
        scripts?: Record<string, string>;
      }).scripts;
      expect(scripts).not.toHaveProperty('outlet:accounts');
      expect(scripts).not.toHaveProperty('outlet:dev-session');
    }
  });

  it('has no outlet OAuth route or runtime configuration', () => {
    const route = readFileSync(
      join(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'outlet.ts'),
      'utf8',
    );
    expect(route).not.toMatch(
      /\/outlet\/auth\/(?:start|callback|google)|google-oidc|GOOGLE_OAUTH/i,
    );

    const runtimeConfig = [
      join(REPO_ROOT, 'apps', 'api', 'src', 'config', 'env.ts'),
      join(REPO_ROOT, '.env.example'),
      join(REPO_ROOT, 'docker-compose.prod.yml'),
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const setting of retiredSettings) {
      expect(runtimeConfig, `${setting} remains wired`).not.toContain(setting);
    }
  });
});

/**
 * A counter lookup is an irreversible-action handoff: the number typed above
 * must not be confused with the member whose redemption button is below. Keep
 * both the neutral prompt and the resolved membership number visible in the
 * action itself, even if the surrounding layout is redesigned.
 */
describe('outlet lookup makes the recording subject explicit', () => {
  const source = readFileSync(
    join(REPO_ROOT, 'apps', 'web-outlet', 'src', 'App.tsx'),
    'utf8',
  );

  it('does not suggest a real-looking membership number in the empty field', () => {
    expect(source).toContain('placeholder="Enter number from card"');
    expect(source).not.toMatch(/placeholder=["']PG-\d+/);
  });

  it('clears a resolved guest when the typed number changes', () => {
    expect(source).toMatch(
      /onChange=\{\(event\) => \{[\s\S]*?lookupAttempt\.current \+= 1;[\s\S]*?setResolved\(null\);[\s\S]*?\}\}/,
    );
  });

  it('names the resolved membership number on every recording state', () => {
    expect(source).toContain('memberNumber={resolved.member.memberNumber}');
    expect(source).toContain('`Record discount for ${memberNumber}`');
    expect(source).toContain('`Recording for ${memberNumber}…`');
    expect(source).toContain('`Recorded for ${memberNumber}`');
  });
});

/**
 * A visit recorded at the counter has to reach the member's own screen.
 *
 * This is the one value in the member app that changes through somebody else's
 * action. Staff record the redemption on the outlet device; the member is
 * standing there holding a phone whose history was fetched at sign-in and is now
 * wrong. Nothing pushes to that phone, so unless the app re-reads the history
 * the visit is invisible until the member signs out and back in — which reads,
 * exactly and reasonably, as the redemption never having been recorded.
 *
 * It went unnoticed the first time because the write path was fine and the admin
 * panel showed the row: the only broken thing was the member's copy of it. So
 * these lock the three links in the chain, each of which fails silently and none
 * of which a typecheck can see.
 */
describe('a visit recorded by an outlet reaches the member', () => {
  const memberSrc = join(REPO_ROOT, 'apps', 'web-member', 'src');
  const session = readFileSync(join(memberSrc, 'session.tsx'), 'utf8');
  const profile = readFileSync(join(memberSrc, 'screens', 'Profile.tsx'), 'utf8');
  const client = readFileSync(join(memberSrc, 'api.ts'), 'utf8');

  it('re-reads the history, not only the offers, when the app returns', () => {
    // The regression this replaces: the foreground handler called
    // `refreshBenefits` alone, so returning to the app picked up an
    // administrator's rate change and never an outlet's redemption.
    expect(session).toMatch(/refreshActivity/);
    expect(session).toMatch(
      /const refreshAll = \(\) => \{[\s\S]*?refreshBenefits\(\);[\s\S]*?refreshActivity\(\);[\s\S]*?\}/,
    );
    expect(session).toMatch(/addEventListener\('visibilitychange', refreshWhenVisible\)/);
    expect(session).toMatch(/addEventListener\('online', refreshAll\)/);
  });

  it('re-reads the history whenever the profile screen opens', () => {
    // Every figure on that screen is derived from the history, so the screen
    // that answers "did that get recorded?" must not answer from sign-in state.
    expect(profile).toMatch(/useEffect\(\(\) => \{\s*void refreshActivity\(\);\s*\}, \[refreshActivity\]\)/);
  });

  it('asks past the service worker when it refreshes', () => {
    // A NetworkFirst cache holds the previous history for a day. The query
    // string is what misses the cache rule, so both halves have to agree.
    expect(client).toMatch(/redemptions\?refresh=\$\{Date\.now\(\)\}/);

    const viteConfig = readFileSync(
      join(REPO_ROOT, 'apps', 'web-member', 'vite.config.ts'),
      'utf8',
    );
    // Anchored: a URL with a search string must not match, or the refresh is
    // served from the cache it was written to bypass.
    expect(viteConfig).toMatch(/member\\\/me\(\\\/redemptions\)\?\$\//);
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
 * The card code is only useful if a camera can read it, and the two ways to break
 * that silently are removing the quiet zone (the library renders modules edge to
 * edge, so the margin is ours to supply) and dropping the error correction level
 * back to the library default of "L".
 *
 * Neither failure is visible by looking at the screen — the QR still renders, it
 * just stops scanning reliably on a phone held at arm's length. Hence a test.
 *
 * ## Note for whoever reads this next
 *
 * An earlier version of this block asserted the opposite: that no QR existed
 * anywhere in the guest path, because the client had answered PROGRESS.md's Q1
 * with "there is no QR" and the whole mechanism was deleted. That answer was
 * reversed on 2026-08-12 — the printed card carries a code on its back and staff
 * scan it. The assertions below are the ones the original Stage 16 wrote, restored
 * along with the feature.
 */
describe('the card QR stays scannable', () => {
  const surfaces = ['web-member', 'web-outlet'] as const;

  function memberSources(): string[] {
    const dir = join(REPO_ROOT, 'apps', 'web-member', 'src');
    return existsSync(dir) ? sourceFiles(dir).filter((file) => /\.tsx?$/i.test(file)) : [];
  }

  it('renders the member card at error correction level M, not the library default', () => {
    const rendering = memberSources().filter((file) =>
      /<QRCode/.test(readFileSync(file, 'utf8')),
    );
    expect(rendering.length, 'no component renders a QR').toBeGreaterThan(0);

    for (const file of rendering) {
      const source = readFileSync(file, 'utf8');
      // "H" is the tempting choice and the wrong one: ~30% more modules means
      // each one is smaller on a phone screen, which makes it *harder* to scan.
      // H earns its keep on printed labels that get dirty, not on a backlit
      // display held 20cm from a camera.
      expect(source, `${file} must set level="M"`).toMatch(/level=(["'])M\1/);
    }
  });

  it('keeps a quiet zone around the code', () => {
    const rendering = memberSources().filter((file) =>
      /<QRCode/.test(readFileSync(file, 'utf8')),
    );

    for (const file of rendering) {
      const source = readFileSync(file, 'utf8');
      // The margin is ours to supply, and cropping it to save a few pixels is the
      // classic silent break: scanners need the light border to find the symbol.
      expect(source, `${file} must keep a quiet zone`).toMatch(/qr-quiet-zone|padding/);
    }
  });

  it('never renders the code on a tinted background', () => {
    const dir = join(REPO_ROOT, 'apps', 'web-member', 'src');
    if (!existsSync(dir)) return;

    const css = sourceFiles(dir)
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    const block = /\.qr-quiet-zone\s*\{[^}]*\}/.exec(css);
    expect(block, 'no .qr-quiet-zone rule found').not.toBeNull();
    // Scanners need luminance contrast, not brand contrast. Whatever the design
    // system does elsewhere, this one element sits on pure white.
    expect(block?.[0]).toMatch(/background:\s*#fff/i);
  });

  it('scans only through the outlet surface, never the member app', () => {
    // A camera in the guest's own app would be a different product: the member
    // presents a code, they do not read one. Opening one here would also mean the
    // app needed camera permission for no reason a guest could see.
    for (const file of memberSources()) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} must not open a camera`).not.toMatch(
        /getUserMedia|BarcodeDetector|zxing/i,
      );
    }
  });

  it('declares the scanner dependency only on the outlet surface', () => {
    for (const surface of surfaces) {
      const manifest = join(REPO_ROOT, 'apps', surface, 'package.json');
      if (!existsSync(manifest)) continue;

      const deps = Object.keys(
        (JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> })
          .dependencies ?? {},
      );
      const scanners = deps.filter((name) => /zxing|barcode/i.test(name));

      if (surface === 'web-member') {
        expect(scanners, 'the member app reads no codes').toEqual([]);
      }
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
    for (const host of ['my', 'admin', 'outlet']) {
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

  it('keeps the outlet screen and every route to its API on the hotel network', () => {
    const caddyfile = join(REPO_ROOT, 'docker', 'caddy', 'Caddyfile');
    if (!existsSync(caddyfile)) {
      return;
    }
    const source = readFileSync(caddyfile, 'utf8');

    function topLevelBlock(marker: string): string {
      const start = source.indexOf(marker);
      expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
      const end = source.indexOf('\n}', start);
      expect(end, `unterminated ${marker}`).toBeGreaterThan(start);
      return source.slice(start, end + 2);
    }

    /** A matcher alone is decorative: it must both name the range and be used. */
    function expectInternalGuard(block: string, path: string): void {
      const matchers = [
        ...block.matchAll(/@([\w-]+)\s*\{\r?\n([\s\S]*?)^\s*\}/gm),
      ];
      const guard = matchers.find((match) => {
        const body = match[2] ?? '';
        return /^\s*path\b.*$/m.test(body) && body.includes(path);
      });

      expect(guard, `no matcher protects ${path}`).toBeDefined();
      expect(guard?.[2]).toMatch(/not remote_ip \{\$INTERNAL_CIDR\}/);
      expect(block).toMatch(new RegExp(`respond\\s+@${guard?.[1]}\\b`));
    }

    const outletHost = topLevelBlock('outlet.{$DOMAIN} {');
    expect(outletHost).toMatch(/import internal_only/);

    // `api_proxy` is imported by public client hosts too. Without its own
    // guard, my.<domain>/api/outlet/* bypasses the outlet hostname restriction.
    const proxy = topLevelBlock('(api_proxy) {');
    expectInternalGuard(proxy, '/api/outlet/*');

    // The dedicated API hostname has no `/api` prefix, so it needs its own
    // matcher as well. Protecting only the browser-facing alias leaves this
    // direct path open to the internet.
    const directApi = topLevelBlock('api.{$DOMAIN} {');
    expectInternalGuard(directApi, '/outlet/*');
  });
});

describe('the member can start the benefit workflow', () => {
  it('renders the announce action and wires it to the API', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps', 'web-member', 'src', 'screens', 'OfferDetail.tsx'),
      'utf8',
    );

    expect(source).toContain('api.announceVisit');
    expect(source).toContain('Let the outlet know');
    // The live states. `SENT` is the only one that blocks announcing again.
    expect(source).toContain("currentRequest?.status === 'SENT'");
    expect(source).toContain("currentRequest?.status === 'NOT_USED'");
    expect(source).toContain("currentRequest?.status === 'FULFILLED'");
  });

  it('still renders the states from the old approval flow', () => {
    // Rows created before outlets closed their own notices keep PENDING,
    // APPROVED and DECLINED. Handling them is not optional politeness — a member
    // with one in their history would otherwise see a blank panel and no
    // explanation on the screen where they expect an answer.
    const source = readFileSync(
      join(REPO_ROOT, 'apps', 'web-member', 'src', 'screens', 'OfferDetail.tsx'),
      'utf8',
    );

    for (const historical of ['PENDING', 'APPROVED', 'DECLINED']) {
      expect(source, `no branch renders a historical ${historical} row`).toContain(historical);
    }
  });

  it('asks which outlet only when the server says it needs one', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps', 'web-member', 'src', 'screens', 'OfferDetail.tsx'),
      'utf8',
    );

    // A benefit honoured by one outlet never asks — the server fills it in. A
    // picker rendered unconditionally would be a required-looking field with a
    // single option on most screens.
    expect(source).toContain('outlet_required');
    expect(source).toContain('outlets.length > 0');
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
