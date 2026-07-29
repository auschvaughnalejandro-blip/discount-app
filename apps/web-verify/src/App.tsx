import { useState } from 'react';

import { api, clearToken, setToken, type Entitlement, type ResolvedMember } from './api.js';

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
      <p>Sign in with your own account.</p>

      <form onSubmit={submit}>
        <p>
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
        <p>
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
      <h2>Scan member code</h2>
      {/* A camera-based scanner is presentation work, out of scope at this
          stage. The payload a scanner would read is pasted instead; the
          server treats both identically. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup({ payload });
        }}
      >
        <p>
          <label htmlFor="payload">Scanned code</label>
          <br />
          <input id="payload" value={payload} onChange={(e) => setPayload(e.target.value)} />
        </p>
        <p>
          <button type="submit" disabled={busy || payload.length === 0}>
            Look up scanned code
          </button>
        </p>
      </form>

      <h2>Or enter membership number</h2>
      {/* Screen 9 note 2: many members present the printed card rather than
          the app, so typing the number must work as well as scanning. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup({ membershipNumber });
        }}
      >
        <p>
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
        <p>Use this if the member has the printed card.</p>
      </form>

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

      setMessage(result.idempotent ? 'Already recorded.' : 'Recorded.');
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
      <h2>
        {resolved.member.fullName} — {resolved.member.valid ? 'Valid' : 'NOT VALID'}
      </h2>
      <p>
        {resolved.member.memberNumber} · {resolved.member.status} · Member since{' '}
        {new Date(resolved.member.joinedAt).toLocaleDateString()}
      </p>

      {!resolved.member.valid ? (
        <p role="alert">
          This membership is not active. Do not apply a discount. No benefit can be recorded.
        </p>
      ) : (
        <form onSubmit={submit}>
          <p>
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
              <p>
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
              {/* The limits come from the benefit row the server returned. */}
              {benefit.maxGuests !== null ? (
                <p>Maximum {benefit.maxGuests} guests for this benefit.</p>
              ) : null}
              {benefit.minGuests !== null ? (
                <p>Minimum {benefit.minGuests} guests for this benefit.</p>
              ) : null}
              <p>{benefit.terms}</p>
            </>
          ) : null}

          <p>
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
        <ul>
          {resolved.recentUse.map((row) => (
            <li key={row.id}>
              {row.benefit.title} · {row.outlet.name}
              {row.partySize !== null ? ` · ${row.partySize} guests` : ''} ·{' '}
              {new Date(row.occurredAt).toLocaleDateString()}
            </li>
          ))}
        </ul>
      )}

      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      <p>
        {/* Screen 10 note 4: the system records; it does not discount. The
            discount is applied on the hotel's existing till exactly as today. */}
        The discount is applied on the till as usual. This records that it happened.
      </p>

      <p>
        <button type="button" onClick={onDone}>
          Done — next guest
        </button>
      </p>
    </section>
  );
}
