import { useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Which way a navigation is going, and telling CSS about it.
 *
 * The View Transitions API animates a DOM swap but has no idea whether that
 * swap was a step forward or a step back — the same two snapshots produce the
 * same animation either way. Direction is ours to supply: this stamps
 * `data-nav` on <html> immediately before the navigation, and every rule in
 * motion.css keys off it.
 *
 * The attribute is set *before* calling navigate rather than in an effect
 * afterwards, because the browser takes its "old" snapshot the moment
 * `startViewTransition` runs — which React Router does inside `navigate`. An
 * effect would land a frame too late and animate the previous direction.
 */

export type NavKind = 'push' | 'pop' | 'fade' | 'modal';

function stamp(kind: NavKind): void {
  document.documentElement.dataset['nav'] = kind;
}

/**
 * A `<Link>` that declares its direction.
 *
 * `onClick` fires before React Router begins the navigation, which is exactly
 * the window the stamp needs.
 */
export function AppLink({
  to,
  kind = 'push',
  className,
  children,
  replace = false,
  'aria-label': ariaLabel,
  'aria-current': ariaCurrent,
}: {
  to: string;
  kind?: NavKind;
  className?: string;
  children: ReactNode;
  replace?: boolean;
  // `| undefined` is explicit because exactOptionalPropertyTypes is on: these
  // are passed through from callers that compute them conditionally, and
  // "absent" and "present but undefined" are otherwise different types.
  'aria-label'?: string | undefined;
  'aria-current'?: 'page' | undefined;
}) {
  return (
    <Link
      to={to}
      className={className}
      replace={replace}
      viewTransition
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      onClick={() => {
        stamp(kind);
      }}
    >
      {children}
    </Link>
  );
}

/**
 * Programmatic navigation with a direction — for form submissions, which have
 * nowhere to hang a link.
 *
 * **Back navigates to an explicit route rather than calling `navigate(-1)`.**
 * That is a real trade-off and it went this way deliberately: `navigate(-1)`
 * hands the change to the history API, which resolves asynchronously and
 * outside `startViewTransition`, so a genuine history pop cannot be animated
 * without the DOM update happening synchronously inside the callback. Naming
 * the destination keeps the reverse animation. It is paired with `replace` so
 * the stack does not grow a new entry every time someone goes back and forth
 * between a list and a detail screen.
 *
 * The browser's own back button therefore navigates instantly, with no
 * animation. That is the honest fallback: the app works, it just doesn't slide.
 */
export interface NavOptions {
  kind?: NavKind;
  replace?: boolean;
  /** Carried in history state, not the URL — see SignIn for why. */
  state?: unknown;
}

export function useAppNavigate(): (to: string, options?: NavOptions) => void {
  const navigate = useNavigate();

  return useCallback(
    (to: string, options: NavOptions = {}) => {
      const { kind = 'push', replace = false, state } = options;
      stamp(kind);
      void navigate(to, { viewTransition: true, replace, state });
    },
    [navigate],
  );
}
