import type { ReactNode } from 'react';

import { Eyebrow } from './Eyebrow.js';

/**
 * The tinted panel on a benefit detail screen — "Good to know".
 *
 * Mint at low opacity over the base rather than the flat mint of the board:
 * the artwork's mint is a light colour and body text on it would have to
 * invert, which turns an aside into something louder than the screen's actual
 * call to action. The hue survives, the hierarchy does not break.
 */
export function InfoPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="info-panel">
      <Eyebrow tone="muted">{title}</Eyebrow>
      <div className="info-panel-body">{children}</div>
    </aside>
  );
}
