/**
 * SMS delivery of one-time passcodes — the destination `code-sender.ts` has
 * been pointing at since Stage 18.
 *
 * ## Why this is worth the money, when email costs nothing
 *
 * `security-implementation.md` §3 makes a member's passcode the *whole* of
 * their authentication — phone number and code, no password. So whoever
 * controls the delivery channel controls the membership. A mailbox is often
 * protected by a reused password and read on shared devices; a handset is not.
 * `code-sender.ts` states plainly that email is "acceptable for a pilot and not
 * acceptable at full launch", and this is the file that closes that gap.
 *
 * It also removes an operational limit nobody expects: `admin-members.ts`
 * refuses to create a member without an email address while the channel is
 * SMTP. A guest at this hotel hands over a phone number readily and an email
 * address sometimes. On SMS that constraint disappears.
 *
 * ## Why an outlet notice never goes by SMS
 *
 * An `OutletDelivery` carries an `email` and no phone at all: an outlet is a
 * mailbox, not a handset. There is no SMS address to send it to, so that one
 * message type is always the fallback sender's job.
 *
 * ## Why a member's own notices do
 *
 * `CodeDelivery` (a passcode) and `LifecycleDelivery` ("the outlet has been
 * told", "your benefit was recorded") both carry the member's own phone. At
 * the carrier's published rate SMS costs roughly 170× what email does, so this
 * is a real spend and not a free upgrade — but a guest who is standing at a
 * restaurant door benefits from a text landing on the handset in their hand
 * the same way a passcode does, and email silently going unread is exactly the
 * failure mode a member-facing product notice cannot afford. So both message
 * types are attempted over SMS first.
 *
 * Falling back to the mail sender is not a compromise here the way it would be
 * for a passcode: nothing about a lifecycle notice must produce an identical
 * response regardless of outcome (there is no membership-oracle concern), so
 * a missing phone number or a carrier rejection can simply fall through to
 * email rather than the delivery being lost outright.
 *
 * So this sender routes by purpose — **anything with a member's own phone
 * over SMS, an outlet notice to the fallback sender** — and requires both to
 * be configured, because the fallback is still load-bearing for outlet mail
 * and for any member who has no phone on record.
 */
import type { FastifyBaseLogger } from 'fastify';

import type { Env } from '../config/env.js';
import type {
  AnyDelivery,
  CodeDelivery,
  CodeSender,
  DeliveryOutcome,
  LifecycleDelivery,
} from './code-sender.js';
import {
  createDispatcher,
  segmentsFor,
  type SmsDispatcher,
  type SmsMessage,
  type SmsTransport,
} from './sms-transport.js';

/**
 * The passcode bodies.
 *
 * Three rules, and each one is a cost or a security decision rather than a
 * stylistic one:
 *
 *   1. **One segment.** Every body here stays inside the 160-character GSM-7
 *      budget. `assertSingleSegment` enforces it at construction rather than
 *      trusting the author to count, because the failure is invisible — a
 *      two-segment message sends perfectly and bills twice, for as long as
 *      nobody notices.
 *   2. **Latin script only.** An Arabic body forces UCS-2 and cuts the budget
 *      to 70 characters, so Stage 22's localisation must add an Arabic template
 *      that fits *that* budget rather than translating these in place.
 *   3. **No membership number, no name, no benefit.** §9 again: an SMS renders
 *      on a lock screen, and the lock screen of a member of this programme is
 *      not a place to restate who they are.
 */
function passcodeBody(delivery: CodeDelivery, ttlMinutes: number): string {
  if (delivery.purpose === 'invitation') {
    return (
      `You are invited to join Privilege Guest. Activation code: ${delivery.code}. ` +
      `Valid ${delivery.validFor ?? 'for a limited period'}. Open the app to begin.`
    );
  }

  const verb = delivery.purpose === 'activation' ? 'activate your membership' : 'sign in';
  return (
    `Privilege Guest: use code ${delivery.code} to ${verb}. ` +
    `Expires in ${ttlMinutes} min. Never share it.`
  );
}

/**
 * Refuses to build a sender whose own templates overrun a segment.
 *
 * Runs once at startup against the longest plausible rendering of each
 * template, so a body that would have doubled the bill fails the deployment
 * instead of quietly costing money. The sample values are deliberately at the
 * pessimistic end: a long validity phrase and a six-digit code.
 */
export function assertSingleSegment(ttlMinutes: number): void {
  const samples: CodeDelivery[] = [
    { email: null, phone: '+97455550003', code: '920515', purpose: 'sign-in' },
    { email: null, phone: '+97455550003', code: '920515', purpose: 'activation' },
    {
      email: null,
      phone: '+97455550003',
      code: 'ABCD-1234-EFGH',
      purpose: 'invitation',
      validFor: 'for 30 days',
    },
  ];

  for (const sample of samples) {
    const body = passcodeBody(sample, ttlMinutes);
    const { segments, encoding, headroom } = segmentsFor(body);
    if (segments > 1) {
      throw new Error(
        `The "${sample.purpose}" SMS template renders as ${segments} ${encoding} segments ` +
          `(${body.length} characters). Every segment is billed separately — shorten it to fit one.`,
      );
    }
    if (headroom < 0) {
      throw new Error(`The "${sample.purpose}" SMS template overruns its segment budget.`);
    }
  }
}

/**
 * Cuts a free-text field down before it reaches a template.
 *
 * `benefitTitle` and `outletName` are administrator-authored and have no
 * length that keeps a passcode-style template inside one segment by
 * construction — a title can run to 200 characters. Rather than let one long
 * title silently push an entire lifecycle notice into a two- or
 * three-segment bill, every rendering is bounded here. The ellipsis is three
 * ASCII periods rather than the Unicode `…` character on purpose: that single
 * character sits outside the GSM-7 alphabet and would force the *whole
 * message* to UCS-2 encoding, cutting the segment budget from 160 characters
 * to 70 — exactly the silent-cost failure this function exists to prevent.
 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/**
 * A plain ASCII "QAR 12.34", not `Intl.NumberFormat`.
 *
 * The email version (`smtp-sender.ts`) formats through `Intl.NumberFormat`,
 * which is correct there and unsafe here: depending on the ICU data available
 * at runtime, a currency format can insert a non-breaking space between the
 * symbol and the amount, and that single character is enough to tip the whole
 * message into UCS-2 for the same reason the ellipsis above is banned.
 */
function qarPlain(minor: number): string {
  return `QAR ${(minor / 100).toFixed(2)}`;
}

const MAX_TITLE_CHARS = 40;
const MAX_OUTLET_CHARS = 30;

/**
 * The lifecycle bodies: "the outlet has been told", "not used", "recorded".
 *
 * Unlike `passcodeBody`, these are not covered by `assertSingleSegment` —
 * `benefitTitle` and `outletName` are variable-length business data, not a
 * fixed template, so no startup check can guarantee one segment for every
 * value an administrator might enter. `truncate` keeps the realistic case
 * inside one segment without pretending to guarantee it for every case.
 *
 * No membership number, no member name — the same §9 rule `passcodeBody`
 * follows, for the same reason: this renders on a lock screen.
 */
function lifecycleSmsBody(delivery: LifecycleDelivery): string {
  const title = truncate(delivery.benefitTitle, MAX_TITLE_CHARS);

  switch (delivery.purpose) {
    case 'request-submitted': {
      const outlet = delivery.outletName ? truncate(delivery.outletName, MAX_OUTLET_CHARS) : 'The outlet';
      return `Privilege Guest: ${outlet} has been told you are coming for ${title}. Just show your card.`;
    }
    case 'request-not-used':
      return `Privilege Guest: ${title} was not used, nothing recorded. Your benefit is still available.`;
    case 'redemption-recorded': {
      const at = delivery.outletName ? ` at ${truncate(delivery.outletName, MAX_OUTLET_CHARS)}` : '';
      const saved =
        delivery.savedMinor === null || delivery.savedMinor === undefined
          ? ''
          : `, saved ${qarPlain(delivery.savedMinor)}`;
      return `Privilege Guest: ${title} recorded${at}${saved}.`;
    }
  }
}

export interface SmsSenderOptions {
  transport: SmsTransport;
  /**
   * Handles outlet notices (no phone to reach) and stands in for a member
   * notice when there is no phone on record or the carrier rejects one.
   */
  fallback: CodeSender;
  env: Env;
  log: FastifyBaseLogger;
}

export function createSmsSender({ transport, fallback, env, log }: SmsSenderOptions): CodeSender {
  const ttlMinutes = Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60));
  assertSingleSegment(ttlMinutes);

  const dispatcher: SmsDispatcher = createDispatcher(transport, log, {
    maxConcurrent: env.SMS_MAX_CONCURRENT,
    maxPerSecond: env.SMS_MAX_PER_SECOND,
    maxAttempts: env.SMS_MAX_ATTEMPTS,
  });

  return {
    name: `sms:${transport.name}`,

    async send(delivery: AnyDelivery): Promise<DeliveryOutcome> {
      if ('code' in delivery) {
        // A member with no phone number cannot exist — it is the identifier
        // they sign in with — so this is a genuine invariant failure rather
        // than the ordinary missing-email case the SMTP sender handles.
        if (!delivery.phone) {
          return { delivered: false, reason: 'no_address' };
        }

        const message: SmsMessage = { to: delivery.phone, body: passcodeBody(delivery, ttlMinutes) };
        const result = await dispatcher.send(message);

        if (result.ok) {
          return { delivered: true };
        }

        // The reason is carried into the log by `logDeliveryOutcome`, and the
        // caller's HTTP response stays identical either way — §3 requires the
        // sign-in endpoint to answer the same whether or not the identifier
        // exists, and a delivery failure must not become the tell.
        return {
          delivered: false,
          reason: result.reason === 'invalid_recipient' ? 'no_address' : 'transport_failed',
        };
      }

      // An outlet notice has no phone number at all — straight to mail.
      // A member lifecycle notice has one whenever the member does, and is
      // attempted over SMS first; there is no membership-oracle constraint
      // here, so a missing number or a carrier failure can fall through to
      // mail instead of the notice being lost. See the header.
      if ('phone' in delivery && delivery.phone) {
        const message: SmsMessage = { to: delivery.phone, body: lifecycleSmsBody(delivery) };
        const result = await dispatcher.send(message);
        if (result.ok) {
          return { delivered: true };
        }
      }

      return fallback.send(delivery);
    },
  };
}

/**
 * Sends one body to many recipients through the same pacing as a passcode.
 *
 * Not wired to a route: nothing in the product broadcasts today. It exists
 * because "notify the membership that a benefit changed" is the obvious next
 * request, and the answer to it should be this function rather than a loop
 * somewhere that calls `send` ten thousand times and gets the account throttled.
 *
 * Callers are responsible for the body fitting one segment — `segmentsFor` is
 * exported for exactly that check — and for having a lawful basis to send it,
 * which is a consent question and not a technical one.
 */
export async function broadcast(
  dispatcher: SmsDispatcher,
  recipients: readonly string[],
  body: string,
): Promise<{ sent: number; failed: number }> {
  const summary = await dispatcher.sendMany(recipients.map((to) => ({ to, body })));
  return { sent: summary.sent, failed: summary.failed };
}
