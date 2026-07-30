/**
 * The dashboard's landing screen.
 *
 * ## Why this screen was added
 *
 * The dashboard used to open on the member table, and the four headline figures
 * lived behind a `reports` tab. So the first thing an administrator saw was a
 * hundred rows of names — the densest, least summarised view in the product —
 * and the numbers that say whether the programme is working took a deliberate
 * click to reach. Wireframes D5 has the figures; nothing put them first.
 *
 * This screen answers "how is the programme doing" above the fold, and every
 * panel below it is a route into the section that can act on it. Nothing here is
 * a new measurement: it is the existing report endpoints, arranged by how often
 * they are looked at.
 *
 * ## Suppression is a first-class state here, not an error
 *
 * Four of the six figures are cohort-suppressed (R13): under
 * `minCohortSize` distinct members, the server returns `insufficient_data`
 * instead of a number, so that a narrow enough report cannot describe one named
 * person. On a pilot-sized database that is the *normal* state, not a fault —
 * so the screen says which figures are withheld and why, rather than rendering
 * a blank tile that reads as broken.
 *
 * Membership totals are exempt (they describe the programme, not a slice of
 * behaviour), which is why the reach meter and the attention lists still work on
 * a database too small to report on. Those are deliberately what the layout
 * leans on.
 */
import { useEffect, useState } from 'react';

import { formatTimestamp } from '@pgp/ui/format';

import {
  api,
  type BenefitGroup,
  type ReportMember,
  type ReportSummary,
} from './api.js';
import { BarChart, formatMinor, Meter, StatTile } from './Charts.js';

type RecentRedemption = Awaited<ReturnType<typeof api.redemptions>>['redemptions'][number];

export default function Overview({ onNavigate }: { onNavigate: (to: 'members' | 'redemptions' | 'reports') => void }) {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [byBenefit, setByBenefit] = useState<BenefitGroup[]>([]);
  const [dormant, setDormant] = useState<ReportMember[]>([]);
  const [unclaimed, setUnclaimed] = useState<ReportMember[]>([]);
  const [recent, setRecent] = useState<RecentRedemption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.summary(),
      api.byBenefit(),
      api.dormant(),
      api.unclaimed(),
      api.redemptions(),
    ])
      .then(([s, b, d, u, r]) => {
        if (cancelled) return;
        setSummary(s);
        setByBenefit(b.groups);
        setDormant(d.members);
        setUnclaimed(u.members);
        setRecent(r.redemptions);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not load the overview.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <section>
        <h2>Overview</h2>
        <p role="alert">{error}</p>
      </section>
    );
  }

  if (!summary) {
    return (
      <section>
        <h2>Overview</h2>
        <p>Loading…</p>
      </section>
    );
  }

  const used = Math.max(0, summary.totalMembers - summary.neverUsed);

  return (
    <section>
      <h2>Overview</h2>
      <p className="section-lede">
        Every figure is live. Benefit changes reach members without a release.
      </p>

      {/* ── The six headline figures ──────────────────────────────────────
          Membership totals first, because they are the two that are never
          withheld — so the row always leads with something real. */}
      <ul className="kpi-row">
        <StatTile label="Members" value={summary.totalMembers} tone="ok" hint="Total on the programme" />
        <StatTile
          label="Never used a benefit"
          value={summary.neverUsed}
          tone={summary.neverUsed > 0 ? 'warn' : 'ok'}
          hint="The number the programme exists to move"
        />
        <StatTile label="Redemptions" value={summary.redemptions} hint="Reversals excluded" />
        <StatTile label="Guests hosted" value={summary.guests} hint="Party sizes, summed" />
        <StatTile label="Members redeeming" value={summary.activeMembers} hint="Distinct, in range" />
        <StatTile
          label="Est. value given"
          value={summary.estValueMinor}
          format={formatMinor}
          hint="Discount against recorded bills"
        />
      </ul>

      {summary.suppressed ? (
        <p className="note">
          Some figures above are withheld because fewer than {summary.minCohortSize} distinct members
          stand behind them. With a membership this size an unfiltered report could otherwise
          describe one named person, so the server returns no number at all. This is the reporting
          privacy rule working, not a fault — the figures appear once the programme passes{' '}
          {summary.minCohortSize} redeeming members.
        </p>
      ) : null}

      {/* ── The analytical band ───────────────────────────────────────────
          Chart on the left, the two things needing a decision on the right. */}
      <div className="dash-band">
        <div className="dash-main">
          <article className="panel">
            <h3 className="panel-title">Redemptions by benefit</h3>
            <div className="panel-body">
              {byBenefit.length === 0 ? (
                <p className="empty">
                  Nothing has been redeemed yet. Bars appear as staff record redemptions on the
                  verification page.
                </p>
              ) : (
                <BarChart
                  caption="Redemptions by benefit"
                  rows={byBenefit.map((g) => ({ label: g.label, value: g.redemptions }))}
                  unit="Redemptions"
                />
              )}
            </div>
          </article>

          <RecentPanel recent={recent} onViewAll={() => onNavigate('redemptions')} />
        </div>

        <div className="dash-rail">
          <article className="panel">
            <h3 className="panel-title">Programme reach</h3>
            <div className="panel-body">
              <Meter
                value={used}
                total={summary.totalMembers}
                filledLabel="Used a benefit"
                emptyLabel="Never have"
              />
            </div>
          </article>

          {/* D5 note 3: six personally invited guests who have never used
              anything is a list for the General Manager, not a statistic. So it
              is a list, with the names, and a way to act on it. */}
          <article className="panel">
            <h3 className="panel-title">Needs attention</h3>
            <div className="panel-body">
              <AttentionList
                heading="Never used a benefit"
                members={dormant}
                emptyText="Every member has used something."
                onViewAll={() => onNavigate('reports')}
              />
              <AttentionList
                heading="Card issued, app never claimed"
                members={unclaimed}
                emptyText="Every member has claimed the app."
                onViewAll={() => onNavigate('members')}
              />
            </div>
          </article>
        </div>
      </div>

    </section>
  );
}

/** The tail of the redemption log — enough to see activity, not to audit it. */
function RecentPanel({
  recent,
  onViewAll,
}: {
  recent: RecentRedemption[];
  onViewAll: () => void;
}) {
  return (
    <article className="panel">
      <h3 className="panel-title">Latest redemptions</h3>
      {recent.length === 0 ? (
        <div className="panel-body">
          <p className="empty">No redemptions recorded yet.</p>
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">The eight most recent redemptions</caption>
              <thead>
                <tr>
                  <th scope="col">Date and time</th>
                  <th scope="col">Member</th>
                  <th scope="col">Benefit</th>
                  <th scope="col">Outlet</th>
                  <th scope="col">Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 8).map((row) => (
                  <tr key={row.id}>
                    <td>{formatTimestamp(row.occurredAt)}</td>
                    <td className="member-number">{row.member.memberNumber}</td>
                    <td>
                      {row.benefit.title}
                      {row.reversesId ? (
                        <>
                          {' '}
                          <span className="badge" data-tone="neutral">
                            reversal
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>{row.outlet.name}</td>
                    {/* D4 note 2: every entry names the staff member who
                        recorded it. Attribution is the deterrent. */}
                    <td>{row.staffUser.fullName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-footer">
            <button type="button" onClick={onViewAll}>
              See the full log
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/**
 * One attention list. Capped, because this panel is a prompt to act rather than
 * the report itself — the full list is one button away and is audit-logged when
 * it names individuals.
 */
function AttentionList({
  heading,
  members,
  emptyText,
  onViewAll,
}: {
  heading: string;
  members: ReportMember[];
  emptyText: string;
  onViewAll: () => void;
}) {
  return (
    <div className="attention">
      <p className="attention-head">
        <span>{heading}</span>
        <span className="badge" data-tone={members.length === 0 ? 'ok' : 'warn'}>
          {members.length}
        </span>
      </p>

      {members.length === 0 ? (
        <p className="empty">{emptyText}</p>
      ) : (
        <>
          <ul className="attention-list">
            {members.slice(0, 4).map((member) => (
              <li key={member.id}>
                <span>{member.fullName}</span>
                <span className="member-number">{member.memberNumber}</span>
              </li>
            ))}
          </ul>
          {members.length > 4 ? (
            <button type="button" className="text-button" onClick={onViewAll}>
              View all {members.length}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
