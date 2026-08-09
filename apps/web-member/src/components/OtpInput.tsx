import { useRef } from 'react';

/**
 * The six passcode boxes.
 *
 * One `<input>` per box rather than one input styled to look like six. The
 * six-input version is more code and it is the one that works: a single input
 * with letter-spacing cannot show which box is next, and on iOS it loses the
 * SMS autofill affordance entirely.
 *
 * Three behaviours carry the weight, and all three are the ones people notice
 * only when they are missing:
 *
 * - **Paste distributes.** Someone reading a code from another device copies
 *   all six digits. Pasting into the first box must fill all six, not put
 *   "483920" in box one. This also covers iOS SMS autofill, which arrives as a
 *   single multi-character value rather than as a paste event.
 * - **Backspace steps back.** Deleting from an empty box moves to the previous
 *   one and clears it, which is what a row of boxes implies. Without it the
 *   only way to fix the third digit is to tap it.
 * - **Non-digits never land.** Stripped rather than rejected, so pasting a code
 *   with a stray space still works.
 */

const LENGTH = 6;

export function OtpInput({
  value,
  onChange,
  error = false,
  label = 'Passcode',
}: {
  value: string;
  onChange: (next: string) => void;
  error?: boolean;
  label?: string;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const digits = value.padEnd(LENGTH, ' ').slice(0, LENGTH).split('');

  function focusBox(index: number) {
    boxes.current[Math.max(0, Math.min(LENGTH - 1, index))]?.focus();
  }

  /** Writes `incoming` starting at `index` and parks the caret after it. */
  function write(index: number, incoming: string) {
    const clean = incoming.replace(/\D/g, '');
    if (clean === '') {
      return;
    }
    const next = (
      value.slice(0, index).padEnd(index, ' ') +
      clean +
      value.slice(index + clean.length)
    )
      .slice(0, LENGTH)
      .trimEnd();

    onChange(next);
    focusBox(index + clean.length);
  }

  return (
    <fieldset className="otp-group" data-error={error ? 'true' : 'false'}>
      {/* The group needs a name of its own; each box is then numbered, so a
          screen reader announces "Passcode, digit 3 of 6" rather than six
          identically-labelled boxes. */}
      <legend className="visually-hidden">{label}</legend>

      {digits.map((digit, index) => (
        <input
          // Position is the identity here — there are exactly six boxes and
          // they never reorder.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          ref={(node) => {
            boxes.current[index] = node;
          }}
          className="otp-box"
          data-filled={digit.trim() === '' ? 'false' : 'true'}
          value={digit.trim()}
          aria-label={`Digit ${index + 1} of ${LENGTH}`}
          inputMode="numeric"
          autoComplete="one-time-code"
          // maxLength is 1 for the look; the handler still accepts a longer
          // value because autofill and paste both deliver the whole code.
          maxLength={1}
          placeholder="•"
          onChange={(event) => write(index, event.target.value)}
          onPaste={(event) => {
            event.preventDefault();
            write(index, event.clipboardData.getData('text'));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              event.preventDefault();
              if (digit.trim() === '') {
                // Empty box: clear the one before and go there.
                const previous = Math.max(0, index - 1);
                onChange(value.slice(0, previous));
                focusBox(previous);
              } else {
                onChange(value.slice(0, index));
              }
            }
            if (event.key === 'ArrowLeft') {
              focusBox(index - 1);
            }
            if (event.key === 'ArrowRight') {
              focusBox(index + 1);
            }
          }}
        />
      ))}
    </fieldset>
  );
}
