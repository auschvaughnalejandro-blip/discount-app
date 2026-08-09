import { formatDate } from '@pgp/ui/format';

import { AppShell } from '../components/AppShell.js';
import { Button } from '../components/Button.js';
import { Eyebrow } from '../components/Eyebrow.js';
import { MembershipCard } from '../components/MembershipCard.js';
import { AppLink } from '../navigation.js';
import { useSession } from '../session.js';

/**
 * `/profile/card` — the card, full attention.
 *
 * A route rather than an overlay, so it is addressable and the browser's back
 * button closes it. It renders the *same* `MembershipCard` at the same size as
 * the one on Profile, which is what lets the view transition morph one into the
 * other instead of cross-fading two lookalikes.
 *
 * Three things on this screen are deliberately not what the board shows, and
 * each is noted where it appears:
 *
 * - the code block is a placeholder, because the scanned credential was removed
 *   from this product;
 * - Add to Wallet has nothing to add;
 * - screen brightness is not something the web can set.
 */
export function CardModal() {
  const { profile } = useSession();

  return (
    <AppShell>
      <div className="modal">
        <header className="modal-head">
          <Eyebrow tone="muted">Membership card</Eyebrow>
          <AppLink to="/profile" kind="modal" replace className="close-button" aria-label="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M6 6 L18 18 M18 6 L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </AppLink>
        </header>

        <MembershipCard
          fullName={profile?.fullName ?? null}
          memberNumber={profile?.memberNumber ?? null}
        />

        {/**
         * The board puts a scannable code here. There is none.
         *
         * The guest QR was removed from this product on 2026-08-08 — the client
         * did not want a scanned credential, and `client-invariants.test.ts`
         * now fails the build if this app declares a QR dependency, renders a
         * code or opens a camera. A member is identified by their number, which
         * staff look up and approve.
         *
         * So this block holds the shape the design reserves and nothing else,
         * pending a decision on what belongs in it. It is not a QR waiting for
         * a library.
         */}
        <div className="code-block" aria-hidden="true" />

        <p className="modal-caption">Show this card at any outlet to redeem.</p>

        {profile === null ? null : (
          <p className="modal-validity">
            Valid while your membership is active · Member since {formatDate(profile.joinedAt)}
          </p>
        )}

        {/**
         * Nothing to add. An Apple Wallet pass is a signed `.pkpass` and a
         * Google Wallet pass is a signed JWT; both are issued by a server with
         * the property's certificates, and no such endpoint exists. The button
         * keeps its place in the layout rather than disappearing, because its
         * absence would silently change the screen — but it does not pretend to
         * work.
         */}
        <Button disabled>Add to Wallet</Button>
        <p className="modal-note">Wallet passes are not set up yet.</p>

        {/**
         * Screen brightness has no web API — not prefixed, not behind a flag,
         * not on any engine. The spec asks for this button "where the platform
         * allows and hidden where it doesn't", and on the web the honest answer
         * is that it never allows, so it never renders here.
         *
         * `ScreenBrightness` is checked rather than assumed absent so that a
         * future WebView wrapper injecting a native bridge gets the button for
         * free, without this file needing to know about it.
         */}
        {'ScreenBrightness' in window ? (
          <Button variant="outline" onClick={() => undefined}>
            Screen brightness
          </Button>
        ) : null}
      </div>
    </AppShell>
  );
}
