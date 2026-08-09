import type { ReactNode } from 'react';

/**
 * A label/value pair with a hairline under it, as used down the benefit detail
 * screen.
 *
 * `<dt>`/`<dd>` inside a `<dl>` rather than two spans: this is a list of
 * term-and-definition pairs, which is the one thing a description list is for,
 * and it gives a screen reader the pairing for free. The caller supplies the
 * surrounding `<dl>` so a run of rows is one list rather than several.
 */
export function DetailRow({
  label,
  children,
  tone,
}: {
  label: ReactNode;
  children: ReactNode;
  /** `sand` marks a value worth acting on — the reservation number. */
  tone?: 'default' | 'sand';
}) {
  return (
    <div className="detail-row">
      <dt className="detail-label">{label}</dt>
      <dd className={`detail-value detail-value-${tone ?? 'default'}`}>{children}</dd>
    </div>
  );
}
