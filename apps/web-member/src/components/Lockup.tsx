import { useState } from 'react';

/**
 * The Steigenberger wordmark stack, over the hero on the two auth screens.
 *
 * **The mark is the artwork, not a reconstruction of it.** This was live text,
 * which no amount of type tuning could have made right: the wordmark is a
 * licensed narrow serif that ships no webfont (see `--font-wordmark`), so the
 * brand line fell through to a stand-in stack, and the property line — two
 * lines in the design, at two sizes and two colours — collapsed into one
 * tracked row reading "HOTEL DOHA". It looked like a placeholder because it
 * was one.
 *
 * `/assets/lockup.svg` is `Frame 1.svg` from the exports, flattened. That file
 * draws STEIGENBERGER as two overlaid 486 × 242 PNGs — the artwork and a
 * separate luminance mask — which is why it could not simply be dropped in: an
 * engine that does not composite the pair renders an opaque rectangle. The two
 * are composited once, at build time, into a single transparent image; "HOTEL &
 * RESIDENCE" and "DOHA" are the export's own paths, untouched. Rendered on top
 * of each other the export and the asset are the same picture.
 *
 * It draws at 144 × 53 and is not scaled. That is the size it occupies on the
 * 390px board: the A5 board places the same wordmark PNG at a scale within
 * 0.2% of this file's own, and centred at 144px wide its glyphs land within
 * ~1px of where the board puts them.
 *
 * A missing file is not a broken image. If the asset fails to load this falls
 * back to the text stack it replaced — wrong in the wordmark's face, but the
 * right words in roughly the right shape — which is also what a screen reader
 * gets either way, through `alt`.
 */

const BRAND = 'Steigenberger';

/**
 * **Resolved by the artwork**, which sets it under the wordmark across two
 * lines: the property is "Steigenberger Hotel & Residence Doha". That settles
 * what the brief's "Hotel Doha" and the seed's "Rooms & Residence" left open.
 * The fallback runs the two lines together, which is the one place the wording
 * is read as a sentence rather than seen as a lockup.
 */
const PROPERTY = 'Hotel & Residence Doha';

/** The flattened export. See above — this is the mark, not an approximation. */
const ARTWORK = '/assets/lockup.svg';

export function Lockup({ src }: { src?: string }) {
  // Keyed by the file rather than a bare boolean, so passing a different `src`
  // gets its own attempt instead of inheriting the previous one's failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const name = `${BRAND} ${PROPERTY}`;
  const artwork = src ?? ARTWORK;

  if (artwork !== failedSrc) {
    return (
      <img
        className="lockup"
        src={artwork}
        alt={name}
        // The first thing painted over the hero on a screen a member reaches
        // before they are recognised.
        fetchPriority="high"
        onError={() => {
          setFailedSrc(artwork);
        }}
      />
    );
  }

  return (
    <p className="lockup lockup-text" aria-label={name}>
      <span className="lockup-brand" aria-hidden="true">
        {BRAND}
      </span>
      <span className="lockup-property" aria-hidden="true">
        {PROPERTY}
      </span>
    </p>
  );
}
