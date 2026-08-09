/**
 * Where each screen looks for its photograph.
 *
 * These are paths under `apps/web-member/public/`, which Vite serves at the
 * site root and copies into `dist/` verbatim. Nothing here needs the file to
 * exist: `HeroImage` falls back to its placeholder when an image is missing or
 * fails to load, so a name can be declared before the photography arrives.
 *
 * Adding a photograph is: save the file under the matching name, reload. No
 * import, no code change — the file is copied, not compiled.
 *
 * **Format.** Prefer `.jpg` or `.webp`. A hero is a photograph, so PNG costs
 * several times the bytes for no visible gain, and AVIF — while the smallest —
 * is unsupported before iOS 16.4, where the screen falls back to the grey
 * placeholder rather than the picture.
 *
 * Around 1170 × 780 covers the 390px board at 3×.
 */

const DIRECTORY = '/images';

export const HERO = {
  /**
   * Shared by /signin and /signin/verify — one arrival image across the whole
   * sign-in flow, so moving between the two screens does not change the
   * picture behind the lockup.
   */
  auth: `${DIRECTORY}/auth.webp`,
  /**
   * /activate, the shorter band.
   *
   * Pointed at the same photograph as sign-in: no separate image was supplied,
   * and activation is the same arrival moment. Give it its own file and change
   * this one line if it should differ.
   */
  activate: `${DIRECTORY}/auth.webp`,
} as const;

/**
 * Benefit heroes, by the benefit's public key.
 *
 * Named explicitly because the supplied files are not all the same format —
 * anything not listed falls through to the `benefit-<key>.jpg` convention, so
 * a benefit an administrator adds tomorrow gets its hero by someone saving a
 * file, with no edit here.
 *
 * `lifestyle` is deliberately absent: no photograph exists for it yet, and it
 * shows the placeholder until one does.
 */
const BENEFIT_HERO: Record<string, string> = {
  fnb: 'benefit-fnb.jpg',
  rooms: 'benefit-rooms.avif',
  spa: 'benefit-spa.jpg',
  events: 'benefit-events.jpg',
};

export function heroForBenefit(key: string): string {
  return `${DIRECTORY}/${BENEFIT_HERO[key] ?? `benefit-${key}.jpg`}`;
}
