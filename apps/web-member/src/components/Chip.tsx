import type { ReactNode } from 'react';

/**
 * The small pill on a benefit card carrying a party-size limit.
 *
 * This is the detail that causes an awkward conversation at a counter — a
 * member arrives with eight people for a benefit capped at six — so the design
 * puts it on the list rather than behind a tap, and it is marked up as its own
 * element rather than left as a sentence.
 */
export function Chip({
  children,
  variant = 'outline',
}: {
  children: ReactNode;
  variant?: 'outline' | 'filled';
}) {
  return <span className={`chip chip-${variant}`}>{children}</span>;
}
