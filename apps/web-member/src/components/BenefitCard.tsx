import { Link } from 'react-router-dom';

import type { Benefit } from '../api.js';
import { Chip } from './Chip.js';

/**
 * One benefit on the list: title, the rate in sand, whatever sub-lines that
 * benefit happens to carry, and an action row.
 *
 * Every value comes off the `Benefit` the API returned. There are no defaults
 * and no fallbacks — a client that "helpfully" defaulted a percentage would
 * break R14 as surely as the server would, and `client-invariants.test.ts`
 * fails the build if a percentage, guest cap or reservation number appears in
 * this directory.
 *
 * The card's height is not set. Two of the five benefits carry a secondary
 * rate, one carries child bands, three carry a party-size limit and one carries
 * none of it; a fixed height would either clip the fullest card or leave the
 * emptiest one floating in space.
 */
export function BenefitCard({ benefit, index }: { benefit: Benefit; index: number }) {
  const childBands = Object.entries(benefit.childRules ?? {});

  return (
    <li
      className="benefit-card enter-stagger"
      // The stagger stops counting at six. Past that it is delaying rows below
      // the fold, which on a slow connection means the last card visibly lags
      // behind a list the member is already reading.
      style={{ '--enter-index': Math.min(index, 6) } as React.CSSProperties}
    >
      <h2 className="benefit-title">
        {benefit.title}
        <span className="benefit-rate">{benefit.discountPct}%</span>
      </h2>

      {benefit.secondaryLabel !== null && benefit.secondaryPct !== null ? (
        <p className="benefit-sub">
          {benefit.secondaryLabel}: <span className="benefit-sub-rate">{benefit.secondaryPct}%</span>
        </p>
      ) : null}

      {childBands.length === 0 ? null : (
        <p className="benefit-sub">
          {childBands.map(([band, pct], position) => (
            <span key={band}>
              {position === 0 ? null : <span className="benefit-sub-sep"> · </span>}
              Children {band}: <span className="benefit-sub-rate">{pct}%</span>
            </span>
          ))}
        </p>
      )}

      <div className="benefit-actions">
        {benefit.maxGuests === null ? null : <Chip>Maximum {benefit.maxGuests} guests</Chip>}
        {benefit.minGuests === null ? null : <Chip>Minimum {benefit.minGuests} guests</Chip>}

        <Link className="benefit-details" to={`/offers/${benefit.key}`} viewTransition>
          Details
        </Link>
      </div>
    </li>
  );
}
