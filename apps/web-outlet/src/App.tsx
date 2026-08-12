import { useCallback, useEffect, useRef, useState } from 'react';

import { formatTimeOfDay, formatTimestamp } from '@pgp/ui/format';

import {
  ApiError,
  api,
  clearTokens,
  idempotencyKey,
  isSignedIn,
  logout,
  resumeSession,
  type Outlet,
  type QueuedRequest,
  type ResolvedMember,
} from './api.js';
import { Scanner } from './Scanner.js';

/**
 * The outlet screen. One device, one outlet, two things to do.
 *
 * **Coming up** is the list of guests who told this outlet they were on their way.
 * Staff confirm one when they arrive, or mark it not used when they don't. That
 * list is also the Messages tab — the notice *is* the message, so there is nothing
 * to reconcile between the two.
 *
 * **Look up a card** is for a guest who never opened the app: scan the code on the
 * back of their card, or type their membership number, then record what they were
 * given.
 *
 * Neither grants anything. The guest is entitled to every published benefit
 * already; this screen records what was actually given, which is a different act.
 */

type Tab = 'queue' | 'lookup' | 'history';

export function App() {
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [resuming, setResuming] = useState(true);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [tab, setTab] = useState<Tab>('queue');
  // React StrictMode re-runs effects in development. A refresh rotates its token,
  // so session resumption must start only once.
  const authStarted = useRef(false);

  /** Resume the device's cookie session before rendering the sign-in screen. */
  useEffect(() => {
    if (authStarted.current) return;
    authStarted.current = true;

    void resumeSession()
      .then(async (resumed) => {
        if (!resumed) return;
        const { outlet: mine } = await api.me();
        setOutlet(mine);
        setSignedIn(true);
      })
      .catch(() => {
        clearTokens();
        setSignedIn(false);
      })
      .finally(() => setResuming(false));
  }, []);

  // Pick the outlet name back up after a refresh-driven reload of the screen.
  useEffect(() => {
    if (resuming || !signedIn || outlet !== null) return;
    void api
      .me()
      .then(({ outlet: mine }) => setOutlet(mine))
      .catch(() => {
        clearTokens();
        setSignedIn(false);
      });
  }, [resuming, signedIn, outlet]);

  async function signInWithDeviceToken(event: React.FormEvent) {
    event.preventDefault();
    const token = deviceToken.trim();
    if (token === '') return;

    // Refuse the wrong credential shape before sending it to a uniform 401.
    if (!token.startsWith('pgo_')) {
      setSignInError('Device login tokens start with pgo_. Issue one from Admin → Outlets.');
      return;
    }

    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await api.signInWithToken(token);
      setDeviceToken('');
      setOutlet(result.outlet);
      setSignedIn(true);
    } catch (cause) {
      setSignInError(
        cause instanceof Error ? cause.message : 'That device token was not accepted.',
      );
    } finally {
      setSigningIn(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
      setSignInError(null);
    } catch {
      // Local access is still cleared by `logout`'s finally block. Be honest
      // that the server could not revoke the cookie rather than failing with an
      // unhandled promise while appearing to have completed normally.
      setSignInError(
        'The server could not confirm sign-out. When the connection returns, reload and sign out again.',
      );
    } finally {
      setSignedIn(false);
      setOutlet(null);
      setTab('queue');
      setSigningOut(false);
    }
  }

  if (resuming) {
    return (
      <main className="shell shell-centred">
        <p className="notice" role="status">
          Opening outlet…
        </p>
      </main>
    );
  }

  if (!signedIn) {
    return (
      <main className="shell shell-centred">
        <div className="signin">
          <p className="eyebrow">Privilege Guest</p>
          <h1>Outlet</h1>
          <p className="lede">
            Paste the private login token assigned to this device. It opens only the outlet the
            hotel linked it to.
          </p>
          <form className="token-signin" onSubmit={(event) => void signInWithDeviceToken(event)}>
            <label className="field" htmlFor="device-token">
              <span>Device login token</span>
              <input
                id="device-token"
                type="password"
                value={deviceToken}
                onChange={(event) => {
                  setDeviceToken(event.target.value);
                  setSignInError(null);
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="pgo_…"
                aria-describedby="device-token-hint"
                required
                autoFocus
              />
              <small id="device-token-hint" className="token-hint">
                Device tokens start with <code>pgo_</code>.
              </small>
            </label>
            <button
              type="submit"
              className="btn"
              disabled={signingIn || deviceToken.trim() === ''}
            >
              {signingIn ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          {signInError ? (
            <p className="notice notice-error" role="alert">
              {signInError}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="head">
        <div>
          <p className="eyebrow">Privilege Guest</p>
          <h1>{outlet?.name ?? '…'}</h1>
        </div>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>

      <nav className="tabs" aria-label="Sections">
        {(
          [
            ['queue', 'Coming up'],
            ['lookup', 'Look up a card'],
            ['history', 'Earlier today'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="tab"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'queue' ? <Queue /> : null}
      {tab === 'lookup' ? <Lookup /> : null}
      {tab === 'history' ? <History /> : null}
    </main>
  );
}

// ── Coming up ──────────────────────────────────────────────────────────────

function Queue() {
  const [rows, setRows] = useState<QueuedRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { requests } = await api.requests('SENT');
      setRows(requests);
      setError(null);
    } catch (cause) {
      // A transient failure must not blank a list somebody is working from.
      if (rows === null) {
        setError(cause instanceof Error ? cause.message : 'Could not load the list.');
      }
    }
  }, [rows]);

  useEffect(() => {
    void load();
    // Fifteen seconds. Short enough that a guest who announced themselves at the
    // door appears before they reach the counter, long enough that a screen left
    // on all evening is not hammering the API.
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
    // `load` closes over `rows`, and re-subscribing on every poll would restart
    // the interval forever. The identity that matters here is "mounted".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm(row: QueuedRequest, partySize: number | undefined) {
    setBusyId(row.id);
    try {
      // One key per attempt, reused if this same attempt is retried — a fresh key
      // per click would record two visits for one guest on a double tap.
      await api.confirm(row.id, {
        ...(partySize !== undefined ? { partySize } : {}),
        idempotencyKey: idempotencyKey(),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record that.');
    } finally {
      setBusyId(null);
    }
  }

  async function markNotUsed(row: QueuedRequest) {
    setBusyId(row.id);
    try {
      await api.notUsed(row.id, 'Guest did not arrive');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update that.');
    } finally {
      setBusyId(null);
    }
  }

  if (rows === null) {
    return <p className="notice">Loading…</p>;
  }

  return (
    <section className="panel">
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="empty">
          Nobody has told you they are coming. Guests can also just turn up — use{' '}
          <strong>Look up a card</strong>.
        </p>
      ) : (
        <ul className="cards">
          {rows.map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              busy={busyId === row.id}
              onConfirm={(partySize) => void confirm(row, partySize)}
              onNotUsed={() => void markNotUsed(row)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestCard({
  row,
  busy,
  onConfirm,
  onNotUsed,
}: {
  row: QueuedRequest;
  busy: boolean;
  onConfirm: (partySize: number | undefined) => void;
  onNotUsed: () => void;
}) {
  // Required when the benefit constrains party size, and the server refuses
  // without it — so the field is present exactly when it is needed rather than
  // always, which would ask for a number nobody has to give.
  const needsPartySize = row.benefit.maxGuests !== null || row.benefit.minGuests !== null;
  const [partySize, setPartySize] = useState('');

  return (
    <li className="card" data-new={row.isNew ? 'true' : undefined}>
      <div className="card-head">
        {/* The membership number, because that is what the card in their hand
            shows. The name is deliberately not sent to this screen (§9). */}
        <span className="member-number">{row.member.memberNumber}</span>
        {/* The shared formatter, not a local `toLocale…` call. Times here are read
            to the second on purpose: two notices from the same guest minutes apart
            have to be tellable apart, and `timeStyle: 'short'` would drop exactly
            the digits that do it. `client-invariants.test.ts` holds this. */}
        <span className="card-time">{formatTimeOfDay(row.requestedAt)}</span>
      </div>

      <p className="card-benefit">
        {row.benefit.title} · <strong>{row.benefit.discountPct}% off</strong>
      </p>

      {row.note ? <p className="card-note">“{row.note}”</p> : null}

      <details className="card-terms">
        <summary>Conditions</summary>
        {/* Verbatim from the API. This is where a disagreement at the counter gets
            prevented, so it is neither summarised nor truncated. */}
        <p>{row.benefit.terms}</p>
      </details>

      {needsPartySize ? (
        <label className="field">
          <span>
            Guests
            {row.benefit.maxGuests !== null ? ` (max ${row.benefit.maxGuests})` : ''}
            {row.benefit.minGuests !== null ? ` (min ${row.benefit.minGuests})` : ''}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={row.benefit.minGuests ?? 1}
            {...(row.benefit.maxGuests !== null ? { max: row.benefit.maxGuests } : {})}
            value={partySize}
            onChange={(event) => setPartySize(event.target.value)}
          />
        </label>
      ) : null}

      <div className="card-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || (needsPartySize && partySize === '')}
          onClick={() => onConfirm(partySize === '' ? undefined : Number(partySize))}
        >
          {busy ? 'Recording…' : 'Discount given'}
        </button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onNotUsed}>
          Did not come
        </button>
      </div>
    </li>
  );
}

// ── Look up a card ─────────────────────────────────────────────────────────

function Lookup() {
  const [resolved, setResolved] = useState<ResolvedMember | null>(null);
  const [membershipNumber, setMembershipNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<string | null>(null);
  // A response for the number that was in the box a moment ago must never put
  // that guest back on screen after staff have begun typing a different one.
  const lookupAttempt = useRef(0);
  // Read by camera callbacks as well as the current render. A scanner started
  // before recording must not replace the visible guest mid-write, and the same
  // guard collapses a rapid double-tap before React can disable the button.
  const recordingRef = useRef(false);
  const busy = lookingUp || recording;

  async function resolve(input: { payload?: string; membershipNumber?: string }) {
    if (recordingRef.current) return;

    const attempt = ++lookupAttempt.current;
    setLookingUp(true);
    setError(null);
    setRecorded(null);
    // Do not leave the previous guest visible while a new card/number is being
    // resolved. That creates exactly the wrong-person recording trap this form
    // needs to prevent.
    setResolved(null);
    try {
      const next = await api.resolve(input);
      if (attempt !== lookupAttempt.current) return;
      setResolved(next);
      // Once the number has resolved, the prominent source of truth is the
      // returned name + membership number below, not stale editable text.
      setMembershipNumber('');
    } catch (cause) {
      if (attempt !== lookupAttempt.current) return;
      setResolved(null);
      setError(
        cause instanceof ApiError && cause.status === 404
          ? 'No member matches that. Check the number on the card.'
          : cause instanceof Error
            ? cause.message
            : 'Could not look that up.',
      );
    } finally {
      if (attempt === lookupAttempt.current) setLookingUp(false);
    }
  }

  async function record(benefitId: string, partySize: number | undefined) {
    if (resolved === null || recordingRef.current) return;
    recordingRef.current = true;
    setRecording(true);
    setError(null);
    try {
      await api.recordScan({
        verificationSession: resolved.verificationSession,
        memberId: resolved.member.id,
        benefitId,
        ...(partySize !== undefined ? { partySize } : {}),
        idempotencyKey: idempotencyKey(),
      });
      setRecorded(benefitId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record that.');
    } finally {
      recordingRef.current = false;
      setRecording(false);
    }
  }

  return (
    <section className="panel">
      <Scanner onScan={(payload) => void resolve({ payload })} />

      <form
        className="lookup-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (membershipNumber.trim()) {
            void resolve({ membershipNumber: membershipNumber.trim() });
          }
        }}
      >
        <label className="field">
          <span>Or type the membership number</span>
          <input
            value={membershipNumber}
            onChange={(event) => {
              // Editing the number means the resolved guest is no longer the
              // subject of this form. Clear it synchronously and invalidate any
              // lookup response still travelling back from the server.
              lookupAttempt.current += 1;
              setLookingUp(false);
              setMembershipNumber(event.target.value);
              setResolved(null);
              setRecorded(null);
              setError(null);
            }}
            placeholder="Enter number from card"
            autoComplete="off"
            spellCheck={false}
            disabled={recording}
          />
        </label>
        <button type="submit" className="btn btn-outline" disabled={busy}>
          Look up
        </button>
      </form>

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {resolved === null ? null : (
        <div className="resolved">
          <div className="resolved-head">
            {/* The name is here, and only here in the whole outlet surface. Staff
                have to be able to tell the card belongs to the person holding it —
                that is what a counter check is for. */}
            <strong>{resolved.member.fullName}</strong>
            <span className="member-number">{resolved.member.memberNumber}</span>
          </div>

          {resolved.recentAtThisOutlet.length > 0 ? (
            <details className="card-terms">
              <summary>Recent visits here ({resolved.recentAtThisOutlet.length})</summary>
              <ul className="recent">
                {resolved.recentAtThisOutlet.map((visit) => (
                  <li key={visit.id}>
                    {formatTimestamp(visit.occurredAt)} · {visit.benefit.title}
                    {visit.partySize === null ? '' : ` · ${visit.partySize} guests`}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <ul className="cards">
            {resolved.benefits.map((benefit) => (
              <BenefitRow
                key={benefit.id}
                benefit={benefit}
                memberNumber={resolved.member.memberNumber}
                busy={busy}
                done={recorded === benefit.id}
                onRecord={(partySize) => void record(benefit.id, partySize)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function BenefitRow({
  benefit,
  memberNumber,
  busy,
  done,
  onRecord,
}: {
  benefit: ResolvedMember['benefits'][number];
  memberNumber: string;
  busy: boolean;
  done: boolean;
  onRecord: (partySize: number | undefined) => void;
}) {
  const needsPartySize = benefit.maxGuests !== null || benefit.minGuests !== null;
  const [partySize, setPartySize] = useState('');

  return (
    <li className="card">
      <p className="card-benefit">
        {benefit.title} · <strong>{benefit.discountPct}% off</strong>
      </p>

      <details className="card-terms">
        <summary>Conditions</summary>
        <p>{benefit.terms}</p>
      </details>

      {benefit.openRequestId !== null ? (
        // Confirming the existing notice is what links the visit to what the guest
        // announced. Recording separately would leave the notice open and produce a
        // second, unattached row for the same evening.
        <p className="notice">
          This guest already told you they were coming — confirm it under{' '}
          <strong>Coming up</strong> instead.
        </p>
      ) : (
        <>
          {needsPartySize ? (
            <label className="field">
              <span>
                Guests
                {benefit.maxGuests !== null ? ` (max ${benefit.maxGuests})` : ''}
                {benefit.minGuests !== null ? ` (min ${benefit.minGuests})` : ''}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={benefit.minGuests ?? 1}
                {...(benefit.maxGuests !== null ? { max: benefit.maxGuests } : {})}
                value={partySize}
                onChange={(event) => setPartySize(event.target.value)}
              />
            </label>
          ) : null}

          <button
            type="button"
            className="btn"
            disabled={busy || done || (needsPartySize && partySize === '')}
            onClick={() => onRecord(partySize === '' ? undefined : Number(partySize))}
          >
            {done
              ? `Recorded for ${memberNumber}`
              : busy
                ? `Recording for ${memberNumber}…`
                : `Record discount for ${memberNumber}`}
          </button>
        </>
      )}
    </li>
  );
}

// ── Earlier today ──────────────────────────────────────────────────────────

function History() {
  const [rows, setRows] = useState<QueuedRequest[] | null>(null);

  useEffect(() => {
    void Promise.all([api.requests('FULFILLED'), api.requests('NOT_USED')])
      .then(([used, unused]) =>
        setRows(
          [...used.requests, ...unused.requests].sort((a, b) =>
            (b.closedAt ?? '').localeCompare(a.closedAt ?? ''),
          ),
        ),
      )
      .catch(() => setRows([]));
  }, []);

  if (rows === null) return <p className="notice">Loading…</p>;
  if (rows.length === 0) return <p className="empty">Nothing closed out yet.</p>;

  return (
    <section className="panel">
      <ul className="cards">
        {rows.map((row) => (
          <li key={row.id} className="card card-quiet">
            <div className="card-head">
              <span className="member-number">{row.member.memberNumber}</span>
              <span className="card-time">
                {row.status === 'FULFILLED' ? 'Given' : 'Not used'}
              </span>
            </div>
            <p className="card-benefit">{row.benefit.title}</p>
            {row.closedReason ? <p className="card-note">{row.closedReason}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
