import { formatDate, formatMoney, formatTimestamp } from '@pgp/ui/format';

import type { Redemption } from '../api.js';

/**
 * One visit in the recent-activity list: a category tile, what was used and
 * where, and the date over what it saved.
 *
 * Three things here are worth stating because each is a decision:
 *
 * **The initials are derived, never stored.** Two letters off the benefit
 * title, which follows an administrator renaming a benefit without anything
 * needing to be migrated.
 *
 * **`category` picks the tile colour, and that is presentation.** It is not a
 * benefit value in the R14 sense — nothing about the discount, the caps or the
 * terms is encoded here — so a hue per category is allowed to live in the
 * client. An unrecognised category gets the neutral tile rather than a guess.
 *
 * **A missing amount stays missing.** `savedMinor` is null when no bill was
 * captured, which is ordinary; it renders as a dash. Showing "QAR 0" there
 * would tell a member a visit saved them nothing.
 */
export function ActivityRow({
  redemption,
  category,
}: {
  redemption: Redemption;
  /** From the matching `Benefit`; absent if the benefits list has not loaded. */
  category?: string | undefined;
}) {
  const initials = redemption.benefit.title
    .replace(/[^\p{L}\p{N}\s&]/gu, '')
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  const saved = formatMoney(redemption.savedMinor);

  return (
    <li className="activity-row">
      <span className="activity-tile" data-category={category?.toLowerCase() ?? 'other'}>
        {initials}
      </span>

      <span className="activity-text">
        <span className="activity-title">
          {redemption.benefit.title}
          {redemption.reversesId === null ? null : (
            <span className="badge" data-tone="warn">
              reversed
            </span>
          )}
        </span>
        <span className="activity-meta">
          {redemption.outlet.name} · {redemption.discountPctApplied}%
          {redemption.partySize === null ? '' : ` · ${String(redemption.partySize)} guests`}
        </span>
      </span>

      <span className="activity-figures">
        {/* Day only in the list; the full second it was recorded is on the
            element's title, because "did I already use the spa discount today"
            is answered by a date and a dispute is answered by a timestamp. */}
        <time className="activity-date" dateTime={redemption.occurredAt}>
          <span title={formatTimestamp(redemption.occurredAt)}>
            {formatDate(redemption.occurredAt)}
          </span>
        </time>
        <span className="activity-saved">{saved ?? '—'}</span>
      </span>
    </li>
  );
}
