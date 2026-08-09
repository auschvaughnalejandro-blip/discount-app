import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { SessionProvider, useSession } from './session.js';
import { Activate } from './screens/Activate.js';
import { CardModal } from './screens/CardModal.js';
import { OfferDetail } from './screens/OfferDetail.js';
import { Offers } from './screens/Offers.js';
import { Profile } from './screens/Profile.js';
import { SignIn } from './screens/SignIn.js';
import { Styleguide } from './screens/Styleguide.js';
import { Verify } from './screens/Verify.js';

// Order matters: the shared foundation defines the tokens, theme.css overrides
// the palette for this surface, components.css builds the design system on top,
// layout.css arranges the screens, motion.css moves between them.
import '@pgp/ui/foundation.css';
import './theme.css';
import './components.css';
import './layout.css';
import './motion.css';

/**
 * The member app.
 *
 * Seven screens, addressable. Routing arrived with the redesign: the earlier
 * build switched screens with `useState`, which meant a benefit could not be
 * linked to, the browser's back button left the app entirely, and the card
 * could not be opened directly. Caddy already serves `index.html` for unknown
 * paths (`docker/caddy/Caddyfile`) and Vite does the same in development, so
 * real URLs work in both.
 *
 * Every value on every screen comes from the API. Nothing here hardcodes a
 * discount, a guest cap, a reservation number or a member's details — search
 * this directory for a percentage and you will not find one, and there is a
 * test that keeps it that way.
 */

function RequireMember({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();

  // Not "signed out" — we do not yet know. Showing the sign-in screen here and
  // replacing it a moment later would flash a passcode form at every returning
  // member who never needed one.
  if (status === 'resuming') {
    return (
      <div className="boot" role="status" aria-label="Loading">
        <span className="boot-mark" />
      </div>
    );
  }

  if (status === 'signed-out') {
    // `state` carries where they were headed, so a deep link survives the
    // detour through sign-in.
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

/** Sends an already-signed-in member past the auth screens. */
function RequireGuest({ children }: { children: ReactNode }) {
  const { status } = useSession();

  if (status === 'resuming') {
    return (
      <div className="boot" role="status" aria-label="Loading">
        <span className="boot-mark" />
      </div>
    );
  }

  return status === 'signed-in' ? <Navigate to="/offers" replace /> : <>{children}</>;
}

function Screens() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/offers" replace />} />

      <Route
        path="/signin"
        element={
          <RequireGuest>
            <SignIn />
          </RequireGuest>
        }
      />
      <Route
        path="/signin/verify"
        element={
          <RequireGuest>
            <Verify />
          </RequireGuest>
        }
      />
      <Route
        path="/activate"
        element={
          <RequireGuest>
            <Activate />
          </RequireGuest>
        }
      />

      <Route
        path="/offers"
        element={
          <RequireMember>
            <Offers />
          </RequireMember>
        }
      />
      <Route
        path="/offers/:slug"
        element={
          <RequireMember>
            <OfferDetail />
          </RequireMember>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireMember>
            <Profile />
          </RequireMember>
        }
      />
      <Route
        path="/profile/card"
        element={
          <RequireMember>
            <CardModal />
          </RequireMember>
        }
      />

      {/* Development surface. Renders every component in every state, so a
          change to a primitive can be seen against all of its uses at once. */}
      <Route path="/styleguide" element={<Styleguide />} />

      <Route path="*" element={<Navigate to="/offers" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Screens />
    </SessionProvider>
  );
}
