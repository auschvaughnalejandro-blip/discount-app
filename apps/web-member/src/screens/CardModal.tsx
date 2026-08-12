import { formatDate } from '@pgp/ui/format';
import QRCode from 'react-qr-code';

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
 * Two things on this screen are deliberately not what the board shows, and each
 * is noted where it appears:
 *
 * - Add to Wallet has nothing to add;
 * - screen brightness is not something the web can set.
 *
 * The code block, which used to be a third, now holds a real scannable code —
 * see below, and DECISIONS.md for why it came back.
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
         * The code the board reserves this block for.
         *
         * It is the *same value* printed on the back of the physical card, so a
         * guest can present either and staff scan the same thing. It identifies
         * and grants nothing — resolving it tells staff who the member is, and
         * recording anything still needs them signed in at an outlet.
         *
         * Level M rather than H: H adds roughly 30% more modules, which on a phone
         * at 216px makes each one smaller and *harder* to read. H earns its keep on
         * printed labels that get dirty, not on a backlit screen.
         *
         * Static, so there is nothing to refresh and no countdown to explain.
         */}
        <div className="code-block">
          {profile === null ? (
            <span className="skeleton qr-quiet-zone" aria-hidden="true" />
          ) : (
            <>
              <div className="qr-quiet-zone">
                <QRCode
                  value={profile.cardCode}
                  level="M"
                  title={`Membership code for ${profile.memberNumber}`}
                />
              </div>
              <output className="code-fallback">{profile.cardCode}</output>
            </>
          )}
        </div>

        <p className="modal-caption">
          Show this code at any outlet, or hand over your card — the code on the back is
          the same one.
        </p>

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
