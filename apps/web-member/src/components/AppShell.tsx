import type { ReactNode } from 'react';

import { TabBar } from './TabBar.js';

/**
 * The page frame: the base ground, the 342px column, and the safe areas.
 *
 * `tabs` is what decides the bottom padding rather than a fixed value, because
 * the tab bar is a different height on the two screens that carry it (82px on
 * Offers, 62px on Profile) and the screens that do not carry one — the auth
 * screens and the card modal — must not reserve space for it.
 *
 * `bleed` turns off the horizontal gutter for screens whose hero runs edge to
 * edge. The gutter then belongs to the sections underneath, which is why it is
 * a variable rather than padding on this element.
 */
export function AppShell({
  children,
  tabs,
  bleed = false,
}: {
  children: ReactNode;
  /** Renders the tab bar and reserves its height. */
  tabs?: 'offers' | 'profile';
  bleed?: boolean;
}) {
  return (
    <div className="shell" data-bleed={bleed ? 'true' : 'false'} data-tabs={tabs ?? 'none'}>
      <main className="shell-main" id="main">
        {children}
      </main>
      {tabs === undefined ? null : <TabBar active={tabs} />}
    </div>
  );
}
