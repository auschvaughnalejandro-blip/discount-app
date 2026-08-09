import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The photographic band at the top of a screen, with a scrim into the base
 * colour and an optional overlay.
 *
 * **A missing image is not a broken image.** Every screen names the file it
 * wants, whether or not that file exists yet; if it is absent — or fails to
 * load on a bad connection — this falls back to the labelled placeholder
 * rather than rendering a broken-image icon over the lockup. So photography
 * arrives by dropping a file into `public/images/` under the expected name,
 * with no code change and no rebuild of anything but the assets.
 *
 * That fallback is also the honest production behaviour: a hotel replacing a
 * seasonal photograph should never be able to leave a member looking at a
 * broken icon because a filename was mistyped.
 *
 * The scrim is a pseudo-element rather than a gradient baked into the image,
 * so it stays correct when the image is replaced and when there is none at
 * all. Its job is to carry the lockup over the picture legibly and hand the
 * page back to `--base` without a seam.
 */
export function HeroImage({
  src,
  alt,
  height,
  children,
}: {
  /** Path under `public/`, e.g. `/images/signin.jpg`. May not exist yet. */
  src?: string | undefined;
  /**
   * Describe the photograph, or omit it when the image is decorative — which
   * a hero behind a heading usually is, since the heading already says where
   * you are. An empty alt is a decision; a missing one is an oversight.
   */
  alt?: string | undefined;
  /** 260 on the auth screens, 196 on activate, 300 on a benefit detail. */
  height: number;
  /** Sits over the scrim — the lockup, or a back button. */
  children?: ReactNode;
}) {
  // Keyed by src so switching benefit detail screens re-tries the new image
  // instead of inheriting the previous one's failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const usable = src !== undefined && src !== failedSrc;

  return (
    <div className="hero" style={{ blockSize: `${String(height)}px` }}>
      {usable ? (
        <img
          className="hero-image"
          src={src}
          alt={alt ?? ''}
          // The hero is the first thing painted on every screen that has one.
          fetchPriority="high"
          onError={() => {
            setFailedSrc(src);
          }}
        />
      ) : (
        <div className="hero-placeholder" aria-hidden="true">
          <span>Image</span>
        </div>
      )}
      <div className="hero-scrim" aria-hidden="true" />
      {children === undefined ? null : <div className="hero-content">{children}</div>}
    </div>
  );
}
