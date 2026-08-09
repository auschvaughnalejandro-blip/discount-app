import { Link } from 'react-router-dom';

import { Lockup } from './Lockup.js';

/**
 * The membership card — 342 × 216, the same object on Profile and inside the
 * card modal.
 *
 * One component used in both places, at the same size, is what makes the
 * transition between them work: it carries `view-transition-name:
 * membership-card`, so the browser pairs the two instances and interpolates the
 * card's position between screens rather than cross-fading one into the other.
 * Two lookalike implementations would have nothing to pair.
 *
 * The gold building line art is the one piece of genuine artwork lifted out of
 * the design exports, extracted once to `/assets/tower-lineart.svg` and loaded
 * as an image. It is decorative and marked so.
 *
 * Name and number are nullable and render as skeletons while the profile loads.
 * Nothing here has a default — a card showing a placeholder name is a card
 * showing somebody else's.
 */
export function MembershipCard({
  fullName,
  memberNumber,
  href,
}: {
  fullName: string | null;
  memberNumber: string | null;
  /** Makes the whole card the tap target. Omitted inside the modal. */
  href?: string;
}) {
  const face = (
    <>
      <img className="card-lineart" src="/assets/tower-lineart.svg" alt="" aria-hidden="true" />

      <div className="card-head">
        <Lockup size="card" />
      </div>

      <div className="card-foot">
        <span className="card-name">
          {fullName ?? <span className="skeleton card-name-skeleton" aria-hidden="true" />}
        </span>
        {/* The number is the credential staff type in, so it is tabular and
            tracked — read aloud across a counter, digit by digit. */}
        <span className="card-number">
          {memberNumber ?? <span className="skeleton card-number-skeleton" aria-hidden="true" />}
        </span>
      </div>
    </>
  );

  if (href === undefined) {
    return <div className="membership-card">{face}</div>;
  }

  return (
    <Link className="membership-card membership-card-link" to={href} viewTransition>
      {face}
      <span className="visually-hidden">Show membership card</span>
    </Link>
  );
}
