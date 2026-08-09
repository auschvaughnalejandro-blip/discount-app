import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

/**
 * A labelled input, with the parts the design actually uses: an uppercase
 * field label, an optional static prefix inside the well, a helper line and an
 * error line.
 *
 * The label is always rendered. Where the board shows no label — the passcode
 * screen, the note field — it is visually hidden rather than dropped, because
 * a placeholder is not a label: it disappears on the first keystroke, which is
 * exactly when someone returning to a half-filled form needs to know what the
 * box was for.
 *
 * Errors are wired with `aria-describedby` and `aria-invalid` rather than only
 * coloured, and appear under the field. Never an alert — an `alert()` on a
 * mistyped phone number is a modal interruption for something the member can
 * see and fix in place.
 */

// `prefix` is shadowed deliberately: HTML has a `prefix` attribute of its own
// (RDFa, a string), and the input never wants it. Omitting it here means the
// name is free for the thing this design system means by it.
interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'prefix'> {
  label: string;
  /** Hides the label visually and leaves it for assistive technology. */
  hideLabel?: boolean;
  /** Static, non-editable text inside the well — the `+974` dial code. */
  prefix?: ReactNode;
  helper?: ReactNode;
  error?: string | null;
}

export function Field({ label, hideLabel = false, prefix, helper, error, ...input }: FieldProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;

  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="field">
      <label className={hideLabel ? 'field-label visually-hidden' : 'field-label'} htmlFor={id}>
        {label}
      </label>

      <div className="field-well" data-invalid={error ? 'true' : 'false'}>
        {prefix === undefined ? null : (
          // aria-hidden: the dial code is already part of the label's meaning
          // ("Mobile number"), and announcing "+974" as a separate object
          // between the label and the box is noise on the way to the input.
          <span className="field-prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={id}
          className="field-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          {...input}
        />
      </div>

      {helper === undefined ? null : (
        <p className="field-helper" id={helperId}>
          {helper}
        </p>
      )}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
