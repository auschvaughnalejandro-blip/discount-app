import { Link } from 'react-router-dom';

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
 * **The face is the design file, not a reconstruction of it.**
 * `/assets/card-face.svg` is `svg files/privilege-guest-card (1) 1 1.svg` with
 * the specimen name and number lifted out and nothing else touched — the
 * gradient, the wordmark stack, the building line art and the "PRIVILEGE GUEST"
 * lettering laid into the facade all arrive exactly as drawn, at the exact
 * 540 × 340 coordinates they were drawn at.
 *
 * Rebuilding those in CSS is what this replaces, and the wordmark is why it
 * could never work: the lockup is a licensed narrow serif that ships no webfont
 * (see `--font-wordmark`), so live text fell through to a stand-in stack and
 * lost the "HOTEL & RESIDENCE" line, and the line art had to be scaled by hand
 * into a box that never quite matched. The artwork has no such problem.
 *
 * Two edits were made to the export, both recorded here so a re-export can be
 * repeated: the 26 outlined glyph paths of the specimen name and number were
 * removed (the four that spell DOHA were kept — that is lockup, not data), and
 * so was a full-bleed white rectangle behind the rounded face, which the export
 * hides under the gradient and which showed at the corners.
 *
 * Only the two fields that differ per member stay as live text, positioned over
 * the artwork at the coordinates the removed glyphs occupied. Both are nullable
 * and render as skeletons while the profile loads. Neither has a default — a
 * card showing a placeholder name is a card showing somebody else's.
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
      {/* Not decorative: the wordmark and programme name are only in here, so
          this is the element that has to say them. */}
      <img
        className="card-face"
        src="/assets/card-face.svg"
        alt="Steigenberger Hotel & Residence Doha — Privilege Guest"
      />

      <div className="card-foot">
        <span className="card-name">
          {fullName ?? <span className="skeleton card-name-skeleton" aria-hidden="true" />}
        </span>
        {/* The number is the credential staff type in, so its figures are
            tabular — it does not reflow as it counts up. */}
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
