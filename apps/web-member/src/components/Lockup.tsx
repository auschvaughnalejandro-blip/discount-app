/**
 * The Steigenberger wordmark stack.
 *
 * Set as live text, not as the artwork from the exports. The boards embed the
 * lockup as two overlaid PNGs — an image and its mask — which renders as an
 * opaque rectangle in engines that do not composite the pair, and would ship
 * ~10KB of base64 per screen. Text scales, inverts, translates for Stage 22's
 * Arabic, and is readable by a screen reader.
 *
 * When a single transparent `lockup.svg` is supplied, pass `src` and it takes
 * over; the text stays as its alt, so nothing regresses if the file is missing
 * at runtime.
 *
 * **Unconfirmed:** whether the property line reads "Hotel Doha" or "Hotel &
 * Residence Doha". `PROPERTY` carries the wording from the brief; the seed's
 * outlet list calls one outlet "Rooms & Residence", which points the other way.
 */

const BRAND = 'Steigenberger';
const PROPERTY = 'Hotel Doha';

/**
 * On the membership card the property line is shorter — measuring the exported
 * boards, that line is four glyphs wide where the hero's is nine, so the card
 * carries the city alone. It is a separate constant rather than a truncation
 * because it is a different piece of copy, not a smaller rendering of the
 * same one.
 */
const PROPERTY_CARD = 'Doha';

export function Lockup({
  src,
  size = 'default',
}: {
  src?: string;
  /** `card` is the small centred mark on the membership card. */
  size?: 'default' | 'card';
}) {
  const property = size === 'card' ? PROPERTY_CARD : PROPERTY;
  const name = `${BRAND} ${size === 'card' ? PROPERTY : property}`;

  if (src !== undefined) {
    return <img className={`lockup lockup-${size}`} src={src} alt={name} />;
  }

  return (
    <p className={`lockup lockup-${size}`} aria-label={name}>
      <span className="lockup-brand" aria-hidden="true">
        {BRAND}
      </span>
      <span className="lockup-property" aria-hidden="true">
        {property}
      </span>
    </p>
  );
}
