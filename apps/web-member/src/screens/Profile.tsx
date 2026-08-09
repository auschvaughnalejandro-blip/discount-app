import { useMemo, useState } from 'react';
import { formatMoney } from '@pgp/ui/format';

import { ActivityRow } from '../components/ActivityRow.js';
import { AppShell } from '../components/AppShell.js';
import { Button } from '../components/Button.js';
import { Eyebrow } from '../components/Eyebrow.js';
import { MembershipCard } from '../components/MembershipCard.js';
import { StatBar } from '../components/StatBar.js';
import { Toggle } from '../components/Toggle.js';
import { useAppNavigate } from '../navigation.js';
import { consentGranted, useSession } from '../session.js';
import type { Redemption } from '../api.js';

/**
 * `/profile` — the card, what the membership has been worth, and the controls.
 *
 * **Every figure on this screen is computed from the member's own redemption
 * history.** The design boards carry placeholder numbers; none of them appear
 * here. Until the history arrives each figure is a skeleton, and a figure that
 * cannot be computed from the data — a total saving where no visit recorded a
 * bill — renders as a dash rather than as zero.
 *
 * That distinction is the whole reason the stats are derived here rather than
 * read from a field: "QAR 0 saved" is a claim about a member's year, and it is
 * a different claim from "we did not write the amounts down".
 */

const VISIBLE_ROWS = 2;

/**
 * What a figure looks like once the history has arrived and the number still
 * cannot be computed — visits recorded, but no bill written down against any of
 * them, which includes every member who has not visited yet.
 *
 * Distinct from `null`, which `StatBar` renders as a skeleton. Both cases used
 * to return `null` from the memo below, so "Saved" loaded forever for exactly
 * the members whose saving was unknowable. The dash matches `ActivityRow`,
 * which has always shown an unrecorded amount this way.
 */
const NOT_RECORDED = '—';

/**
 * A visit, once reversals are taken out of the count.
 *
 * A reversal is recorded as its own row pointing at the row it undoes, and
 * neither row is deleted — the history is the evidence. So a visit counts when
 * it is not itself a reversal and nothing else reverses it. Counting raw rows
 * would show a member two visits for one meal that was corrected.
 */
function netVisits(redemptions: Redemption[]): Redemption[] {
  const reversed = new Set(
    redemptions.map((row) => row.reversesId).filter((id): id is string => id !== null),
  );
  return redemptions.filter((row) => row.reversesId === null && !reversed.has(row.id));
}

export function Profile() {
  const navigate = useAppNavigate();
  const { profile, benefits, redemptions, error, signOut, setConsent } = useSession();
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => {
    // The one state that may render as a skeleton: the history has not arrived,
    // either because it is still in flight or because the fetch failed. Past
    // this line every figure resolves to text.
    if (redemptions === null) {
      return { saved: null, visits: null, used: null };
    }

    const visits = netVisits(redemptions);

    // Reversals keep their negative saving so a corrected visit nets out, which
    // is why the sum runs over every row rather than over `visits`.
    const amounts = redemptions
      .map((row) => row.savedMinor)
      .filter((value): value is number => value !== null);

    return {
      // `formatMoney` returns null for an amount it will not invent; a finite
      // sum is never that, but the fallback keeps the skeleton unreachable
      // rather than merely unlikely.
      saved:
        amounts.length === 0
          ? NOT_RECORDED
          : (formatMoney(amounts.reduce((a, b) => a + b, 0)) ?? NOT_RECORDED),
      visits: String(visits.length),
      used: String(new Set(visits.map((row) => row.benefit.key)).size),
    };
  }, [redemptions]);

  const visits = redemptions === null ? [] : netVisits(redemptions);
  const shown = expanded ? visits : visits.slice(0, VISIBLE_ROWS);

  const categoryFor = (key: string) => benefits?.find((row) => row.key === key)?.category;

  return (
    <AppShell tabs="profile">
      <header className="screen-head">
        <h1 className="title">Profile</h1>
      </header>

      <MembershipCard
        fullName={profile?.fullName ?? null}
        memberNumber={profile?.memberNumber ?? null}
        href="/profile/card"
      />

      <StatBar
        stats={[
          { label: 'Saved', value: stats.saved, tone: 'sand' },
          { label: 'Visits', value: stats.visits },
          { label: 'Benefits used', value: stats.used },
        ]}
      />

      {error === null ? null : (
        <p role="alert" className="screen-alert">
          {error}
        </p>
      )}

      <section className="section">
        <Eyebrow tone="muted">Recent activity</Eyebrow>

        {redemptions === null ? (
          <ul className="activity-list" aria-busy="true" aria-label="Loading your visits">
            {[0, 1].map((row) => (
              <li key={row} className="activity-row">
                <span className="skeleton activity-tile" />
                <span className="skeleton skeleton-line" />
              </li>
            ))}
          </ul>
        ) : visits.length === 0 ? (
          <p className="empty">You have not used a benefit yet.</p>
        ) : (
          <>
            <ul className="activity-list">
              {shown.map((row) => (
                <ActivityRow key={row.id} redemption={row} category={categoryFor(row.benefit.key)} />
              ))}
            </ul>

            {visits.length > VISIBLE_ROWS ? (
              <button
                type="button"
                className="text-link view-all"
                onClick={() => {
                  setExpanded(!expanded);
                }}
                aria-expanded={expanded}
              >
                {expanded ? 'Show fewer' : `View all ${String(visits.length)} visits`}
              </button>
            ) : null}
          </>
        )}
      </section>

      <section className="section">
        <Eyebrow tone="muted">Notifications</Eyebrow>

        <Toggle
          label="Email"
          checked={consentGranted(profile?.consent, 'email')}
          disabled={profile === null}
          onChange={(next) => void setConsent('email', next)}
        />
        <Toggle
          label="SMS"
          checked={consentGranted(profile?.consent, 'sms')}
          disabled={profile === null}
          onChange={(next) => void setConsent('sms', next)}
        />
      </section>

      <Button
        variant="outline"
        onClick={() => {
          signOut();
          navigate('/signin', { kind: 'pop', replace: true });
        }}
      >
        Sign out
      </Button>
    </AppShell>
  );
}
