/**
 * The three figures under the membership card, split by vertical hairlines.
 *
 * A figure may be `null`, which renders a skeleton rather than a zero. That
 * distinction is the point of the component: "0 visits" is a fact about a
 * member, and showing it while the history is still loading — or because a
 * request failed — states something untrue about them. Nothing here invents a
 * number, and a value that has not arrived looks like a value that has not
 * arrived.
 */

export interface Stat {
  label: string;
  /** `null` while unknown. Rendered as a skeleton, never as zero. */
  value: string | null;
  /** The leading figure is set in sand. */
  tone?: 'default' | 'sand';
}

/**
 * `<dd>` sits before `<dt>` below, which looks like a mistake and is not: the
 * design puts the figure above its label, and a description list permits the
 * pair in either visual order as long as they stay in the same group.
 * Reordering with CSS instead would leave the reading order — value, then what
 * it means — different from the visual one, for no gain.
 */
export function StatBar({ stats }: { stats: Stat[] }) {
  return (
    <dl className="statbar">
      {stats.map((stat) => (
        <div className="statbar-cell" key={stat.label}>
          <dd className={`statbar-value statbar-value-${stat.tone ?? 'default'}`}>
            {stat.value === null ? (
              <span className="skeleton statbar-skeleton" aria-hidden="true" />
            ) : (
              stat.value
            )}
          </dd>
          <dt className="statbar-label">{stat.label}</dt>
        </div>
      ))}
    </dl>
  );
}
