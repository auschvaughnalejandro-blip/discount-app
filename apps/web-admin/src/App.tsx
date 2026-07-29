import { useCallback, useEffect, useState } from 'react';

import { api, clearToken, setToken, type AdminBenefit, type MemberRow } from './api.js';

/**
 * The admin dashboard (wireframes screens 11–14, D3–D5).
 *
 * Plain semantic HTML, no styling. The screen that matters is Benefits: the
 * test of whether this project delivered is that changing the F&B discount
 * from 25% to 20% is a form field, not a developer and a release
 * (screen 14 note 1).
 */

type Section = 'members' | 'redemptions' | 'reports' | 'benefits';

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [section, setSection] = useState<Section>('members');

  if (!signedIn) {
    return <SignIn onSignedIn={() => setSignedIn(true)} />;
  }

  return (
    <main>
      <header>
        <h1>Privilege Guest — Admin</h1>
        <nav aria-label="Sections">
          <ul>
            {(['members', 'redemptions', 'reports', 'benefits'] as Section[]).map((name) => (
              <li key={name}>
                <button type="button" onClick={() => setSection(name)} aria-current={section === name}>
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <button
          type="button"
          onClick={() => {
            clearToken();
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </header>

      {section === 'members' ? <Members /> : null}
      {section === 'redemptions' ? <Redemptions /> : null}
      {section === 'reports' ? <Reports /> : null}
      {section === 'benefits' ? <Benefits /> : null}
    </main>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const tokens = await api.login(email, password);
      setToken(tokens.accessToken);
      onSignedIn();
    } catch {
      setError('Those details were not accepted.');
    }
  }

  return (
    <main>
      <h1>Privilege Guest — Admin</h1>
      <form onSubmit={submit}>
        <p>
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </p>
        <p>
          <button type="submit">Sign in</button>
        </p>
      </form>
      {/* TODO(open-question): §3 makes MFA mandatory on every dashboard
          account "without exception". No MFA challenge endpoint exists — see
          PROGRESS.md Q5. This form is password-only until that is resolved. */}
      {error ? <p role="alert">{error}</p> : null}
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

      <table>
        <caption>Membership</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Number</th>
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
              <td>{member.memberNumber}</td>
              <td>{new Date(member.joinedAt).toLocaleDateString()}</td>
              <td>{member.lastUsedAt ? new Date(member.lastUsedAt).toLocaleDateString() : 'never'}</td>
              <td>{member.totalUses}</td>
              {/* D3 note 3: "not claimed" is its own signal, different from
                  claimed-but-never-visited, and needs different follow-up. */}
              <td>{member.appClaimed ? 'Active' : 'Not claimed'}</td>
              <td>{member.status}</td>
              <td>
                <button type="button" onClick={() => void setStatus(member.id, member.status === 'ACTIVE')}>
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
        {new Date(benefit.updatedAt).toLocaleString()}
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
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [byBenefit, setByBenefit] = useState<Record<string, unknown>[]>([]);
  const [minCohort, setMinCohort] = useState(0);
  const [dormant, setDormant] = useState<MemberRow[]>([]);
  const [unclaimed, setUnclaimed] = useState<MemberRow[]>([]);
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
        <ul>
          <li>Redemptions: {String(summary['redemptions'])}</li>
          <li>Active members: {String(summary['activeMembers'])}</li>
          <li>Never used: {String(summary['neverUsed'])}</li>
          <li>Estimated value given (fils): {String(summary['estValueMinor'])}</li>
        </ul>
      ) : (
        <p>Loading…</p>
      )}

      <h3>By benefit</h3>
      {/* D5 note 5: groups below the minimum cohort return "insufficient
          data" rather than a number, because a narrow enough filter could
          describe exactly one person. */}
      <p>Groups of fewer than {minCohort} members are suppressed.</p>
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
            <tr key={String(group['label'])}>
              <td>{String(group['label'])}</td>
              <td>
                {group['suppressed'] ? 'insufficient data' : String(group['redemptions'])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
      <table>
        <caption>Every recorded redemption</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
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
              <td>{new Date(row.occurredAt).toLocaleDateString()}</td>
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
                  <button type="button" onClick={() => void reverse(row.id)}>
                    Reverse
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* D4 note 2 again: a correction is a new reversing entry, never an
          edit that erases what happened. */}
      <p>Records are immutable. A correction adds a reversing entry; it never edits the original.</p>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
