import { useId } from 'react';
import type { ReactNode } from 'react';

/**
 * The notification switch — 44 × 24 with a 9px knob.
 *
 * A real `<button role="switch">` rather than a styled checkbox. Both are
 * accessible when done carefully, but `role="switch"` announces "on"/"off"
 * where a checkbox announces "checked", and for a consent control the
 * difference is the whole meaning: a member is turning a channel on, not
 * ticking an agreement.
 *
 * The label is the tap target alongside the switch, so the 44px minimum is met
 * by the row rather than by inflating a 24px control.
 */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();

  return (
    <div className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label" id={id}>
          {label}
        </span>
        {description === undefined ? null : (
          <span className="toggle-description">{description}</span>
        )}
      </span>

      <button
        type="button"
        role="switch"
        className="toggle"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}
