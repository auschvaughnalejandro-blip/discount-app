import { AppLink } from '../navigation.js';

/**
 * The circular back control that sits over a hero.
 *
 * A link, not a button: it goes to a named place, so it should be openable in a
 * new tab, announced as a link, and reachable by the same means as every other
 * navigation on the screen. `kind="pop"` runs the screen transition in reverse.
 *
 * The visible circle is 36px because that is what the boards draw. The tap
 * target is 44px, supplied by padding around it — the design's circle is the
 * part you see, not the part you have to hit.
 */
export function BackButton({ to, label }: { to: string; label: string }) {
  return (
    <AppLink to={to} kind="pop" replace className="back-button" aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M15 5 L8 12 L15 19"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </AppLink>
  );
}
