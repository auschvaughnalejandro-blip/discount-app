/**
 * BUILD-PLAN §0 rule 1, and the Stage 10 acceptance criterion "zero CSS files
 * exist in this app".
 *
 * "No styling" is the easiest instruction to drift from — one `className` for
 * a quick layout fix, then a stylesheet to define it, and the rule is gone
 * without anyone deciding to drop it. This makes the drift a test failure.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** The three client apps, whichever of them exist yet. */
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

describe('the client apps carry no styling', () => {
  it('has at least one client app to check', () => {
    // Otherwise this file passes by describing nothing.
    expect(existingClients().length).toBeGreaterThan(0);
  });

  it.each(CLIENT_APPS)('%s contains no stylesheet', (name) => {
    const dir = join(REPO_ROOT, 'apps', name);
    if (!existsSync(dir)) {
      return;
    }

    const stylesheets = sourceFiles(dir).filter((file) =>
      /\.(css|scss|sass|less|styl)$/i.test(file),
    );

    expect(stylesheets).toEqual([]);
  });

  it.each(CLIENT_APPS)('%s uses no className or style attribute', (name) => {
    const dir = join(REPO_ROOT, 'apps', name);
    if (!existsSync(dir)) {
      return;
    }

    const offenders = sourceFiles(dir)
      .filter((file) => /\.(tsx|jsx|html)$/i.test(file))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /\bclassName=/.test(source) || /\bstyle=\{/.test(source);
      });

    expect(offenders).toEqual([]);
  });

  it.each(CLIENT_APPS)('%s pulls in no styling dependency', (name) => {
    const manifest = join(REPO_ROOT, 'apps', name, 'package.json');
    if (!existsSync(manifest)) {
      return;
    }

    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const installed = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
    const styling = installed.filter((dependency) =>
      /tailwind|bootstrap|styled-components|emotion|chakra|mui|@mantine|sass|less|postcss/i.test(
        dependency,
      ),
    );

    expect(styling).toEqual([]);
  });
});

describe('the member client hardcodes no benefit values', () => {
  it('contains no percentage, guest cap or reservation number', () => {
    const dir = join(REPO_ROOT, 'apps', 'web-member');
    if (!existsSync(dir)) {
      return;
    }

    // R14 again, from the other side: the API refusing to hardcode a value is
    // no use if the client quietly defaults one when a fetch fails.
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
 * §4: "Never `localStorage` — any XSS flaw becomes total account theft." And
 * "No tokens in URLs. They reach logs, history and referrer headers."
 *
 * Asserted here rather than only stated in SECURITY-REVIEW.md, because a
 * documented claim decays the moment someone adds a "remember me" checkbox.
 * Comments are stripped first: all three clients discuss localStorage in
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
        return /localStorage|sessionStorage|document\.cookie/.test(code);
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
        // A token appearing in a query string or interpolated into a path.
        return /[?&](access_?token|token|jwt)=/i.test(code);
      });

    expect(offenders).toEqual([]);
  });
});
