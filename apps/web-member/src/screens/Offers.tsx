import { useEffect } from 'react';

import { AppShell } from '../components/AppShell.js';
import { BenefitCard } from '../components/BenefitCard.js';
import { useSession } from '../session.js';

/**
 * `/offers` — every benefit, with its terms open.
 *
 * Nothing is hidden behind a tap. The thing this app replaces is a printed
 * sheet showing all five at once, and putting the rates behind a navigation
 * step would be a downgrade dressed as an improvement. `Details` exists for the
 * full conditions and the reservation number, not to reveal the discount.
 *
 * While `benefits` is null the list renders as skeleton cards at roughly the
 * right height, so the page does not jump when the data lands.
 */
export function Offers() {
  const { benefits, error, benefitsError, refreshBenefits } = useSession();

  useEffect(() => {
    void refreshBenefits();
  }, [refreshBenefits]);

  return (
    <AppShell tabs="offers">
      <header className="screen-head">
        <h1 className="title">Your benefits</h1>
        <p className="lede">Every privilege included with your membership.</p>
      </header>

      {benefitsError === null && error === null ? null : (
        <p role="alert" className="screen-alert">
          {benefitsError ?? error}
        </p>
      )}

      {benefits === null ? (
        <ul className="benefit-list" aria-busy="true" aria-label="Loading your benefits">
          {[0, 1, 2, 3, 4].map((row) => (
            <li key={row} className="benefit-card benefit-card-skeleton">
              <span className="skeleton skeleton-line skeleton-title" />
              <span className="skeleton skeleton-line skeleton-sub" />
              <span className="skeleton skeleton-line skeleton-action" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="benefit-list">
          {benefits.map((benefit, index) => (
            <BenefitCard key={benefit.key} benefit={benefit} index={index} />
          ))}
        </ul>
      )}
    </AppShell>
  );
}
