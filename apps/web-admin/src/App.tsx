import { useCallback, useEffect, useState } from 'react';

import { formatDate, formatTimestamp } from '@pgp/ui/format';

import {
  api,
  onSessionEnd,
  resumeSession,
  setTokens,
  signOut,
  type AdminBenefit,
  type BenefitGroup,
  type MemberRow,
  type ReportMember,
  type ReportSummary,
  type RequestStatus,
  type StaffRow,
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

type Section =
  | 'overview'
  | 'requests'
  | 'members'
  | 'redemptions'
  | 'reports'
  | 'benefits'
  | 'outlets'
  | 'staff';

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
  { id: 'requests', label: 'Requests', hint: 'Who each outlet is expecting' },
  { id: 'members', label: 'Members', hint: 'Create, suspend and reinstate memberships' },
  { id: 'redemptions', label: 'Redemptions', hint: 'The immutable log' },
  { id: 'reports', label: 'Reports', hint: 'Programme activity in detail' },
  { id: 'benefits', label: 'Benefits', hint: 'Discounts, caps and terms' },
  { id: 'outlets', label: 'Outlets', hint: 'Notification addresses and outlet sign-in' },
  { id: 'staff', label: 'Administrators', hint: 'Administrator accounts and offboarding' },
];

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  /** See the member app: null-state first, so nobody sees a needless sign-in. */
  const [resuming, setResuming] = useState(true);
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

  useEffect(() => {
    void (async () => {
      setSignedIn(await resumeSession());
      setResuming(false);
    })();
  }, []);

  /**
   * A session that ends in the background has to reach the screen.
   *
   * Without this the dashboard stayed mounted after its session died and each
   * panel independently rendered the API's "Authentication required." into its
   * own error slot — eight copies of an error message where one sign-in form
   * belonged, and no way out but a manual reload. `api` decides when a session is
   * over; this is how that decision arrives here.
   */
  useEffect(
    () =>
      onSessionEnd(() => {
        setSignedIn(false);
        setChallenge(null);
      }),
    [],
  );

  if (resuming) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  if (!signedIn) {
    if (challenge) {
      return (
        <MfaSignIn
          challengeToken={challenge.challengeToken}
          stage={challenge.stage}
          onSignedIn={(tokens) => {
            setTokens(tokens);
            setChallenge(null);
            setSignedIn(true);
          }}
        />
      );
    }
    return (
      <SignIn
        onChallenge={setChallenge}
        onSignedIn={(tokens) => {
          setTokens(tokens);
          setChallenge(null);
          setSignedIn(true);
        }}
      />
    );
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
            // The screen changes first and `signOut` revokes in the background:
            // a button that waited on the network before doing anything visible
            // invites a second click, and the local state is cleared either way.
            setChallenge(null);
            setSignedIn(false);
            void signOut();
          }}
        >
          Sign out
        </button>
      </header>

      {section === 'overview' ? <Overview onNavigate={setSection} /> : null}
      {section === 'requests' ? <Requests /> : null}
      {section === 'members' ? <Members /> : null}
      {section === 'redemptions' ? <Redemptions /> : null}
      {section === 'reports' ? <Reports /> : null}
      {section === 'benefits' ? <Benefits /> : null}
      {section === 'outlets' ? <Outlets /> : null}
      {section === 'staff' ? <Administrators /> : null}
    </main>
  );
}

function SignIn({
  onChallenge,
  onSignedIn,
}: {
  onChallenge: (challenge: { challengeToken: string; stage: 'enroll' | 'verify' }) => void;
  /** Only reachable on a server running `STAFF_MFA_REQUIRED=false`. */
  onSignedIn: (tokens: { accessToken: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await api.login(email, password);

      // Which of the two the server sent is the server's decision, not a
      // preference held here — a client that could choose to skip the second
      // factor would not be a second factor.
      if (result.mfaRequired) {
        onChallenge({ challengeToken: result.challengeToken, stage: result.stage });
      } else {
        onSignedIn({ accessToken: result.accessToken });
      }
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

/**
 * Hand a fetched blob to the browser as a download.
 *
 * Shared by the two exports. The object URL is revoked straight after the
 * click, or the blob is held for the lifetime of the page.
 */
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Members() {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [total, setTotal] = useState(0);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  /** From the server, never a constant here — see routes/health.ts. */
  const [countryCode, setCountryCode] = useState('');
  const [issued, setIssued] = useState<{ memberNumber: string; code: string } | null>(null);
  const [exportingCards, setExportingCards] = useState(false);
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

  useEffect(() => {
    void (async () => {
      try {
        setCountryCode((await api.config()).defaultCountryCode);
      } catch {
        // The field still works without it: the server normalises whatever is
        // typed, so the prefix is a convenience rather than the mechanism.
      }
    })();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const created = await api.createMember({
        fullName,
        // Sent with the dialling code already attached. The server normalises
        // regardless — it accepts 12345678, +974 12345678 and 0097412345678
        // alike — so this is about what the administrator sees, not about what
        // reaches the database.
        ...(phone.trim() ? { phone: `${countryCode}${phone.replace(/\D/g, '')}` } : {}),
        email: email.trim(),
      });
      // Screen 11 note 1: "New member" replaces public signup — an
      // administrator creates the record and issues a code.
      setIssued({ memberNumber: created.memberNumber, code: created.claimCode.code });
      setFullName('');
      setPhone('');
      setEmail('');
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

  /**
   * The file the card bureau prints from.
   *
   * Rate limited to a handful a day and individually audited, like the
   * redemption export — none of which is client-side. This button only makes
   * the capability reachable.
   */
  async function downloadCardExport() {
    setExportingCards(true);
    setError(null);
    try {
      const { blob, filename } = await api.exportCardsCsv();
      saveFile(blob, filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export the card list.');
    } finally {
      setExportingCards(false);
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

      <p>
        <button
          type="button"
          onClick={() => void downloadCardExport()}
          disabled={exportingCards}
        >
          {exportingCards ? 'Preparing…' : 'Export card list (CSV)'}
        </button>
      </p>
      {/* Said on the screen, not only in the route comment: this is the one
          export that carries names, and the person about to email it to a
          print vendor is the person who needs to know that. */}
      <p className="field-hint">
        Membership number, name and card code for every member — what the card printer needs.
        It names individuals, so treat it as confidential. The card code must reach the
        printer exactly as written: it is case-sensitive, and altering it stops the card
        scanning.
      </p>

      <form onSubmit={create}>
        <p className="field">
          <label htmlFor="new-name">Full name</label>
          <br />
          <input id="new-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </p>
        <p className="field">
          <label htmlFor="new-email">Email</label>
          <br />
          <input
            id="new-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {/* Required here even though the API allows it to be absent. Sign-in
              passcodes are delivered by email, and the member does not supply
              theirs until *after* the first one has been sent — so a membership
              created without one can never be activated, and the failure
              surfaces at the guest's first attempt rather than here. */}
          <span className="field-hint">
            Where their sign-in passcodes go. Without it they cannot activate the app.
          </span>
        </p>
        <p className="field">
          <label htmlFor="new-phone">Mobile number</label>
          <br />
          <span className="phone-input">
            {/* The dialling code is shown, not typed. An administrator entering
                fifty members should not retype it fifty times, and a number
                stored without it will never match at sign-in. */}
            <span className="phone-prefix" aria-hidden="true">
              {countryCode || '+…'}
            </span>
            <input
              id="new-phone"
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              placeholder="55550000"
              aria-describedby="new-phone-hint"
            />
          </span>
          <span className="field-hint" id="new-phone-hint">
            Optional, and without the {countryCode || 'country'} prefix — it is added for you.
            Recorded here, the member must sign in with this exact number rather than whichever
            one they type at activation.
          </span>
        </p>
        <p>
          <button type="submit">Create member and issue invitation code</button>
        </p>

        {/* Beside the form, not below the table. This lived at the foot of the
            section, under a hundred member rows, so a failed create looked
            exactly like a button that did nothing. */}
        {error ? <p role="alert">{error}</p> : null}
      </form>

      {issued ? (
        <p role="status">
          {/* Shown once only — the server stores a hash, so it cannot be
              retrieved again. Losing it means issuing a replacement. */}
          Invitation code for {issued.memberNumber}: <strong>{issued.code}</strong>. Give this to
          the member — it is shown once and cannot be retrieved afterwards. It is not their
          passcode: those are generated per sign-in and go straight to the member.
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

    </section>
  );
}

/**
 * Outlets: notification delivery and the devices allowed to work each queue.
 *
 * There are exactly two concepts here: the outlet email that receives notices,
 * and the token-backed counter devices that sign in. The email is never a
 * credential. A device token is returned once, held only in this component long
 * enough to copy, and never included in the management GET.
 */
function Outlets() {
  type Row = Awaited<ReturnType<typeof api.manageOutlets>>['outlets'][number];
  type IssuedToken = {
    outletId: string;
    deviceId: string;
    label: string;
    token: string;
    action: 'issued' | 'rotated';
  };

  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copiedDeviceId, setCopiedDeviceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.manageOutlets()).outlets);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load outlets.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await work();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  async function issueDevice(outletId: string, label: string): Promise<boolean> {
    setBusy(outletId);
    setError(null);
    try {
      const result = await api.createOutletDevice(outletId, { label });
      setIssued({
        outletId,
        deviceId: result.device.id,
        label: result.device.fullName,
        token: result.token,
        action: 'issued',
      });
      setCopiedDeviceId(null);
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not issue a device token.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function rotateDevice(outletId: string, deviceId: string, label: string) {
    if (
      !window.confirm(
        `Rotate the token for ${label}? Its old token and existing sessions will stop working.`,
      )
    ) {
      return;
    }

    setBusy(outletId);
    setError(null);
    try {
      const result = await api.rotateOutletDevice(deviceId);
      setIssued({
        outletId,
        deviceId: result.device.id,
        label: result.device.fullName,
        token: result.token,
        action: 'rotated',
      });
      setCopiedDeviceId(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rotate that device token.');
    } finally {
      setBusy(null);
    }
  }

  async function copyIssuedToken() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopiedDeviceId(issued.deviceId);
    } catch {
      setError('Could not copy the token. Select the token and copy it manually.');
    }
  }

  return (
    <section>
      <h2>Outlets</h2>
      <p className="row-secondary">
        Set the outlet email for notices, then issue a private login token to each counter device.
      </p>

      {rows.map((outlet) => (
        <article key={outlet.id} className="panel">
          <h3>
            {outlet.name}{' '}
            {outlet.active ? null : (
              <span className="badge" data-tone="warn">
                closed
              </span>
            )}
          </h3>

          <div className="outlet-panel-body">
            <NotifyEmailForm
              outlet={outlet}
              busy={busy === outlet.id}
              onSave={(notifyEmail) =>
                void act(outlet.id, () => api.updateOutlet(outlet.id, { notifyEmail }))
              }
            />

            <section className="outlet-signin-section" aria-labelledby={`devices-${outlet.id}`}>
              <div>
                <h4 id={`devices-${outlet.id}`}>Device sign-in</h4>
                <p className="row-secondary">
                  Use a separate token for every tablet or counter computer so one device can be
                  revoked without taking the whole outlet offline.
                </p>
              </div>

              {outlet.devices.length === 0 ? (
                <p className="row-secondary">No device token has been issued yet.</p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <caption>Counter devices</caption>
                    <thead>
                      <tr>
                        <th scope="col">Label</th>
                        <th scope="col">Last used</th>
                        <th scope="col">Token issued</th>
                        <th scope="col">Status</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outlet.devices.map((device) => (
                        <tr key={device.id}>
                          <td>{device.fullName}</td>
                          <td>
                            {device.outletTokenLastUsedAt ? (
                              <time dateTime={device.outletTokenLastUsedAt}>
                                {formatTimestamp(device.outletTokenLastUsedAt)}
                              </time>
                            ) : (
                              <span className="row-secondary">never</span>
                            )}
                          </td>
                          <td>
                            <time dateTime={device.outletTokenIssuedAt}>
                              {formatTimestamp(device.outletTokenIssuedAt)}
                            </time>
                          </td>
                          <td>
                            <span
                              className="badge"
                              data-tone={device.status === 'ACTIVE' ? 'ok' : 'warn'}
                            >
                              {device.status === 'ACTIVE' ? 'active' : 'revoked'}
                            </span>
                          </td>
                          <td>
                            {device.status === 'ACTIVE' ? (
                              <div className="device-actions">
                                <button
                                  type="button"
                                  disabled={busy === outlet.id}
                                  onClick={() =>
                                    void rotateDevice(outlet.id, device.id, device.fullName)
                                  }
                                >
                                  Rotate
                                </button>
                                <button
                                  type="button"
                                  disabled={busy === outlet.id}
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        `Revoke ${device.fullName}? Its token and existing sessions will stop working.`,
                                      )
                                    ) {
                                      return;
                                    }
                                    void act(outlet.id, async () => {
                                      await api.revokeOutletDevice(device.id);
                                      if (issued?.deviceId === device.id) setIssued(null);
                                    });
                                  }}
                                >
                                  Revoke
                                </button>
                              </div>
                            ) : (
                              <span className="row-secondary">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {issued?.outletId === outlet.id ? (
                <div className="device-token" role="status">
                  <div>
                    <strong>
                      {issued.action === 'issued' ? 'Device token issued' : 'Device token rotated'}
                      {' — '}
                      {issued.label}
                    </strong>
                    <p>
                      Copy this token to the device now. It is shown once and cannot be retrieved
                      afterwards; losing it means rotating the token again.
                    </p>
                    <output aria-label={`Login token for ${issued.label}`}>{issued.token}</output>
                    <div className="device-token-actions">
                      <button type="button" onClick={() => void copyIssuedToken()}>
                        {copiedDeviceId === issued.deviceId ? 'Copied' : 'Copy token'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIssued(null);
                          setCopiedDeviceId(null);
                        }}
                      >
                        I have saved it
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              <NewOutletDeviceForm
                outletId={outlet.id}
                busy={busy === outlet.id}
                disabled={!outlet.active}
                onCreate={(label) => issueDevice(outlet.id, label)}
              />
            </section>

          </div>
        </article>
      ))}

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function NotifyEmailForm({
  outlet,
  busy,
  onSave,
}: {
  outlet: { id: string; notifyEmail: string | null };
  busy: boolean;
  onSave: (notifyEmail: string | null) => void;
}) {
  const [value, setValue] = useState(outlet.notifyEmail ?? '');

  return (
    <form
      className="field"
      onSubmit={(event) => {
        event.preventDefault();
        // An empty box means "nobody is emailed", which is a real choice — so it
        // sends null rather than refusing to submit.
        onSave(value.trim() === '' ? null : value.trim());
      }}
    >
      <label htmlFor={`notify-${outlet.id}`}>Outlet email</label>
      <br />
      <input
        id={`notify-${outlet.id}`}
        type="email"
        value={value}
        placeholder="No outlet email set"
        aria-describedby={`notify-hint-${outlet.id}`}
        onChange={(event) => setValue(event.target.value)}
      />{' '}
      <span className="field-hint" id={`notify-hint-${outlet.id}`}>
        Receives guest notices only. This address cannot sign in.
      </span>
      <button type="submit" disabled={busy}>
        Save outlet email
      </button>
    </form>
  );
}

function NewOutletDeviceForm({
  outletId,
  busy,
  disabled,
  onCreate,
}: {
  outletId: string;
  busy: boolean;
  disabled: boolean;
  onCreate: (label: string) => Promise<boolean>;
}) {
  const [label, setLabel] = useState('');

  if (disabled) {
    return <p className="row-secondary">Reopen this outlet before issuing a device token.</p>;
  }

  return (
    <form
      className="outlet-device-form"
      onSubmit={(event) => {
        event.preventDefault();
        const next = label.trim();
        if (next === '') return;
        void onCreate(next).then((created) => {
          if (created) setLabel('');
        });
      }}
    >
      <p className="field">
        <label htmlFor={`device-label-${outletId}`}>Device label</label>
        <br />
        <input
          id={`device-label-${outletId}`}
          value={label}
          placeholder="Steakhouse counter tablet"
          onChange={(event) => setLabel(event.target.value)}
          required
        />
        <span className="field-hint">Name the physical device or counter, not a person.</span>
      </p>
      <button type="submit" disabled={busy || label.trim() === ''}>
        {busy ? 'Issuing…' : 'Issue device token'}
      </button>
    </form>
  );
}

/**
 * Administrator accounts.
 *
 * The screen §3 calls for when it says "instant revocation from the dashboard".
 * Until this existed, offboarding somebody meant editing the database by hand.
 */
function Administrators() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [fullName, setFullName] = useState('');
  const [staffEmail, setStaffEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.staff()).staff);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load administrators.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.createStaff({
        fullName,
        email: staffEmail,
        password,
      });
      setNotice(`${fullName} can now sign in. They must set up an authenticator first.`);
      setFullName('');
      setStaffEmail('');
      setPassword('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that account.');
    }
  }

  async function act(id: string, run: () => Promise<unknown>, done: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2>Administrators</h2>

      <form onSubmit={create}>
        <p className="field">
          <label htmlFor="staff-name">Full name</label>
          <br />
          <input
            id="staff-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </p>
        <p className="field">
          <label htmlFor="staff-email">Email</label>
          <br />
          <input
            id="staff-email"
            type="email"
            value={staffEmail}
            onChange={(e) => setStaffEmail(e.target.value)}
            required
            autoComplete="off"
          />
          <span className="field-hint">What they sign in with.</span>
        </p>
        <p className="field">
          <label htmlFor="staff-password">Initial password</label>
          <br />
          <input
            id="staff-password"
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={12}
            autoComplete="off"
          />
          {/* Shown rather than masked: the administrator has to read it out to
              the person. Length is what is checked, not symbols — and it is
              screened against known breaches, so a password from a dump is
              refused however long it is. */}
          <span className="field-hint">
            At least 12 characters. Checked against known breached passwords.
          </span>
        </p>
        <p>
          <button type="submit">Create administrator account</button>
        </p>

        {notice ? <p role="status">{notice}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>

      <div className="table-scroll">
        <table>
          <caption>Administrator accounts</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Second factor</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.fullName}</td>
                <td>{row.email}</td>
                <td>
                  {row.mfaEnrolledAt ? (
                    'set up'
                  ) : (
                    <span className="badge" data-tone="warn">
                      not yet
                    </span>
                  )}
                </td>
                <td>
                  {row.status === 'ACTIVE' ? (
                    'active'
                  ) : (
                    <span className="badge" data-tone="warn">
                      suspended
                    </span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() =>
                      void act(
                        row.id,
                        () => api.setStaffStatus(row.id, row.status === 'ACTIVE'),
                        row.status === 'ACTIVE'
                          ? `${row.fullName} is suspended. Every session they had is already dead.`
                          : `${row.fullName} can sign in again.`,
                      )
                    }
                  >
                    {row.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}
                  </button>{' '}
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() =>
                      void act(
                        row.id,
                        () => api.resetStaffMfa(row.id),
                        `${row.fullName} will set up a new authenticator at their next sign-in.`,
                      )
                    }
                  >
                    Reset second factor
                  </button>{' '}
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => {
                      const next = prompt(`New password for ${row.fullName} (12+ characters):`);
                      if (!next) return;
                      void act(
                        row.id,
                        () => api.setStaffPassword(row.id, next),
                        `Password set. Read it to them; every session they had is now dead.`,
                      );
                    }}
                  >
                    Set password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="field-hint">
        Suspending takes effect immediately — it does not wait for a session to expire. You cannot
        suspend yourself, reset your own second factor, or suspend the last administrator.
      </p>
    </section>
  );
}

// ── Screen 14: benefit management ────────────────────────────────────────

function Benefits() {
  const [benefits, setBenefits] = useState<AdminBenefit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBenefits((await api.benefits()).benefits);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load benefits.');
    } finally {
      setLoading(false);
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
      <p className="section-lede">
        Edit the live offer information shown to members. Saved changes reach the member app on
        its next refresh — no release required.
      </p>

      {loading ? <p>Loading…</p> : null}

      {!loading && benefits.length === 0 && error === null ? (
        <p className="empty">No benefits have been configured.</p>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}

      <div className="benefit-editors">
        {benefits.map((benefit) => (
          <BenefitEditor
            key={benefit.id}
            benefit={benefit}
            onUpdated={(updated) =>
              setBenefits((current) =>
                current
                  .map((row) => (row.id === updated.id ? updated : row))
                  .sort((left, right) => left.sortOrder - right.sortOrder),
              )
            }
          />
        ))}
      </div>
    </section>
  );
}

type ChildDiscountDraft = {
  id: string;
  ageBand: string;
  discountPct: string;
};

type BenefitDraft = {
  title: string;
  category: string;
  discountPct: string;
  secondaryLabel: string;
  secondaryPct: string;
  childRules: ChildDiscountDraft[];
  maxGuests: string;
  minGuests: string;
  reservationPhone: string;
  terms: string;
  sortOrder: string;
  outletKind: Exclude<AdminBenefit['outletKind'], null> | '';
};

function draftFromBenefit(benefit: AdminBenefit): BenefitDraft {
  return {
    title: benefit.title,
    category: benefit.category,
    discountPct: benefit.discountPct,
    secondaryLabel: benefit.secondaryLabel ?? '',
    secondaryPct: benefit.secondaryPct ?? '',
    childRules: Object.entries(benefit.childRules ?? {}).map(([ageBand, discountPct], index) => ({
      id: `${benefit.id}-${index}`,
      ageBand,
      discountPct: String(discountPct),
    })),
    maxGuests: benefit.maxGuests?.toString() ?? '',
    minGuests: benefit.minGuests?.toString() ?? '',
    reservationPhone: benefit.reservationPhone ?? '',
    terms: benefit.terms,
    sortOrder: String(benefit.sortOrder),
    outletKind: benefit.outletKind ?? '',
  };
}

function sameBenefitDraft(left: BenefitDraft, right: BenefitDraft): boolean {
  return (
    left.title === right.title &&
    left.category === right.category &&
    left.discountPct === right.discountPct &&
    left.secondaryLabel === right.secondaryLabel &&
    left.secondaryPct === right.secondaryPct &&
    left.maxGuests === right.maxGuests &&
    left.minGuests === right.minGuests &&
    left.reservationPhone === right.reservationPhone &&
    left.terms === right.terms &&
    left.sortOrder === right.sortOrder &&
    left.outletKind === right.outletKind &&
    left.childRules.length === right.childRules.length &&
    left.childRules.every((rule, index) => {
      const other = right.childRules[index];
      return other !== undefined &&
        rule.ageBand === other.ageBand &&
        rule.discountPct === other.discountPct;
    })
  );
}

const PERCENTAGE_PATTERN = /^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/;

type BenefitAction = 'saving' | 'publishing' | null;

function BenefitEditor({
  benefit,
  onUpdated,
}: {
  benefit: AdminBenefit;
  onUpdated: (updated: AdminBenefit) => void;
}) {
  const [draft, setDraft] = useState<BenefitDraft>(() => draftFromBenefit(benefit));
  const [action, setAction] = useState<BenefitAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = !sameBenefitDraft(draft, draftFromBenefit(benefit));
  const busy = action !== null;

  function setField<K extends keyof BenefitDraft>(field: K, value: BenefitDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setNotice(null);
    setError(null);
  }

  function optionalGuestCount(value: string, label: string): number | null {
    if (value === '') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${label} must be a whole number greater than zero.`);
    }
    return parsed;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    try {
      const secondaryLabel = draft.secondaryLabel.trim();
      const secondaryPct = draft.secondaryPct.trim();
      if ((secondaryLabel === '') !== (secondaryPct === '')) {
        throw new Error('The secondary offer label and percentage must be filled in together.');
      }
      if (secondaryPct !== '' && !PERCENTAGE_PATTERN.test(secondaryPct)) {
        throw new Error('The secondary discount must be between 0 and 100, with up to two decimals.');
      }

      const childRules: Record<string, number> = {};
      for (const rule of draft.childRules) {
        const ageBand = rule.ageBand.trim();
        const discountPct = rule.discountPct.trim();
        if (ageBand === '' || discountPct === '') {
          throw new Error('Every child discount needs both an age band and a percentage.');
        }
        if (!PERCENTAGE_PATTERN.test(discountPct)) {
          throw new Error(`The child discount for ${ageBand} must be between 0 and 100.`);
        }
        if (Object.hasOwn(childRules, ageBand)) {
          throw new Error(`The child age band “${ageBand}” is listed more than once.`);
        }
        childRules[ageBand] = Number(discountPct);
      }

      const minGuests = optionalGuestCount(draft.minGuests, 'Minimum guests');
      const maxGuests = optionalGuestCount(draft.maxGuests, 'Maximum guests');
      if (minGuests !== null && maxGuests !== null && minGuests > maxGuests) {
        throw new Error('Minimum guests cannot be greater than maximum guests.');
      }

      const sortOrder = Number(draft.sortOrder);
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
        throw new Error('Display order must be a whole number between 0 and 10,000.');
      }

      setAction('saving');
      const updated = await api.updateBenefit(benefit.id, {
        expectedVersion: benefit.version,
        // Sent as a string: a percentage parsed through a float is how 25
        // becomes 24.999999999999996.
        title: draft.title.trim(),
        category: draft.category.trim(),
        discountPct: draft.discountPct.trim(),
        secondaryLabel: secondaryLabel === '' ? null : secondaryLabel,
        secondaryPct: secondaryPct === '' ? null : secondaryPct,
        childRules: Object.keys(childRules).length === 0 ? null : childRules,
        maxGuests,
        minGuests,
        reservationPhone: draft.reservationPhone.trim() || null,
        terms: draft.terms.trim(),
        sortOrder,
        outletKind: draft.outletKind === '' ? null : draft.outletKind,
      });
      onUpdated(updated);
      setDraft(draftFromBenefit(updated));
      setNotice(`${draft.title.trim()} updated. Members receive the new values when they refresh.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that benefit.');
    } finally {
      setAction(null);
    }
  }

  async function togglePublished() {
    if (dirty) return;
    setAction('publishing');
    setError(null);
    setNotice(null);
    try {
      const updated = await api.publishBenefit(benefit.id, !benefit.published);
      onUpdated(updated);
      setNotice(`${benefit.title} ${benefit.published ? 'unpublished' : 'published'}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change publication.');
    } finally {
      setAction(null);
    }
  }

  return (
    <article className="benefit-editor panel">
      <header className="benefit-editor__head">
        <div>
          <h3>{benefit.title}</h3>
          <p>
            <span className="member-number">{benefit.key}</span> · Version {benefit.version}
            {/* Screen 14 note 3: "who changed the spa discount, and when" is a
                question that will be asked. */}
            {benefit.updatedBy ? ` · last changed by ${benefit.updatedBy.fullName}` : ''} ·{' '}
            {formatTimestamp(benefit.updatedAt)}
          </p>
        </div>
        <span className="badge" data-tone={benefit.published ? 'ok' : 'neutral'}>
          {benefit.published ? 'Published' : 'Draft'}
        </span>
      </header>

      <form className="panel-body" onSubmit={save} aria-busy={busy}>
        <fieldset className="benefit-editor__controls" disabled={busy}>
          <legend className="sr-only">{benefit.title} settings</legend>
        <div className="form-grid benefit-editor__grid">
          <p className="field">
            <label htmlFor={`title-${benefit.id}`}>Offer title</label>
            <input
              id={`title-${benefit.id}`}
              value={draft.title}
              onChange={(event) => setField('title', event.target.value)}
              maxLength={200}
              required
            />
          </p>

          <p className="field">
            <label htmlFor={`category-${benefit.id}`}>Category</label>
            <input
              id={`category-${benefit.id}`}
              value={draft.category}
              onChange={(event) => setField('category', event.target.value)}
              maxLength={100}
              required
            />
          </p>

          {/* The headline rate. `field--primary` only raises it visually — it is
              the number administrators scan for, and the one whose being wrong is worst. */}
          <p className="field field--narrow field--primary">
            <label htmlFor={`pct-${benefit.id}`}>Main discount %</label>
            <input
              id={`pct-${benefit.id}`}
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={draft.discountPct}
              onChange={(event) => setField('discountPct', event.target.value)}
              required
            />
          </p>

          <p className="field field--narrow">
            <label htmlFor={`order-${benefit.id}`}>Display order</label>
            <input
              id={`order-${benefit.id}`}
              type="number"
              min="0"
              max="10000"
              step="1"
              value={draft.sortOrder}
              onChange={(event) => setField('sortOrder', event.target.value)}
              required
            />
          </p>

          <p className="field">
            <label htmlFor={`outlet-${benefit.id}`}>Outlet type</label>
            <select
              id={`outlet-${benefit.id}`}
              value={draft.outletKind}
              onChange={(event) =>
                setField('outletKind', event.target.value as BenefitDraft['outletKind'])
              }
            >
              <option value="">All outlet types</option>
              <option value="DINING">Dining</option>
              <option value="SPA">Spa</option>
              <option value="ROOMS">Rooms</option>
              <option value="EVENTS">Events</option>
              <option value="OTHER">Other</option>
            </select>
            <span className="field-hint">Classifies this offer by outlet type.</span>
          </p>

          <p className="field field--narrow">
            <label htmlFor={`min-${benefit.id}`}>Minimum guests</label>
            <input
              id={`min-${benefit.id}`}
              type="number"
              min="1"
              step="1"
              value={draft.minGuests}
              onChange={(event) => setField('minGuests', event.target.value)}
              placeholder="No minimum"
            />
          </p>

          <p className="field field--narrow">
            <label htmlFor={`max-${benefit.id}`}>Maximum guests</label>
            <input
              id={`max-${benefit.id}`}
              type="number"
              min="1"
              step="1"
              value={draft.maxGuests}
              onChange={(event) => setField('maxGuests', event.target.value)}
              placeholder="No maximum"
            />
          </p>

          <p className="field">
            <label htmlFor={`phone-${benefit.id}`}>Reservations number</label>
            <input
              id={`phone-${benefit.id}`}
              type="tel"
              value={draft.reservationPhone}
              onChange={(event) => setField('reservationPhone', event.target.value)}
              maxLength={50}
              placeholder="No reservation number"
            />
          </p>
        </div>

        <fieldset>
          <legend>Secondary discount</legend>
          <div className="form-grid">
            <p className="field">
              <label htmlFor={`secondary-label-${benefit.id}`}>Label</label>
              <input
                id={`secondary-label-${benefit.id}`}
                value={draft.secondaryLabel}
                onChange={(event) => setField('secondaryLabel', event.target.value)}
                maxLength={200}
                placeholder="For example, retail products"
              />
            </p>
            <p className="field field--narrow">
              <label htmlFor={`secondary-pct-${benefit.id}`}>Discount %</label>
              <input
                id={`secondary-pct-${benefit.id}`}
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={draft.secondaryPct}
                onChange={(event) => setField('secondaryPct', event.target.value)}
                placeholder="None"
              />
            </p>
          </div>
          <p className="field-hint">Leave both fields empty when this offer has one rate only.</p>
        </fieldset>

        <fieldset>
          <legend>Child discounts</legend>
          {draft.childRules.length === 0 ? (
            <p className="empty">No child-specific rates.</p>
          ) : (
            <div className="child-discount-list">
              {draft.childRules.map((rule) => (
                <div className="child-discount-row" key={rule.id}>
                  <p className="field">
                    <label htmlFor={`child-band-${rule.id}`}>Age band</label>
                    <input
                      id={`child-band-${rule.id}`}
                      value={rule.ageBand}
                      onChange={(event) =>
                        setField(
                          'childRules',
                          draft.childRules.map((item) =>
                            item.id === rule.id ? { ...item, ageBand: event.target.value } : item,
                          ),
                        )
                      }
                      maxLength={50}
                      placeholder="For example, 6–12"
                      required
                    />
                  </p>
                  <p className="field field--narrow">
                    <label htmlFor={`child-pct-${rule.id}`}>Discount %</label>
                    <input
                      id={`child-pct-${rule.id}`}
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={rule.discountPct}
                      onChange={(event) =>
                        setField(
                          'childRules',
                          draft.childRules.map((item) =>
                            item.id === rule.id
                              ? { ...item, discountPct: event.target.value }
                              : item,
                          ),
                        )
                      }
                      required
                    />
                  </p>
                  <button
                    type="button"
                    aria-label={`Remove child rate ${rule.ageBand.trim() || 'with no age band'}`}
                    onClick={() =>
                      setField(
                        'childRules',
                        draft.childRules.filter((item) => item.id !== rule.id),
                      )
                    }
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() =>
              setField('childRules', [
                ...draft.childRules,
                { id: crypto.randomUUID(), ageBand: '', discountPct: '' },
              ])
            }
            disabled={busy}
          >
            + Add child rate
          </button>
        </fieldset>

        <p className="field benefit-editor__terms">
          <label htmlFor={`terms-${benefit.id}`}>Terms shown to members</label>
          <textarea
            id={`terms-${benefit.id}`}
            value={draft.terms}
            onChange={(event) => setField('terms', event.target.value)}
            rows={5}
            maxLength={5000}
            required
          />
        </p>

        <div className="benefit-editor__actions">
          <button type="submit" disabled={busy || !dirty}>
            {action === 'saving' ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(draftFromBenefit(benefit));
              setError(null);
              setNotice(null);
            }}
            disabled={busy || !dirty}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => void togglePublished()}
            disabled={busy || dirty}
          >
            {action === 'publishing'
              ? benefit.published
                ? 'Unpublishing…'
                : 'Publishing…'
              : benefit.published
                ? 'Unpublish'
                : 'Publish'}
          </button>
        </div>

        {dirty ? (
          <p className="field-hint benefit-editor__dirty" role="status">
            Unsaved changes. Save or reset them before changing publication.
          </p>
        ) : null}
        </fieldset>

        {notice ? <p role="status">{notice}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </article>
  );
}

// ── Screen D5: reports ───────────────────────────────────────────────────

function Reports() {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [exporting, setExporting] = useState(false);
  const [byBenefit, setByBenefit] = useState<BenefitGroup[]>([]);
  const [minCohort, setMinCohort] = useState(0);
  const [dormant, setDormant] = useState<ReportMember[]>([]);
  const [unclaimed, setUnclaimed] = useState<ReportMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * §6 and §9 both treat bulk export as the most sensitive action here: it is
   * separately permissioned, rate limited to a handful a day, and individually
   * audited. Nothing about that is client-side — this button simply makes the
   * capability reachable, which it was not.
   */
  async function downloadExport() {
    setExporting(true);
    setError(null);
    try {
      const { blob, filename } = await api.exportCsv();
      saveFile(blob, filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export.');
    } finally {
      setExporting(false);
    }
  }

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

      <h3>For finance</h3>
      <p>
        <button type="button" onClick={() => void downloadExport()} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Download redemptions (CSV)'}
        </button>
      </p>
      <p className="field-hint">
        One row per redemption, with the rate applied and what it was worth. Membership numbers
        only — never names. Every download is recorded against your account.
      </p>

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

// ── The notice monitor ─────────────────────────────────────────

/**
 * Guests who told an outlet they were coming.
 *
 * **Nothing on this screen decides anything.** There used to be Approve and
 * Decline buttons here; a Privilege Guest is entitled to every published benefit
 * the moment they join, so asking permission was asking for something they already
 * had — and it put an administrator in the middle of every single visit. The
 * outlets close their own notices out now.
 *
 * What is left is worth having: a live view of what each outlet has been told, and
 * whether the email actually reached them. `Record by hand` stays for the exception
 * an outlet cannot cover — a visit somebody forgot to confirm on the night, or a
 * benefit given somewhere with no screen.
 *
 * Opens on SENT because that is what is still in flight.
 */
function Requests() {
  type Row = Awaited<ReturnType<typeof api.requests>>['requests'][number];

  const [status, setStatus] = useState<RequestStatus>('SENT');
  const [rows, setRows] = useState<Row[]>([]);
  const [outlets, setOutlets] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The notice currently being recorded by hand, if any. */
  const [fulfilling, setFulfilling] = useState<Row | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.requests(status)).requests);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load requests.');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setOutlets((await api.outlets()).outlets);
      } catch {
        // The list only feeds the outlet picker below, which will say so.
      }
    })();
  }, []);

  return (
    <section>
      <h2>Requests</h2>
      <p className="row-secondary">
        Guests tell an outlet directly and the outlet confirms the visit. Nothing here needs
        approving — this is a view of what is happening.
      </p>

      <p className="field">
        <label htmlFor="request-status">Showing</label>
        <br />
        <select
          id="request-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as RequestStatus)}
        >
          <option value="SENT">Outlet told, guest not yet arrived</option>
          <option value="FULFILLED">Used</option>
          <option value="NOT_USED">Not used</option>
          <option value="APPROVED">Earlier: approved (old flow)</option>
          <option value="PENDING">Earlier: awaiting approval (old flow)</option>
          <option value="DECLINED">Earlier: declined (old flow)</option>
        </select>
      </p>

      {rows.length === 0 ? (
        <p>{status === 'SENT' ? 'No outlet is expecting anybody.' : 'Nothing to show here.'}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <caption>
              {status === 'SENT'
                ? 'Oldest first — these outlets are expecting somebody'
                : 'Requests in this state'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Asked</th>
                <th scope="col">Member</th>
                <th scope="col">Benefit</th>
                <th scope="col">Outlet told</th>
                <th scope="col">Note</th>
                <th scope="col">{status === 'SENT' ? 'Delivery' : 'Closed by'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatTimestamp(row.requestedAt)}</td>
                  <td>
                    {row.member.memberNumber}
                    <br />
                    <span className="row-secondary">{row.member.fullName}</span>
                    {row.member.status !== 'ACTIVE' ? (
                      <>
                        {' '}
                        <span className="badge" data-tone="warn">
                          {row.member.status.toLowerCase()}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {row.benefit.title} · {row.benefit.discountPct}%
                  </td>
                  <td>
                    {row.outlet?.name ?? <span className="row-secondary">—</span>}
                    {/* Whether the outlet has actually looked at its list — the
                        closest thing to a read receipt that does not depend on
                        email arriving. */}
                    {row.outlet && row.status === 'SENT' ? (
                      <>
                        <br />
                        <span className="row-secondary">
                          {row.seenAt === null ? 'not seen on screen yet' : 'seen on screen'}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>{row.note ?? '—'}</td>
                  <td>
                    {row.status === 'SENT' ? (
                      <>
                        {/* A failed send is the one thing on this screen worth
                            acting on: the outlet still works from its own list,
                            but somebody should know the mail is not arriving. */}
                        {row.notifyStatus === null ? (
                          <span className="row-secondary">not sent</span>
                        ) : row.notifyStatus === 'delivered' ? (
                          <span className="row-secondary">emailed</span>
                        ) : (
                          <span className="badge" data-tone="warn">
                            {row.notifyStatus === 'no_address'
                              ? 'no outlet email set'
                              : 'email failed'}
                          </span>
                        )}
                        <br />
                        <button type="button" onClick={() => setFulfilling(row)}>
                          Record by hand
                        </button>
                      </>
                    ) : (
                      <>
                        {row.closedBy?.fullName ?? (
                          /* Nobody closed it — the expiry sweep did. Attributing
                             that to an account would name somebody who never
                             touched it. */
                          <span className="row-secondary">closed automatically</span>
                        )}
                        {row.closedReason ? (
                          <>
                            <br />
                            <span className="row-secondary">{row.closedReason}</span>
                          </>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fulfilling ? (
        <MarkAsUsed
          row={fulfilling}
          outlets={outlets}
          onClose={() => setFulfilling(null)}
          onRecorded={() => {
            setFulfilling(null);
            void load();
          }}
        />
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

/**
 * Recording a visit by hand — the exception path, now that outlets record their own.
 *
 * Kept for the cases an outlet screen cannot cover: a visit nobody confirmed on the
 * night, or a benefit given somewhere with no screen at all.
 *
 * The outlet is asked for rather than assumed. Whoever is filling this in is at a
 * desk, not standing in the spa, and a redemption attributed to the wrong outlet is
 * worse than one attributed to none: it is wrong in a report that looks right.
 */
function MarkAsUsed({
  row,
  outlets,
  onClose,
  onRecorded,
}: {
  row: {
    id: string;
    member: { id: string; memberNumber: string; fullName: string };
    benefit: { id: string; title: string; discountPct: string };
  };
  outlets: { id: string; name: string }[];
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [outletId, setOutletId] = useState('');
  const [partySize, setPartySize] = useState('');
  const [billAmount, setBillAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // R8: one key per attempt, so a double-click or a retry after a dropped
  // connection resolves to the same redemption rather than two.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.recordRedemption({
        memberId: row.member.id,
        benefitId: row.benefit.id,
        outletId,
        requestId: row.id,
        ...(partySize ? { partySize: Number(partySize) } : {}),
        // Entered in whole currency, sent as integer minor units. Never a float
        // anywhere in the path.
        ...(billAmount ? { billAmountMinor: Math.round(Number(billAmount) * 100) } : {}),
        idempotencyKey,
      });
      onRecorded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="record-form" onSubmit={submit}>
      <h3>
        {row.member.fullName} · {row.member.memberNumber}
      </h3>
      <p>
        {row.benefit.title} — {row.benefit.discountPct}% off
      </p>

      <p className="field">
        <label htmlFor="fulfil-outlet">Which outlet</label>
        <br />
        <select
          id="fulfil-outlet"
          value={outletId}
          onChange={(e) => setOutletId(e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {outlets.map((outlet) => (
            <option key={outlet.id} value={outlet.id}>
              {outlet.name}
            </option>
          ))}
        </select>
      </p>

      <p className="field">
        <label htmlFor="fulfil-guests">Guests</label>
        <br />
        <input
          id="fulfil-guests"
          type="number"
          min="1"
          value={partySize}
          onChange={(e) => setPartySize(e.target.value)}
        />
      </p>

      <p className="field">
        <label htmlFor="fulfil-bill">Bill total (QAR)</label>
        <br />
        <input
          id="fulfil-bill"
          type="number"
          min="0"
          step="0.01"
          value={billAmount}
          onChange={(e) => setBillAmount(e.target.value)}
        />
        {/* Without this, nothing lets finance match this row against the
            transaction their own till already recorded. */}
        <span className="field-hint">Needed to reconcile against the till.</span>
      </p>

      <p>
        <button type="submit" disabled={busy || !outletId}>
          Record it
        </button>{' '}
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </p>

      {/* Screen 10 note 4: the system records, it does not discount. Nobody
          should think pressing this changed what the guest paid. */}
      <p className="till-note">
        This records that the discount was given. Applying it to the bill happens on the
        till, as always.
      </p>

      {error ? <p role="alert">{error}</p> : null}
    </form>
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
                {row.benefit.title} · {row.discountPctApplied}%
              </td>
              <td>{row.outlet.name}</td>
              <td>{row.partySize ?? '—'}</td>
              {/* D4 note 2: every entry names the administrator who recorded
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
