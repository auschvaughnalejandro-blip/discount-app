/**
 * The dashboard's figures and charts.
 *
 * ## Why these are HTML and not SVG
 *
 * A bar and a meter are both "one rectangle against a track", and HTML draws
 * that with `inline-size` and a logical border radius. SVG would need explicit
 * `x`/`width` arithmetic, which has to be mirrored by hand for Stage 22's
 * Arabic layout — whereas `border-start-end-radius` and `inline-size` mirror
 * themselves under `dir="rtl"` for nothing. Text also stays real text: it wraps,
 * it scales with the user's font size, and it is selectable, none of which is
 * true of `<text>` in an SVG.
 *
 * SVG earns its place for a line or an area, where the mark is a path rather
 * than a rectangle. Nothing here is.
 *
 * ## Colour decisions, and why they are decisions
 *
 * Benefit names are **nominal** — reordering "Spa" and "Rooms" changes nothing —
 * so every bar takes the *same* hue, and the chart carries no legend because it
 * plots one series that its own caption names. Colouring the five bars five ways
 * would spend the identity channel restating what bar length already shows, and
 * shading them darker-where-bigger would double-encode the value. Both are
 * common and both are wrong.
 *
 * The meter's unfilled track is a lighter step of the same teal rather than a
 * second hue, so state reads across the whole bar. `--c-primary-soft` was the
 * obvious candidate and measured 1.13:1 against a white panel — invisible. The
 * track token in `charts.css` was picked by measuring contrast, not by eye.
 *
 * Values, labels and axis text wear text tokens throughout. A colour this light
 * is illegible as text; identity comes from the mark beside the words.
 */
import { isWithheld, type Figure } from './api.js';
import './charts.css';

// ── Number formatting ────────────────────────────────────────────────────

/**
 * Minor units to a displayable amount, **without floating point**.
 *
 * `billAmountMinor` is an integer number of dirhams and the estimated value is
 * a sum of integers. Dividing by 100 to display it is the single `parseFloat`
 * that RUNBOOK.md §4 warns reintroduces rounding error into a money total, so
 * this splits the digits as a string instead: exact for every value, and it
 * cannot drift as the total grows.
 */
export function formatMinor(minor: number): string {
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(3, '0');
  const major = Number(digits.slice(0, -2)).toLocaleString();
  return `${negative ? '-' : ''}${major}.${digits.slice(-2)}`;
}

/** Thousands separators. Counts stay exact — no compacting to "1.2K". */
function formatCount(value: number): string {
  return value.toLocaleString();
}

// ── Withheld figures ─────────────────────────────────────────────────────

/**
 * Every figure passes through here, so a withheld one can never reach the page
 * as a raw sentinel. It reads as deliberately withheld rather than as missing
 * data, because that is what it is — the suppression is a privacy control
 * working, not a gap.
 */
export function FigureValue({ value, format }: { value: Figure; format?: (n: number) => string }) {
  if (isWithheld(value)) {
    return (
      <span className="suppressed" title="Fewer members than the reporting minimum">
        insufficient data
      </span>
    );
  }
  return <>{(format ?? formatCount)(value)}</>;
}

// ── Stat tile ────────────────────────────────────────────────────────────

/**
 * One headline number. A tile rather than a one-bar chart — the number *is* the
 * chart, and a single bar has nothing to compare against.
 *
 * `tone` tints the border only. What the tile means is always spelled out in
 * the label, so the tone is emphasis and never the sole carrier of meaning.
 */
export function StatTile({
  label,
  value,
  tone,
  hint,
  format,
}: {
  label: string;
  value: Figure;
  tone?: 'ok' | 'warn' | 'critical';
  hint?: string;
  format?: (n: number) => string;
}) {
  return (
    <li className="stat" {...(tone ? { 'data-tone': tone } : {})}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        <FigureValue value={value} {...(format ? { format } : {})} />
      </span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </li>
  );
}

// ── Bar chart ────────────────────────────────────────────────────────────

export interface BarRow {
  label: string;
  value: Figure;
}

/**
 * Horizontal bars comparing one measure across named categories.
 *
 * Built as a real `<table>`, which is the whole accessibility story rather than
 * an ARIA description bolted onto a picture: the bar is decoration inside a cell
 * that already contains the number as text. A screen reader reads a two-column
 * table, a sighted reader sees a chart, and there is no second "table view" to
 * keep in sync with the first.
 *
 * Horizontal rather than vertical because the categories are words of differing
 * length; as column labels they would rotate or truncate.
 *
 * Bars are sorted longest first — the comparison is the point, and an
 * alphabetical order makes the reader do the ranking themselves. Withheld rows
 * sort last, since they have no length to rank.
 */
export function BarChart({
  caption,
  rows,
  unit,
}: {
  caption: string;
  rows: BarRow[];
  unit: string;
}) {
  const numeric = rows.filter((row): row is BarRow & { value: number } => !isWithheld(row.value));

  /**
   * The scale's ceiling. `Math.max` of nothing is `-Infinity`, and a zero here
   * would divide by zero — so an all-withheld or all-zero chart floors at 1 and
   * simply draws no length.
   */
  const max = Math.max(1, ...numeric.map((row) => row.value));

  const sorted = [...rows].sort((a, b) => {
    if (isWithheld(a.value)) return isWithheld(b.value) ? 0 : 1;
    if (isWithheld(b.value)) return -1;
    return b.value - a.value;
  });

  return (
    <table className="bar-chart">
      {/* The panel heading above already names this, so the caption exists for
          a screen reader rather than on screen. */}
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Benefit</th>
          <th scope="col">{unit}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>
              <span className="bar-cell">
                {isWithheld(row.value) ? (
                  /**
                   * A withheld row gets the reason where its bar would be,
                   * rather than an empty track and a long italic label crammed
                   * into the value column. That label is wider than any number,
                   * so leaving it there shortened this row's track and the bars
                   * stopped sharing a baseline — which is the one thing the
                   * chart exists to provide.
                   */
                  <span className="bar-note">insufficient data</span>
                ) : (
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      style={{ inlineSize: `${(row.value / max) * 100}%` }}
                    />
                  </span>
                )}
                <span className="bar-value">
                  {isWithheld(row.value) ? '—' : <FigureValue value={row.value} />}
                </span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Meter ────────────────────────────────────────────────────────────────

/**
 * One ratio against a whole.
 *
 * A meter and not a doughnut: two slices of a circle is the hardest possible way
 * to read a proportion, and the percentage has to be printed in the middle
 * anyway. Here the number is the headline and the bar is the supporting detail.
 *
 * Both ends are named in text — "used a benefit" and "never have" — so the two
 * parts of the ratio never depend on telling fill from track.
 */
export function Meter({
  value,
  total,
  filledLabel,
  emptyLabel,
}: {
  value: number;
  total: number;
  filledLabel: string;
  emptyLabel: string;
}) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);

  return (
    <div className="meter">
      <p className="meter-figure">
        {/* Proportional figures, not tabular: a standalone number this size
            looks loose when every digit is the width of a zero. */}
        {total === 0 ? '—' : `${pct}%`}
      </p>

      <div
        className="meter-track"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={filledLabel}
      >
        <div className="meter-fill" style={{ inlineSize: `${pct}%` }} />
      </div>

      <dl className="meter-legend">
        <div>
          <dt>{filledLabel}</dt>
          <dd>{formatCount(value)}</dd>
        </div>
        <div>
          <dt>{emptyLabel}</dt>
          <dd>{formatCount(Math.max(0, total - value))}</dd>
        </div>
      </dl>
    </div>
  );
}
