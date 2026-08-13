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
 * ## Why it does not send everything by SMS
 *
 * At the carrier's published rate SMS costs roughly 170× what email does, and
 * two thirds of this system's traffic is not passcodes — it is "your benefit
 * was recorded", "the outlet has been told", and notices to outlet mailboxes.
 * None of that is security-critical and none of it is worth 170×.
 *
 * There is also a harder reason than cost. An `OutletDelivery` carries an
 * `email` and no phone at all: an outlet is a mailbox, not a handset. There is
 * no SMS address to send it to.
 *
 * So this sender routes by purpose — **passcodes over SMS, everything else to
 * the fallback sender** — and requires both to be configured. That is not a
 * compromise; it is the only arrangement that can deliver all four message
 * types.
 */
import type { FastifyBaseLogger } from 'fastify';

import type { Env } from '../config/env.js';
import type { AnyDelivery, CodeDelivery, CodeSender, DeliveryOutcome } from './code-sender.js';
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

export interface SmsSenderOptions {
  transport: SmsTransport;
  /**
   * Handles everything that is not a passcode. Required: an outlet notice has
   * no phone number, so without this those messages have nowhere to go.
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
      // Only the three code purposes justify the per-message cost. Lifecycle
      // notices and outlet notices go to the fallback — see the header.
      if (!('code' in delivery)) {
        return fallback.send(delivery);
      }

      // A member with no phone number cannot exist — it is the identifier they
      // sign in with — so this is a genuine invariant failure rather than the
      // ordinary missing-email case the SMTP sender handles.
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
