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

const CLIENT_APPS = ['web-member', 'web-verify', 'web-admin'];

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
describe('the digital card stays scannable', () => {
  const cardStyles = join(REPO_ROOT, 'apps', 'web-member', 'src', 'digital-card.css');

  it('surrounds the QR with a white quiet zone', () => {
    if (!existsSync(cardStyles)) {
      return;
    }
    const css = readFileSync(cardStyles, 'utf8');
    expect(css).toMatch(/--qr-quiet-zone/);
    expect(css.toLowerCase()).toMatch(/background:\s*#fff/);
  });

  it('asks for error correction level M, not the library default', () => {
    const app = join(REPO_ROOT, 'apps', 'web-member', 'src', 'App.tsx');
    if (!existsSync(app)) {
      return;
    }
    expect(readFileSync(app, 'utf8')).toMatch(/level="M"/);
  });
});

/**
 * Stage 23. The member app is installable, which means a service worker sits
 * between it and the API — and the one thing that must never be cached is the
 * rotating identity payload.
 *
 * A cached credential fails at a spa reception with no useful error: the member
 * sees a QR, staff see a rejection, and nothing on screen explains why. The
 * failure is invisible in development because the service worker is disabled
 * there, so it is asserted against the Vite config rather than discovered on a
 * counter.
 */
describe('the installable member app never caches a credential', () => {
  const viteConfig = join(REPO_ROOT, 'apps', 'web-member', 'vite.config.ts');

  it('serves the identity code from the network only', () => {
    if (!existsSync(viteConfig)) {
      return;
    }
    const source = readFileSync(viteConfig, 'utf8');
    const rule = /identity-code\$\/,\s*handler:\s*'NetworkOnly'/;
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
