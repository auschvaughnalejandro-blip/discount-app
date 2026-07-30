import { useCallback, useEffect, useState } from 'react';
import QRCode from 'react-qr-code';

import { formatDate, formatTimestamp } from '@pgp/ui/format';

import { api, clearTokens, setTokens, type Benefit, type IdentityCode, type MemberProfile, type Redemption } from './api.js';

// Order matters: the shared foundation defines the tokens, theme.css overrides
// the palette for this surface, layout.css builds the structure on top.
import '@pgp/ui/foundation.css';
import './theme.css';
import './layout.css';
import './digital-card.css';

/**
 * The member app (wireframes screens 1–8).
 *
 * Semantic HTML, now styled. Stages 10–14 deliberately carried no CSS at all
 * (BUILD-PLAN §0 rule 1, "ugly is correct at this stage"); Stage 17 lifted that
 * and added `theme.css` and `layout.css` over the shared `@pgp/ui` foundation.
 *
 * The markup itself barely changed, which was the payoff for writing it
 * correctly the first time: real `<button>` elements, labels bound to inputs,
 * `role="alert"` on errors and `aria-current` on the active tab all became
 * styling hooks. Where a class was added it names a thing (`.pass`, `.offer`),
 * never an appearance.
 *
 * Every benefit value on screen comes from the API (R14). Search for a
 * percentage in this directory and you will not find one — there is a test.
 */

type Tab = 'explore' | 'offers' | 'search' | 'profile';

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [tab, setTab] = useState<Tab>('explore');
  const [showCard, setShowCard] = useState(false);
  const [selectedBenefit, setSelectedBenefit] = useState<string | null>(null);

  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([api.me(), api.benefits()]);
      setProfile(me);
      setBenefits(list.benefits);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your membership.');
    }
  }, []);

  useEffect(() => {
    if (signedIn) {
      void load();
    }
  }, [signedIn, load]);

  if (!signedIn) {
    return <Activate onSignedIn={() => setSignedIn(true)} />;
  }

  if (showCard) {
    return <DigitalCard profile={profile} onClose={() => setShowCard(false)} />;
  }

  if (selectedBenefit) {
    const benefit = benefits.find((b) => b.key === selectedBenefit);
    return (
      <BenefitDetail
        benefit={benefit}
        onBack={() => setSelectedBenefit(null)}
        onShowCard={() => setShowCard(true)}
      />
    );
  }

  return (
    <main>
      {error ? <p role="alert">{error}</p> : null}

      {tab === 'explore' ? (
        <Explore
          profile={profile}
          benefits={benefits}
          onShowCard={() => setShowCard(true)}
          onSelect={setSelectedBenefit}
        />
      ) : null}

      {tab === 'offers' ? <Offers benefits={benefits} onSelect={setSelectedBenefit} /> : null}
      {tab === 'search' ? <Search benefits={benefits} onSelect={setSelectedBenefit} /> : null}
      {tab === 'profile' ? (
        <Profile
          profile={profile}
          onShowCard={() => setShowCard(true)}
          onSignOut={() => {
            clearTokens();
            setSignedIn(false);
            setProfile(null);
            setBenefits([]);
          }}
        />
      ) : null}

      <nav aria-label="Sections">
        <ul>
          {(['explore', 'offers', 'search', 'profile'] as Tab[]).map((name) => (
            <li key={name}>
              <button type="button" onClick={() => setTab(name)} aria-current={tab === name}>
                {name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

// ── Screens 1–2: claim and verify ────────────────────────────────────────

function Activate({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'claim' | 'signin'>('claim');
  const [step, setStep] = useState<'identify' | 'verify'>('identify');
  const [claimCode, setClaimCode] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [email, setEmail] = useState('');
  // Screen 2 note 2: per channel, and unticked by default. Qatar's data
  // protection law requires explicit prior consent for direct electronic
  // marketing, so a pre-ticked box would not be consent at all.
  const [consentEmail, setConsentEmail] = useState(false);
  const [consentSms, setConsentSms] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitIdentify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'claim') {
        await api.claimRequestOtp(claimCode, phone);
      } else {
        await api.signInRequestOtp(phone);
      }
      setStep('verify');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function submitVerify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const tokens =
        mode === 'claim'
          ? await api.claimComplete({
              claimCode,
              phone,
              otp,
              ...(email ? { email } : {}),
              consent: { email: consentEmail, sms: consentSms },
            })
          : await api.signInVerifyOtp(phone, otp);

      setTokens(tokens);
      onSignedIn();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Privilege Guest</h1>

      {step === 'identify' ? (
        <form onSubmit={submitIdentify}>
          {mode === 'claim' ? (
            <>
              <p className="activate-lede">Enter the code from your invitation letter to activate your membership.</p>
              <p className="field">
                <label htmlFor="claim-code">Invitation code</label>
                <br />
                <input
                  id="claim-code"
                  value={claimCode}
                  onChange={(e) => setClaimCode(e.target.value)}
                  required
                  autoComplete="off"
                />
              </p>
            </>
          ) : (
            <p className="activate-lede">Enter your mobile number to sign in.</p>
          )}

          <p className="field">
            <label htmlFor="phone">Mobile number</label>
            <br />
            <input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </p>

          <p>
            <button type="submit" disabled={busy}>
              {mode === 'claim' ? 'Activate membership' : 'Send code'}
            </button>
          </p>

          {/* Screen 1 note 4: exclusivity stated plainly. */}
          <p className="exclusivity">Membership is by invitation only.</p>

          <p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMode(mode === 'claim' ? 'signin' : 'claim');
                setMessage(null);
              }}
            >
              {mode === 'claim' ? 'Already activated? Sign in' : 'Have an invitation code?'}
            </button>
          </p>
        </form>
      ) : (
        <form onSubmit={submitVerify}>
          <h2>Enter the code we sent</h2>
          <p className="activate-lede">Sent to {phone}</p>

          <p className="field">
            <label htmlFor="otp">Verification code</label>
            <br />
            <input
              id="otp"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </p>

          {mode === 'claim' ? (
            <>
              <fieldset>
                <legend>Confirm your details</legend>
                {/* Screen 2 note 1: the name is pre-filled by the
                    administrator, not asked here — the member confirms it
                    once they are through. */}
                <p className="field">
                  <label htmlFor="email">Email — for reservations and updates</label>
                  <br />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </p>
              </fieldset>

              <fieldset>
                <legend>Notifications</legend>
                <p>
                  <label>
                    <input
                      type="checkbox"
                      checked={consentEmail}
                      onChange={(e) => setConsentEmail(e.target.checked)}
                    />{' '}
                    Notify me by email
                  </label>
                </p>
                <p>
                  <label>
                    <input
                      type="checkbox"
                      checked={consentSms}
                      onChange={(e) => setConsentSms(e.target.checked)}
                    />{' '}
                    Notify me by SMS
                  </label>
                </p>
              </fieldset>
            </>
          ) : null}

          <p>
            <button type="submit" disabled={busy}>
              Continue
            </button>
          </p>
          <p>
            <button type="button" className="back" onClick={() => setStep('identify')}>
              Back
            </button>
          </p>
        </form>
      )}

      {message ? <p role="alert">{message}</p> : null}
    </main>
  );
}

// ── Screen 3: explore ────────────────────────────────────────────────────

function Explore({
  profile,
  benefits,
  onShowCard,
  onSelect,
}: {
  profile: MemberProfile | null;
  benefits: Benefit[];
  onShowCard: () => void;
  onSelect: (key: string) => void;
}) {
  return (
    <section>
      <h1>Welcome back</h1>
      {profile ? (
        <p className="identity">
          {/* Screen 3 note 1: the membership number is prominent — it is the
              member's identity and the thing staff ask for. */}
          <span>
            Membership <strong>{profile.memberNumber}</strong>
          </span>
          <button type="button" className="text-button" onClick={onShowCard}>
            Show card
          </button>
        </p>
      ) : (
        <p>Loading…</p>
      )}

      <h2>Your benefits</h2>
      {/* Screen 3 note 5: no points, no balance, no progress bar. Nothing is
          earned, so there is nothing to track. */}
      <ul className="card-list">
        {benefits.map((benefit) => (
          <li key={benefit.key}>
            <button type="button" onClick={() => onSelect(benefit.key)}>
              <span>
                <span className="card-title">{benefit.title}</span>
                <span className="card-discount">{benefit.discountPct}% off</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Screen 4: offers ─────────────────────────────────────────────────────

function Offers({ benefits, onSelect }: { benefits: Benefit[]; onSelect: (key: string) => void }) {
  return (
    <section>
      <h1>Your benefits</h1>
      <p>Every privilege included with your membership.</p>

      {/* Screen 4 note 1: everything visible without tapping. The paper sheet
          showed all five at once; hiding terms behind a tap is a downgrade. */}
      <ul className="offer-list">
        {benefits.map((benefit) => (
          <li key={benefit.key} className="offer">
            <h2>
              {benefit.title} <span className="offer-pct">{benefit.discountPct}%</span>
            </h2>
            {benefit.secondaryLabel && benefit.secondaryPct ? (
              <p>
                {benefit.secondaryLabel}: <span className="offer-pct">{benefit.secondaryPct}%</span>
              </p>
            ) : null}
            {benefit.childRules ? (
              <ul>
                {Object.entries(benefit.childRules).map(([band, pct]) => (
                  <li key={band}>
                    Children {band}: <span className="offer-pct">{pct}%</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {/* Screen 4 note 2: party-size limits on the list, not buried —
                precisely the detail that causes an awkward conversation. */}
            {benefit.maxGuests !== null ? (
              <p className="offer-limit">Maximum {benefit.maxGuests} guests</p>
            ) : null}
            {benefit.minGuests !== null ? (
              <p className="offer-limit">Minimum {benefit.minGuests} guests</p>
            ) : null}
            <button type="button" onClick={() => onSelect(benefit.key)}>
              Details
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Screen 5: benefit detail ─────────────────────────────────────────────

function BenefitDetail({
  benefit,
  onBack,
  onShowCard,
}: {
  benefit: Benefit | undefined;
  onBack: () => void;
  onShowCard: () => void;
}) {
  if (!benefit) {
    return (
      <main>
        <p>That benefit is not available.</p>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </main>
    );
  }

  return (
    <main>
      <button type="button" className="back" onClick={onBack}>
        Back to benefits
      </button>

      <h1>{benefit.title}</h1>
      <p className="detail-pct">{benefit.discountPct}% off</p>
      {benefit.secondaryLabel && benefit.secondaryPct ? (
        <p>
          <span className="offer-pct">{benefit.secondaryPct}%</span> off {benefit.secondaryLabel}
        </p>
      ) : null}

      <h2>Conditions</h2>
      {/* Screen 5 note 2: conditions in full — this is where a dispute at the
          spa reception gets prevented. */}
      <p className="detail-terms">{benefit.terms}</p>

      {/* Screen 5 note 1: tap-to-call is the highest-value small addition in
          the build. Three benefits need three different numbers, currently on
          a sheet that gets lost. */}
      {benefit.reservationPhone ? (
        <a className="call-link" href={`tel:${benefit.reservationPhone.replace(/\s/g, '')}`}>
          Call to reserve · {benefit.reservationPhone}
        </a>
      ) : null}

      <p>
        <button type="button" onClick={onShowCard}>
          Show my card
        </button>
      </p>

      <p>Benefits are subject to change. You will be notified of significant changes.</p>
    </main>
  );
}

// ── Screen 6: search ─────────────────────────────────────────────────────

function Search({ benefits, onSelect }: { benefits: Benefit[]; onSelect: (key: string) => void }) {
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  // Screen 6 note 2: searches inside terms, not only titles. "Kids" and
  // "parking" are what people actually type, and neither is a category name.
  const results = needle
    ? benefits.filter((benefit) =>
        [benefit.title, benefit.category, benefit.terms, benefit.secondaryLabel ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : [];

  return (
    <section>
      <h1>Search</h1>
      <p className="field">
        <label htmlFor="search">Search benefits, outlets…</label>
        <br />
        <input id="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </p>

      {needle ? (
        <>
          <h2>Results for “{query}”</h2>
          {results.length === 0 ? (
            <p>Nothing matched.</p>
          ) : (
            <ul className="card-list">
              {results.map((benefit) => (
                <li key={benefit.key}>
                  <button type="button" onClick={() => onSelect(benefit.key)}>
                    <span>
                      <span className="card-title">{benefit.title}</span>
                      <span className="card-discount">{benefit.discountPct}% off</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p>Type to search your benefits.</p>
      )}
    </section>
  );
}

// ── Screen 7: digital card ───────────────────────────────────────────────

function DigitalCard({ profile, onClose }: { profile: MemberProfile | null; onClose: () => void }) {
  const [code, setCode] = useState<IdentityCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const next = await api.identityCode();
        if (!cancelled) {
          setCode(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load your card.');
        }
      }
    }

    void refresh();

    // Screen 7 note 2: the payload rotates. These are high-value benefits, so
    // a static code that could be screenshotted and forwarded would be worth
    // real money. Regenerating well inside the server's freshness window means
    // what is on screen is always current.
    const timer = setInterval(() => void refresh(), 60_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /**
   * Hold the screen awake while the card is open.
   *
   * A phone that has dimmed to save battery is the most common reason a QR
   * fails to scan — the symbol is still perfectly rendered, there is simply not
   * enough light coming off the panel for the camera. Web pages cannot set
   * brightness, but they can stop the panel dimming and sleeping, which covers
   * most of it. Nothing depends on this working: unsupported browsers and a
   * refused request both just carry on.
   */
  useEffect(() => {
    interface WakeLockSentinel {
      release(): Promise<void>;
    }
    const wakeLock = (navigator as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } })
      .wakeLock;
    if (!wakeLock) {
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    void wakeLock
      .request('screen')
      .then((acquired) => {
        // The card may already have closed by the time this resolves.
        if (released) {
          void acquired.release();
          return;
        }
        sentinel = acquired;
      })
      .catch(() => {
        // Denied, or the document was not visible. Not worth surfacing.
      });

    return () => {
      released = true;
      void sentinel?.release();
    };
  }, []);

  return (
    <main className="card-screen">
      <button type="button" className="back" onClick={onClose}>
        Close
      </button>

      {/* The pass itself. One bordered object rather than a page of text, so a
          member of staff recognises it across a reception desk and treats it as
          equivalent to the plastic card. */}
      <div className="pass">
        <p className="pass-brand">Privilege Guest</p>

        {profile ? (
          <p>
            {/* Screen 7 note 3: name and number mirror the physical card, so
                staff recognise it instantly and the two are interchangeable. */}
            <span className="pass-name">{profile.fullName}</span>
            <br />
            <span className="pass-number">{profile.memberNumber}</span>
          </p>
        ) : null}
      </div>

      {error ? <p role="alert">{error}</p> : null}

      {code ? (
        <>
          <h2>Scan this</h2>
          {/* Error correction level M, not the library's default of L and not H.
              H adds roughly 30% more modules, which at this physical size makes
              each module smaller and so *harder* for a phone camera to resolve.
              H earns its keep on printed labels that get dirty; a backlit screen
              held 20cm from a lens is the easy case. The quiet zone comes from
              digital-card.css — this library renders modules edge to edge. */}
          <div className="qr">
            <QRCode
              value={code.payload}
              level="M"
              size={240}
              title={`Membership ${profile?.memberNumber ?? ''}`}
            />
          </div>
          <p className="pass-hint">Code refreshes automatically.</p>
          {/* Kept, but demoted: if the camera fails, staff can read or paste
              this instead. Screen 9 keeps a text path open for exactly this. */}
          <p className="pass-payload">
            <output>{code.payload}</output>
          </p>
        </>
      ) : (
        <p>Loading your card…</p>
      )}

      {/* Screen 7 note 1: the code identifies; it does not authorise. */}
      <p className="pass-hint">Present this to staff when using a benefit.</p>
    </main>
  );
}

// ── Screen 8: profile ────────────────────────────────────────────────────

function Profile({
  profile,
  onShowCard,
  onSignOut,
}: {
  profile: MemberProfile | null;
  onShowCard: () => void;
  onSignOut: () => void;
}) {
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [consent, setConsent] = useState(profile?.consent ?? {});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .redemptions()
      .then((result) => setRedemptions(result.redemptions))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Could not load your history.'),
      );
  }, []);

  useEffect(() => {
    if (profile) {
      setConsent(profile.consent);
    }
  }, [profile]);

  async function toggle(channel: 'email' | 'sms', granted: boolean) {
    try {
      // Screen 8 note 4: withdrawing consent takes effect immediately across
      // every channel — the server appends a new record and the newest wins.
      const result = await api.updateConsent({ [channel]: granted });
      setConsent(result.consent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
    }
  }

  return (
    <section>
      <h1>Profile</h1>

      {profile ? (
        <>
          <p>
            <strong>{profile.fullName}</strong>
            <br />
            {profile.memberNumber} · Member since {formatDate(profile.joinedAt)}
          </p>
          <p>
            <button type="button" onClick={onShowCard}>
              Show card
            </button>
          </p>
        </>
      ) : null}

      <h2>Benefits you have used</h2>
      {/* Screen 8 note 1: the substance of this screen. It answers "have I
          already used the spa discount this month" without a phone call. */}
      {redemptions.length === 0 ? (
        <p>You have not used a benefit yet.</p>
      ) : (
        <ul className="history">
          {redemptions.map((row) => (
            <li key={row.id}>
              <span className="history-benefit">
                {row.benefit.title}
                {row.reversesId ? (
                  <>
                    {' '}
                    <span className="badge" data-tone="warn">
                      reversed
                    </span>
                  </>
                ) : null}
              </span>
              <span className="history-meta">
                {row.outlet.name} · {row.benefit.discountPct}%
                {row.partySize !== null ? ` · ${row.partySize} guests` : ''}
                {' · '}
                {/* To the second, matching what staff confirmed at the counter.
                    This is the member's own record — "did I already use the spa
                    discount" is answered by a time, not just a day. */}
                {formatTimestamp(row.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Notifications</h2>
      {(['email', 'sms'] as const).map((channel) => {
        const current = consent[channel.toUpperCase()];
        return (
          <p key={channel}>
            <label>
              <input
                type="checkbox"
                checked={current?.granted ?? false}
                onChange={(e) => void toggle(channel, e.target.checked)}
              />{' '}
              Notify me by {channel}
            </label>
          </p>
        );
      })}

      {error ? <p role="alert">{error}</p> : null}

      <p>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </p>
    </section>
  );
}
