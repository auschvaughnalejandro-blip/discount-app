import type { ReactNode } from 'react';

/**
 * The tracked uppercase label that opens a section — "MEMBERSHIP CARD",
 * "RECENT ACTIVITY", "NOTIFICATIONS".
 *
 * The letter-spacing is applied to text that is already uppercase in the
 * source rather than via `text-transform`, for one reason: a screen reader
 * reading "NOTIFICATIONS" from a `text-transform: uppercase` rule announces the
 * lowercase original, which is right — but when the source itself is uppercase
 * some readers spell it out letter by letter. Passing normal-case children and
 * letting CSS do the shouting keeps the accessible name readable.
 */
export function Eyebrow({ children, tone }: { children: ReactNode; tone?: 'sand' | 'muted' }) {
  return <p className={`eyebrow eyebrow-${tone ?? 'muted'}`}>{children}</p>;
}
