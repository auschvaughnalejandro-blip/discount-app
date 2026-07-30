import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';

import { api } from './api.js';
import './mfa.css';

/**
 * The second-factor step of dashboard sign-in — Stage 19, wireframes screen 11
 * ("login with MFA").
 *
 * Two shapes, chosen by the server's `stage`:
 *
 * - **enroll** — the account has never set up a second factor. §3 says MFA is
 *   mandatory "without exception", so this is not skippable: there is no path
 *   from here to the dashboard except completing it.
 * - **verify** — enrolled already; enter a code, or a recovery code.
 *
 * The enrollment QR is the same `react-qr-code` renderer the member app uses for
 * the digital card, at the same error-correction level and for the same reason.
 */

interface Props {
  challengeToken: string;
  stage: 'enroll' | 'verify';
  onSignedIn: (accessToken: string) => void;
}

export default function MfaSignIn({ challengeToken, stage, onSignedIn }: Props) {
  return stage === 'enroll' ? (
    <Enroll challengeToken={challengeToken} onSignedIn={onSignedIn} />
  ) : (
    <Verify challengeToken={challengeToken} onSignedIn={onSignedIn} />
  );
}

// ── Enrollment ───────────────────────────────────────────────────────────

function Enroll({
  challengeToken,
  onSignedIn,
}: {
  challengeToken: string;
  onSignedIn: (accessToken: string) => void;
}) {
  const [setup, setSetup] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .mfaEnrollStart(challengeToken)
      .then((result) => {
        if (!cancelled) {
          setSetup(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not start setup. Sign in again.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [challengeToken]);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.mfaEnrollConfirm(challengeToken, code);
      /**
       * The dashboard is deliberately *not* entered yet. These codes are shown
       * exactly once — only their hashes are stored — so dropping the user
       * straight into the members list would lose them silently. They must
       * acknowledge first.
       */
      setRecoveryCodes(result.recoveryCodes);
      setPendingToken(result.accessToken);
    } catch {
      setError('That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes && pendingToken) {
    return (
      <main className="signin">
        <section className="signin-card mfa-card">
          <h1>Save your recovery codes</h1>
          <p className="mfa-lede">
            Each code works once, in place of your authenticator. Store them somewhere separate
            from your phone — this is the only time they are shown.
          </p>

          <ul className="recovery-codes">
            {recoveryCodes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>

          <button type="button" onClick={() => onSignedIn(pendingToken)}>
            I have saved these codes — continue
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="signin">
      <section className="signin-card mfa-card">
        <h1>Set up two-factor authentication</h1>
        <p className="mfa-lede">
          Every dashboard account requires it. Scan this with an authenticator app, then enter the
          six-digit code it shows.
        </p>

        {setup ? (
          <>
            <div className="qr">
              <QRCode value={setup.otpauthUri} level="M" size={200} title="Authenticator setup" />
            </div>

            {/* For a device that cannot scan. */}
            <details className="manual-entry">
              <summary>Can&rsquo;t scan? Enter the key by hand</summary>
              <p>
                <output>{setup.secret}</output>
              </p>
            </details>
          </>
        ) : (
          <p>Preparing setup…</p>
        )}

        <form onSubmit={confirm}>
          <p className="field">
            <label htmlFor="mfa-code">Six-digit code</label>
            <br />
            <input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </p>
          <button type="submit" disabled={busy || setup === null}>
            Confirm and finish setup
          </button>
        </form>

        {error ? <p role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

// ── Verification ─────────────────────────────────────────────────────────

function Verify({
  challengeToken,
  onSignedIn,
}: {
  challengeToken: string;
  onSignedIn: (accessToken: string) => void;
}) {
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.mfaVerify(
        challengeToken,
        useRecovery ? { recoveryCode } : { code },
      );
      onSignedIn(result.accessToken);
    } catch {
      // Uniform message: the server does not distinguish a wrong code from an
      // expired challenge, and neither does this.
      setError('That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <section className="signin-card mfa-card">
        <h1>Enter your code</h1>
        <p className="mfa-lede">
          {useRecovery
            ? 'Enter one of the recovery codes you saved when you set up two-factor authentication.'
            : 'Open your authenticator app and enter the six-digit code.'}
        </p>

        <form onSubmit={submit}>
          {useRecovery ? (
            <p className="field">
              <label htmlFor="recovery">Recovery code</label>
              <br />
              <input
                id="recovery"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
              />
            </p>
          ) : (
            <p className="field">
              <label htmlFor="mfa-code">Six-digit code</label>
              <br />
              <input
                id="mfa-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </p>
          )}

          <button type="submit" disabled={busy}>
            Continue
          </button>
        </form>

        <button
          type="button"
          className="text-button"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setError(null);
          }}
        >
          {useRecovery ? 'Use my authenticator instead' : 'Lost your phone? Use a recovery code'}
        </button>

        {error ? <p role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
