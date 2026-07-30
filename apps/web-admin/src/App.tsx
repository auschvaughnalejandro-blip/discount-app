import { useCallback, useEffect, useState } from 'react';

import { formatDate, formatTimestamp } from '@pgp/ui/format';

import {
  api,
  clearToken,
  setToken,
  type AdminBenefit,
  type BenefitGroup,
  type MemberRow,
  type ReportMember,
  type ReportSummary,
} from './api.js';
import { FigureValue, formatMinor, StatTile } from './Charts.js';


import '@pgp/ui/foundation.css';
import MfaSignIn from './MfaSignIn.js';
import Overview from './Overview.js';
import './theme.css';
import './layout.css';
/**
 * The admin dashboard (wireframes screens 11–14, D3–D5).
 *
 * Semantic HTML, styled since Stage 17 — this comment said "no styling" until
 * then, which was BUILD-PLAN §0 rule 1 and stopped being true two stages ago.
 *
 * The screen that matters is Benefits: the test of whether this project
 * delivered is that changing the F&B discount from 25% to 20% is a form field,
 * not a developer and a release (screen 14 note 1). `Overview` is where it
 * opens, and is the only screen here that measures rather than edits.
 */

type Section = 'overview' | 'members' | 'redemptions' | 'reports' | 'benefits';

/**
 * The rail, in the order these get looked at.
 *
 * Overview is first and is where the dashboard opens. It used to open on
 * `members` — a hundred-row table — which put the densest view in the product
 * ahead of the figures that say whether the programme is working.
 *
 * Labels are written out rather than derived from the id by CSS
 * `text-transform`, so a section can be named something other than its route
 * without the two drifting apart.
 */
const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'Headline figures and what needs attention' },
  { id: 'members', label: 'Members', hint: 'Create, suspend and reinstate memberships' },
  { id: 'redemptions', label: 'Redemptions', hint: 'The immutable log' },
  { id: 'reports', label: 'Reports', hint: 'Programme activity in detail' },
  { id: 'benefits', label: 'Benefits', hint: 'Discounts, caps and terms' },
];

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [section, setSection] = useState<Section>('overview');
  /**
   * Stage 19. A correct password no longer signs anyone in — it yields a
   * challenge, held here until a second factor is presented. §3 makes MFA
   * mandatory on every dashboard account "without exception", so there is no
   * branch from this state to the dashboard that skips MfaSignIn.
   */
  const [challenge, setChallenge] = useState<{
    challengeToken: string;
    stage: 'enroll' | 'verify';
  } | null>(null);

  if (!signedIn) {
    if (challenge) {
      return (
        <MfaSignIn
          challengeToken={challenge.challengeToken}
          stage={challenge.stage}
          onSignedIn={(accessToken) => {
            setToken(accessToken);
            setChallenge(null);
            setSignedIn(true);
          }}
        />
      );
    }
    return <SignIn onChallenge={setChallenge} onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <main>
      <header>
        <h1>Privilege Guest — Admin</h1>
        <nav aria-label="Sections">
          <ul>
            {SECTIONS.map(({ id, label, hint }) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setSection(id)}
                  aria-current={section === id}
                  title={hint}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <button
          type="button"
          onClick={() => {
            clearToken();
            setChallenge(null);
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </header>

      {section === 'overview' ? <Overview onNavigate={setSection} /> : null}
      {section === 'members' ? <Members /> : null}
      {section === 'redemptions' ? <Redemptions /> : null}
      {section === 'reports' ? <Reports /> : null}
      {section === 'benefits' ? <Benefits /> : null}
    </main>
  );
}

function SignIn({
  onChallenge,
  onSignedIn,
}: {
  onChallenge: (challenge: { challengeToken: string; stage: 'enroll' | 'verify' }) => void;
  onSignedIn: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await api.login(email, password);

      if (result.mfaRequired) {
        onChallenge({ challengeToken: result.challengeToken, stage: result.stage });
        return;
      }

      // Only reachable for a role that does not require a second factor. No
      // dashboard role qualifies, so in practice this is the defensive branch
      // rather than the normal one.
      setToken(result.accessToken);
      onSignedIn();
    } catch {
      setError('Those details were not accepted.');
    }
  }

  return (
    <main className="signin">
      <section className="signin-card">
      <h1>Privilege Guest — Admin</h1>
      <form onSubmit={submit}>
        <p className="field">
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </p>
        <p className="field">
          <label htmlFor="password">Password</label>
          <br />
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </p>
        <p>
          <button type="submit">Sign in</button>
        </p>
      </form>
      {/* Stage 19 closed Q5: the password is step one of two. The second
          factor is handled by MfaSignIn, which this hands off to. */}
      {error ? <p role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

// ── Screens 11 / D3: members ─────────────────────────────────────────────

function Members() {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [total, setTotal] = useState(0);
  const [fullName, setFullName] = useState('');
  const [issued, setIssued] = useState<{ memberNumber: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.members('?limit=100');
      setMembers(result.members);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load members.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const created = await api.createMember({ fullName });
      // Screen 11 note 1: "New member" replaces public signup — an
      // administrator creates the record and issues a code.
      setIssued({ memberNumber: created.memberNumber, code: created.claimCode.code });
      setFullName('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that member.');
    }
  }

  async function setStatus(id: string, suspend: boolean) {
    try {
      // Screen 11 / D4 note 6: suspend, never delete — deleting a member
      // destroys the redemption history the reporting depends on.
      await (suspend ? api.suspend(id) : api.reinstate(id));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change that membership.');
    }
  }

  async function resend(id: string) {
    try {
      const result = await api.resendClaim(id);
      setIssued({ memberNumber: id, code: result.claimCode.code });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not issue a new code.');
    }
  }

  const dormant = members.filter((m) => m.totalUses === 0).length;
  const unclaimed = members.filter((m) => !m.appClaimed).length;

  return (
    <section>
      <h2>Members</h2>
      <p>
        {total} total · {dormant} have never used a benefit · {unclaimed} have not claimed the app
      </p>

      <form onSubmit={create}>
        <p>
          <label htmlFor="new-name">New member name</label>
          <br />
          <input id="new-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </p>
        <p>
          <button type="submit">Create member and issue claim code</button>
        </p>
      </form>

      {issued ? (
        <p role="status">
          {/* Shown once only — the server stores a hash, so it cannot be
              retrieved again. Losing it means issuing a replacement. */}
          Claim code for {issued.memberNumber}: <strong>{issued.code}</strong>. Print this on the
          invitation letter — it is not retrievable afterwards.
        </p>
      ) : null}

      <div className="table-scroll">
      <table>
        <caption>Membership</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Number</th>
            <th scope="col">Phone</th>
            <th scope="col">Joined</th>
            <th scope="col">Last used</th>
            <th scope="col">Total uses</th>
            <th scope="col">App</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id}>
              <td>{member.fullName}</td>
              {/* Both of these are identifiers read digit by digit, so both get
                  the tabular monospace treatment the Overview already used for
                  membership numbers. */}
              <td className="member-number">{member.memberNumber}</td>
              <td className="member-number">
                {/* Tap-to-call: on a tablet behind the desk this is the point.
                    "Not given" rather than a dash, because the distinction
                    between no number and an unrenderable one matters when the
                    next step is following someone up. */}
                {member.phone ? (
                  <a href={`tel:${member.phone.replace(/\s/g, '')}`}>{member.phone}</a>
                ) : (
                  'Not given'
                )}
              </td>
              <td>{formatDate(member.joinedAt)}</td>
              {/* Last use is an event, so it carries its clock time. */}
              <td>{member.lastUsedAt ? formatTimestamp(member.lastUsedAt) : 'never'}</td>
              <td>{member.totalUses}</td>
              {/* D3 note 3: "not claimed" is its own signal, different from
                  claimed-but-never-visited, and needs different follow-up. */}
              <td>{member.appClaimed ? 'Active' : 'Not claimed'}</td>
              <td>{member.status}</td>
              <td>
                <button
                  type="button"
                  // R16: a membership is suspended, never deleted. Suspension
                  // is the consequential direction, so only it is marked.
                  data-destructive={member.status === 'ACTIVE'}
                  onClick={() => void setStatus(member.id, member.status === 'ACTIVE')}
                >
                  {member.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
                </button>
                {!member.appClaimed ? (
                  <button type="button" onClick={() => void resend(member.id)}>
                    Resend claim code
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

// ── Screen 14: benefit management ────────────────────────────────────────

function Benefits() {
  const [benefits, setBenefits] = useState<AdminBenefit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBenefits((await api.benefits()).benefits);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load benefits.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h2>Benefits</h2>
      {/* Screen 14 note 2: discounts, caps, phone numbers and terms are all
          configuration, read at runtime. That is the difference between a
          product they operate and one they depend on us to change. */}
      <p>Shown to every member. Changes take effect immediately — no release required.</p>

      {benefits.map((benefit) => (
        <BenefitEditor
          key={benefit.id}
          benefit={benefit}
          onSaved={async (message) => {
            setSaved(message);
            setError(null);
            await load();
          }}
          onError={(message) => setError(message)}
        />
      ))}

      {saved ? <p role="status">{saved}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function BenefitEditor({
  benefit,
  onSaved,
  onError,
}: {
  benefit: AdminBenefit;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [discountPct, setDiscountPct] = useState(benefit.discountPct);
  const [maxGuests, setMaxGuests] = useState(benefit.maxGuests?.toString() ?? '');
  const [reservationPhone, setReservationPhone] = useState(benefit.reservationPhone ?? '');
  const [terms, setTerms] = useState(benefit.terms);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.updateBenefit(benefit.id, {
        // Sent as a string: a percentage parsed through a float is how 25
        // becomes 24.999999999999996.
        discountPct,
        maxGuests: maxGuests === '' ? null : Number(maxGuests),
        reservationPhone: reservationPhone === '' ? null : reservationPhone,
        terms,
      });
      await onSaved(`${benefit.title} updated. Members see the new values immediately.`);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not save that benefit.');
    }
  }

  return (
    <article>
      <h3>
        {benefit.title} ({benefit.key})
      </h3>
      <p>
        Version {benefit.version} · {benefit.published ? 'Published' : 'Not published'}
        {/* Screen 14 note 3: "who changed the spa discount, and when" is a
            question that will be asked. */}
        {benefit.updatedBy ? ` · last changed by ${benefit.updatedBy.fullName}` : ''} ·{' '}
        {/* Was `toLocaleString`, which stops at the minute. A percentage
            changed twice while getting it right needs the second to tell the
            two versions apart. */}
        {formatTimestamp(benefit.updatedAt)}
      </p>

      <form onSubmit={save}>
        <p>
          <label htmlFor={`pct-${benefit.id}`}>Discount %</label>
          <br />
          <input
            id={`pct-${benefit.id}`}
            value={discountPct}
            onChange={(e) => setDiscountPct(e.target.value)}
            required
          />
        </p>
        <p>
          <label htmlFor={`max-${benefit.id}`}>Maximum guests</label>
          <br />
          <input
            id={`max-${benefit.id}`}
            type="number"
            min="1"
            value={maxGuests}
            onChange={(e) => setMaxGuests(e.target.value)}
          />
        </p>
        <p>
          <label htmlFor={`phone-${benefit.id}`}>Reservations number</label>
          <br />
          <input
            id={`phone-${benefit.id}`}
            value={reservationPhone}
            onChange={(e) => setReservationPhone(e.target.value)}
          />
        </p>
        <p>
          <label htmlFor={`terms-${benefit.id}`}>Terms</label>
          <br />
          <textarea
            id={`terms-${benefit.id}`}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            rows={3}
          />
        </p>
        <p>
          <button type="submit">Save</button>
          <button
            type="button"
            onClick={() =>
              void api
                .publishBenefit(benefit.id, !benefit.published)
                .then(() => onSaved(`${benefit.title} ${benefit.published ? 'unpublished' : 'published'}.`))
                .catch((cause: unknown) =>
                  onError(cause instanceof Error ? cause.message : 'Could not change publication.'),
                )
            }
          >
            {benefit.published ? 'Unpublish' : 'Publish'}
          </button>
        </p>
      </form>
    </article>
  );
}

// ── Screen D5: reports ───────────────────────────────────────────────────

function Reports() {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [byBenefit, setByBenefit] = useState<BenefitGroup[]>([]);
  const [minCohort, setMinCohort] = useState(0);
  const [dormant, setDormant] = useState<ReportMember[]>([]);
  const [unclaimed, setUnclaimed] = useState<ReportMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.summary(), api.byBenefit(), api.dormant(), api.unclaimed()])
      .then(([s, b, d, u]) => {
        setSummary(s);
        setByBenefit(b.groups);
        setMinCohort(b.minCohortSize);
        setDormant(d.members);
        setUnclaimed(u.members);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Could not load reports.'),
      );
  }, []);

  return (
    <section>
      <h2>Programme activity</h2>

      {summary ? (
        <ul className="kpi-row">
          {/* Tone carries emphasis, never meaning on its own — each label says
              what it is. "Never used" is the figure the programme exists to
              move, so it is flagged rather than reported flat.

              Every value goes through StatTile, which renders a withheld figure
              as "insufficient data". These four were previously rendered with
              `String(...)`, which printed the raw `insufficient_data` sentinel
              into the page whenever the cohort was under the minimum — which on
              a pilot-sized database is most of the time. */}
          <StatTile label="Redemptions" value={summary.redemptions} tone="ok" />
          <StatTile label="Members redeeming" value={summary.activeMembers} tone="ok" />
          <StatTile
            label="Never used a benefit"
            value={summary.neverUsed}
            tone={summary.neverUsed > 0 ? 'warn' : 'ok'}
          />
          <StatTile
            label="Est. value given"
            value={summary.estValueMinor}
            format={formatMinor}
          />
        </ul>
      ) : (
        <p>Loading…</p>
      )}

      <h3>By benefit</h3>
      {/* D5 note 5: groups below the minimum cohort return "insufficient
          data" rather than a number, because a narrow enough filter could
          describe exactly one person. */}
      <p className="note">Groups of fewer than {minCohort} members are suppressed.</p>
      <div className="table-scroll">
      <table>
        <caption>Redemptions by benefit</caption>
        <thead>
          <tr>
            <th scope="col">Benefit</th>
            <th scope="col">Redemptions</th>
          </tr>
        </thead>
        <tbody>
          {byBenefit.map((group) => (
            <tr key={group.label}>
              <td>{group.label}</td>
              {/* FigureValue reads the sentinel off the value itself rather
                  than trusting the sibling `suppressed` flag, so the two can
                  never disagree on screen. */}
              <td>
                <FigureValue value={group.redemptions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h3>Needs attention</h3>
      {/* D5 note 3: six personally invited guests who have never used
          anything is a list for the General Manager, not a statistic. */}
      <p>{dormant.length} members have never used a benefit</p>
      <ul>
        {dormant.map((member) => (
          <li key={member.id}>
            {member.fullName} · {member.memberNumber}
          </li>
        ))}
      </ul>

      <p>{unclaimed.length} members were issued a card but never claimed the app</p>
      <ul>
        {unclaimed.map((member) => (
          <li key={member.id}>
            {member.fullName} · {member.memberNumber}
          </li>
        ))}
      </ul>

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

// ── Redemption log ───────────────────────────────────────────────────────

function Redemptions() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.redemptions>>['redemptions']>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.redemptions()).redemptions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load redemptions.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function reverse(id: string) {
    const reason = prompt('Why is this being reversed?');
    if (!reason) return;
    try {
      await api.reverse(id, reason);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reverse that.');
    }
  }

  return (
    <section>
      <h2>Redemptions</h2>
      <div className="table-scroll">
      <table>
        <caption>Every recorded redemption</caption>
        <thead>
          <tr>
            {/* To the second. This table is where a reversal gets authorised,
                and identifying *which* of two entries to reverse needs more
                resolution than the day they share. */}
            <th scope="col">Date and time</th>
            <th scope="col">Member</th>
            <th scope="col">Benefit</th>
            <th scope="col">Outlet</th>
            <th scope="col">Guests</th>
            <th scope="col">Recorded by</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatTimestamp(row.occurredAt)}</td>
              <td>{row.member.memberNumber}</td>
              <td>
                {row.benefit.title} · {row.benefit.discountPct}%
              </td>
              <td>{row.outlet.name}</td>
              <td>{row.partySize ?? '—'}</td>
              {/* D4 note 2: every entry names the staff member who recorded
                  it. Attribution is the main deterrent against misuse. */}
              <td>{row.staffUser.fullName}</td>
              <td>
                {row.reversesId ? (
                  'reversal'
                ) : (
                  <button type="button" data-destructive="true" onClick={() => void reverse(row.id)}>
                    Reverse
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {/* D4 note 2 again: a correction is a new reversing entry, never an
          edit that erases what happened. */}
      <p>Records are immutable. A correction adds a reversing entry; it never edits the original.</p>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
