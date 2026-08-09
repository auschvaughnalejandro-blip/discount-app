import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { api } from '../api.js';
import { AppShell } from '../components/AppShell.js';
import { Button } from '../components/Button.js';
import { Eyebrow } from '../components/Eyebrow.js';
import { HeroImage } from '../components/HeroImage.js';
import { Lockup } from '../components/Lockup.js';
import { OtpInput } from '../components/OtpInput.js';
import { useAppNavigate } from '../navigation.js';
import { useSession } from '../session.js';
import { HERO } from './heroes.js';
import { DIAL_CODE, formatNational } from './phone.js';

/**
 * `/signin/verify` — the six-digit passcode.
 *
 * The resend countdown is a real timer rather than a label. A static "Resend
 * code in 0:42" is worse than no countdown at all: it tells someone to wait for
 * a number that never moves, and the resend link it guards never becomes
 * reachable.
 */

const RESEND_SECONDS = 42;

interface SignInState {
  phone: string;
  national: string;
}

export function Verify() {
  const location = useLocation();
  const state = location.state as SignInState | null;

  const navigate = useAppNavigate();
  const { signIn } = useSession();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(RESEND_SECONDS);

  // One interval for the life of the screen, cleared on unmount. Restarted by
  // the resend handler setting `remaining` rather than by a second timer.
  const tick = useRef<number | null>(null);
  useEffect(() => {
    tick.current = window.setInterval(() => {
      setRemaining((value) => (value <= 0 ? 0 : value - 1));
    }, 1000);
    return () => {
      if (tick.current !== null) {
        window.clearInterval(tick.current);
      }
    };
  }, []);

  // No number to verify against — a reload, or someone arriving at this URL
  // directly. Sending them back is the only honest option; the alternative is a
  // form that cannot succeed.
  if (state === null) {
    return <Navigate to="/signin" replace />;
  }

  // Pulled out of `state` here rather than read inside the handlers below:
  // those are hoisted function declarations, so TypeScript cannot carry the
  // null check above into them, and two defensive re-checks would be noise
  // guarding something the early return already settled.
  const { phone, national } = state;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (code.length !== 6 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      signIn(await api.signInVerifyOtp(phone, code));
      navigate('/offers', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That code was not accepted.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      await api.signInRequestOtp(phone);
      setRemaining(RESEND_SECONDS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send another code.');
    }
  }

  const clock = `${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, '0')}`;

  return (
    <AppShell bleed>
      <HeroImage height={260} src={HERO.auth}>
        <Lockup />
        <Eyebrow tone="sand">Privilege Guest</Eyebrow>
      </HeroImage>

      <section className="auth">
        <h1 className="title-auth">Enter your passcode</h1>
        <p className="lede">
          We emailed a passcode to the address registered for {DIAL_CODE}{' '}
          {formatNational(national)}.
        </p>

        <form className="panel-card" onSubmit={(event) => void submit(event)} noValidate>
          <OtpInput value={code} onChange={setCode} error={error !== null} />

          {error === null ? null : (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}

          <p className="resend">
            {remaining > 0 ? (
              // Explicitly not a live region. A screen reader announcing
              // "resend code in 0:37, resend code in 0:36" once a second makes
              // the screen unusable; what matters is the resend control
              // appearing, and that is a focusable button when it does.
              <span aria-live="off">Resend code in {clock}</span>
            ) : (
              <button type="button" className="text-link" onClick={() => void resend()}>
                Send a new code
              </button>
            )}
          </p>

          <Button type="submit" disabled={code.length !== 6 || busy}>
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
        </form>

        <p className="auth-alt">
          <button
            type="button"
            className="text-link"
            onClick={() => {
              navigate('/signin', { kind: 'pop', replace: true });
            }}
          >
            Change number
          </button>
        </p>
      </section>
    </AppShell>
  );
}
