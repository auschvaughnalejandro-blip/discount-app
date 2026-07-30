import { useState } from 'react';

import { formatDate, formatTimeOfDay, formatTimestamp } from '@pgp/ui/format';

import { api, clearToken, setToken, type Entitlement, type ResolvedMember } from './api.js';
import Scanner from './Scanner.js';

import '@pgp/ui/foundation.css';
import './theme.css';
import './layout.css';

/**
 * The staff verification page (wireframes screens 9, 10, D6).
 *
 * A web page, not an application: staff open a URL on whatever device is
 * already behind the counter (screen 9 note 1).
 *
 * There is no member list and no search anywhere in this file. Staff retrieve
 * only the person in front of them, by exact number or scan (screen 9 note 4,
 * R11). The server enforces that too; this is not the only line of defence,
 * but it should not be the weak one either.
 */
export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [resolved, setResolved] = useState<ResolvedMember | null>(null);

  if (!signedIn) {
    return <SignIn onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <main>
      <header>
        <h1>Verify a Privilege Guest</h1>
        <button
          type="button"
          onClick={() => {
            clearToken();
            setResolved(null);
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </header>

      {resolved ? (
        <MemberFound resolved={resolved} onDone={() => setResolved(null)} />
      ) : (
        <Lookup onResolved={setResolved} />
      )}
    </main>
  );
}

// ── Staff sign-in ────────────────────────────────────────────────────────

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.login(email, password);
      setToken(tokens.accessToken);
      onSignedIn();
    } catch {
      // Uniform message: the server does not distinguish a wrong password
      // from an unknown account, and neither does this.
      setError('Those details were not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Verify a Privilege Guest</h1>
      {/* Screen 9 note 3: staff sign in individually. Every redemption is
          attributed to a named person — without that, an incorrectly applied
          40% discount is untraceable. */}
      <p className="signin-lede">Sign in with your own account.</p>

      <form onSubmit={submit}>
        <p className="field">
          <label htmlFor="email">Email</label>
          <br />
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </p>
        <p className="field">
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </p>
        <p>
          <button type="submit" disabled={busy}>
            Sign in
          </button>
        </p>
      </form>

      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}

// ── Screen 9: lookup ─────────────────────────────────────────────────────

function Lookup({ onResolved }: { onResolved: (resolved: ResolvedMember) => void }) {
  const [membershipNumber, setMembershipNumber] = useState('');
  const [payload, setPayload] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(input: { membershipNumber?: string; payload?: string }) {
    setBusy(true);
    setError(null);
    try {
      onResolved(await api.resolve(input));
    } catch (cause) {
      setError(
        cause instanceof Error && 'status' in cause && (cause as { status: number }).status === 404
          ? 'No matching member.'
          : 'That lookup did not work.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="lookup-section">
      <h2>Scan member code</h2>
      {/* The camera path. The server treats a scanned payload and a pasted one
          identically, so this is a convenience over the box below rather than a
          separate mechanism — which is why a failed camera is never a blocker. */}
      <Scanner onScan={(scanned) => void lookup({ payload: scanned })} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup({ payload });
        }}
      >
        <p className="field">
          <label htmlFor="payload">Or paste the code</label>
          <br />
          <input id="payload" value={payload} onChange={(e) => setPayload(e.target.value)} />
        </p>
        <p>
          <button type="submit" disabled={busy || payload.length === 0}>
            Look up scanned code
          </button>
        </p>
      </form>

      </div>

      <div className="lookup-section">
      <h2>Or enter membership number</h2>
      {/* Screen 9 note 2: many members present the printed card rather than
          the app, so typing the number must work as well as scanning. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup({ membershipNumber });
        }}
      >
        <p className="field">
          <label htmlFor="number">Membership number</label>
          <br />
          <input
            id="number"
            value={membershipNumber}
            onChange={(e) => setMembershipNumber(e.target.value)}
            placeholder="PG-0000"
          />
        </p>
        <p>
          <button type="submit" disabled={busy || membershipNumber.length === 0}>
            Look up
          </button>
        </p>
        <p className="lookup-hint">Use this if the member has the printed card.</p>
      </form>
      </div>

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

// ── Screen 10: member found, record a redemption ─────────────────────────

function MemberFound({ resolved, onDone }: { resolved: ResolvedMember; onDone: () => void }) {
  const [benefitId, setBenefitId] = useState('');
  const [partySize, setPartySize] = useState('');
  const [billAmount, setBillAmount] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // R8: generated once per attempt, so a double-click or a retry after a
  // dropped connection resolves to the same redemption rather than two.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const benefit: Entitlement | undefined = resolved.entitlements.find((b) => b.id === benefitId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const result = await api.record({
        verificationSession: resolved.verificationSession,
        memberId: resolved.member.id,
        benefitId,
        ...(partySize ? { partySize: Number(partySize) } : {}),
        // Entered in whole currency, stored in minor units as an integer —
        // never a float anywhere in the path.
        ...(billAmount ? { billAmountMinor: Math.round(Number(billAmount) * 100) } : {}),
        idempotencyKey,
      });

      // The confirmation states the exact second the server recorded it. Staff
      // read this back to the guest, and it is the same value the member sees
      // in their own history and the administrator sees in the export — one
      // moment, quoted identically in three places, so a later dispute has a
      // single fact to turn on.
      //
      // On a retry this deliberately shows the original time rather than now:
      // the second submission created nothing, and dating it to the retry would
      // be a lie about when the discount was given.
      const at = formatTimeOfDay(result.occurredAt);
      setMessage(result.idempotent ? `Already recorded at ${at}.` : `Recorded at ${at}.`);
      setIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      // The server's message carries the actual limit, read from the benefit
      // row — so a changed cap needs no change here.
      setError(cause instanceof Error ? cause.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {/* Screen 10 note 1: validity is stated before anything else. A
          suspended membership must be obvious at a glance, before staff begin
          applying a discount. */}
      <div className="verdict" data-valid={resolved.member.valid}>
        <span className="verdict-name">{resolved.member.fullName}</span>
        {/* The word, a glyph and the border weight all carry the state, so it
            survives greyscale and colour-blindness. */}
        <span className="verdict-state">{resolved.member.valid ? 'Valid' : 'Not valid'}</span>
        <span className="verdict-meta">
          {resolved.member.memberNumber} · {resolved.member.status} · Member since{' '}
          {/* A join date, not an event — the clock time would be noise. */}
          {formatDate(resolved.member.joinedAt)}
        </span>
      </div>

      {!resolved.member.valid ? (
        <p role="alert">
          This membership is not active. Do not apply a discount. No benefit can be recorded.
        </p>
      ) : (
        <form className="record-form" onSubmit={submit}>
          <p className="field">
            <label htmlFor="benefit">Benefit being used</label>
            <br />
            <select id="benefit" value={benefitId} onChange={(e) => setBenefitId(e.target.value)} required>
              <option value="">Choose a benefit</option>
              {resolved.entitlements.map((entitlement) => (
                <option key={entitlement.id} value={entitlement.id}>
                  {entitlement.title} — {entitlement.discountPct}% off
                </option>
              ))}
            </select>
          </p>

          {benefit ? (
            <>
              <p className="field">
                <label htmlFor="party">Number of guests</label>
                <br />
                <input
                  id="party"
                  type="number"
                  min="1"
                  value={partySize}
                  onChange={(e) => setPartySize(e.target.value)}
                  // Screen 10 note 2: party size is a required field, not a
                  // note — two benefits carry hard caps, and without it the
                  // limits are unenforceable.
                  required={benefit.maxGuests !== null || benefit.minGuests !== null}
                />
              </p>
              {/* The limits come from the benefit row the server returned.
                  Shown before the party-size field is filled in, so the cap is
                  known rather than discovered by being rejected. */}
              <div className="benefit-rules">
                {benefit.maxGuests !== null ? (
                  <p>
                    Maximum <strong>{benefit.maxGuests}</strong> guests for this benefit.
                  </p>
                ) : null}
                {benefit.minGuests !== null ? (
                  <p>
                    Minimum <strong>{benefit.minGuests}</strong> guests for this benefit.
                  </p>
                ) : null}
                <p>{benefit.terms}</p>
              </div>
            </>
          ) : null}

          <p className="field">
            <label htmlFor="bill">Bill amount before discount (optional)</label>
            <br />
            <input
              id="bill"
              type="number"
              min="0"
              step="0.01"
              value={billAmount}
              onChange={(e) => setBillAmount(e.target.value)}
            />
          </p>

          <p>
            <button type="submit" disabled={busy || benefitId.length === 0}>
              Confirm and record
            </button>
          </p>
        </form>
      )}

      {/* Screen 10 note 5: recent use is shown to staff, so a member
          exceeding a reasonable pattern is visible at the counter rather than
          discovered in a report months later. */}
      <h3>Recent use at this outlet</h3>
      {resolved.recentUse.length === 0 ? (
        <p>Nothing recorded here yet.</p>
      ) : (
        <ul className="recent">
          {resolved.recentUse.map((row) => (
            <li key={row.id}>
              {row.benefit.title} · {row.outlet.name}
              {row.partySize !== null ? ` · ${row.partySize} guests` : ''} ·{' '}
              {/* To the second: "twice today" is the pattern staff are watching
                  for here, and two entries showing only a date look identical. */}
              {formatTimestamp(row.occurredAt)}
            </li>
          ))}
        </ul>
      )}

      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      <p className="till-note">
        {/* Screen 10 note 4: the system records; it does not discount. The
            discount is applied on the hotel's existing till exactly as today. */}
        The discount is applied on the till as usual. This records that it happened.
      </p>

      <p>
        <button type="button" className="next-guest" onClick={onDone}>
          Done — next guest
        </button>
      </p>
    </section>
  );
}
