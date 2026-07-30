/**
 * Shared date and time formatting for the three clients.
 *
 * `occurredAt` has always been a full `DateTime` in Postgres, recorded by
 * `@default(now())` at millisecond precision — so the exact moment a
 * redemption was confirmed was never lost. It was being *discarded at the
 * point of display*: every client called `toLocaleDateString()`, which keeps
 * the day and throws the clock away.
 *
 * That matters because of what a redemption is for. Two members disputing
 * whether the spa discount was applied twice, or a staff member questioning an
 * entry against their name, cannot be answered by "sometime on the 30th" — the
 * hotel needs the second it happened, and that is what the row already holds.
 *
 * Seconds are therefore not optional here. `timeStyle: 'medium'` is the
 * shortest style that includes them; 'short' would silently drop them again and
 * reintroduce exactly the bug this file exists to fix.
 *
 * Times render in the *viewer's* timezone, which is what the clients already
 * did for dates. For a single-property hotel where staff, members and
 * administrators are all on site this is the same wall clock the counter runs
 * on. It stops being true for an administrator reviewing entries from another
 * country, and if that becomes real the fix belongs here — a configured
 * property timezone passed as `timeZone` — rather than at each call site.
 */

/**
 * Constructed once rather than per row. `Intl.DateTimeFormat` is expensive to
 * build and cheap to reuse, and these render inside list maps.
 *
 * `undefined` locale means the viewer's own, so a member in Doha and one in
 * Berlin each read the ordering they expect.
 */
const dateAndTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

const timeOnly = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'medium',
});

const dateOnly = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
});

/**
 * A malformed value must not take a whole table down with it. `Intl` throws a
 * `RangeError` on an invalid date, and one bad row rendering as its raw string
 * is a far better failure than a redemption history that will not load.
 */
function parse(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Day and clock time to the second — "30 Jul 2026, 2:29:40 pm".
 *
 * The default for anything listing when a redemption happened.
 */
export function formatTimestamp(value: string | Date): string {
  const date = parse(value);
  return date === null ? String(value) : dateAndTime.format(date);
}

/**
 * Clock time to the second, no date — "2:29:40 pm".
 *
 * For confirming something that just happened, where the day is implied by
 * standing there watching it happen.
 */
export function formatTimeOfDay(value: string | Date): string {
  const date = parse(value);
  return date === null ? String(value) : timeOnly.format(date);
}

/**
 * Day only. For dates where a clock time would be noise rather than evidence —
 * a join date, not an event.
 */
export function formatDate(value: string | Date): string {
  const date = parse(value);
  return date === null ? String(value) : dateOnly.format(date);
}
