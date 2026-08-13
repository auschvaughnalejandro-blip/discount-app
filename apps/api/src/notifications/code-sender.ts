/**
 * Delivery of one-time passcodes — Stage 18, closing PROGRESS.md **Q6**.
 *
 * ## What the client asked for, and what this actually is
 *
 * The answer to Q6 was "use Gmail, over SMTP". Gmail cannot send SMS — no
 * public email-to-SMS gateway exists for Ooredoo or Vodafone Qatar, and the US
 * carrier gateways that once served this purpose are unrelated to +974 numbers.
 * So the code is delivered **by email** instead, to the address on the member's
 * record. The phone number remains the identifier and the thing the member
 * types; only the delivery channel changed.
 *
 * ## Why this is an interim measure and not the destination
 *
 * `security-implementation.md` §3 specifies member authentication as "phone
 * number and one-time passcode. No passwords for members." That single factor
 * is the whole of a member's authentication, so **whoever controls the mailbox
 * controls the membership.** An SMS to a handset the member is holding is a
 * meaningfully stronger channel than a mailbox that may itself be protected by
 * a reused password.
 *
 * That is acceptable for a pilot and not acceptable at full launch. The
 * `CodeSender` seam below exists so swapping to Twilio or Unifonic is one new
 * file and one environment variable, with no route changes.
 *
 * ## What is deliberately unchanged
 *
 * The plaintext code is still never logged, never persisted in the clear and
 * never returned by the API. `issueOtp` stores only an Argon2id hash. A
 * delivery failure must not alter the HTTP response either, because §3 requires
 * identical responses whether or not the identifier exists — on a membership
 * this exclusive, confirming that a phone number belongs to a member is itself
 * a disclosure.
 */
import type { FastifyBaseLogger } from 'fastify';

import type { Env } from '../config/env.js';

/**
 * Why a code is being sent. Lets the template say something specific.
 *
 * `invitation` is the odd one out: it carries the single-use code that turns a
 * record into a real membership, it is valid for weeks rather than minutes, and
 * it is the only one an administrator has ever been able to see.
 */
export type CodePurpose = 'sign-in' | 'activation' | 'invitation';

/**
 * `request-approved` is gone, because nothing approves a request any more — the
 * guest is already entitled and the notice only tells an outlet to expect them.
 * `request-declined` became `request-not-used`, which is a different fact: not a
 * refusal, just a visit that did not happen.
 */
export type LifecyclePurpose =
  | 'request-submitted'
  | 'request-not-used'
  | 'redemption-recorded';

export interface CodeDelivery {
  /** The member's email, when one is on record. `null` is a real case. */
  email: string | null;
  /** Normalised E.164. Never logged in full, and never put in a message body. */
  phone: string;
  code: string;
  purpose: CodePurpose;
  /**
   * How long the code lasts, in words already ("30 days", "5 minutes").
   * Formatted by the caller because only it knows which clock applies — a
   * passcode expires in minutes and an invitation in weeks, and a template
   * guessing between them would eventually tell a member the wrong thing.
   */
  validFor?: string;
}

/** A transactional update about a benefit request or recorded redemption. */
export interface LifecycleDelivery {
  email: string | null;
  phone: string;
  purpose: LifecyclePurpose;
  benefitTitle: string;
  reason?: string;
  outletName?: string;
  discountPct?: string;
  savedMinor?: number | null;
}

/**
 * A notice sent to an outlet, telling them a guest is coming.
 *
 * ## Why this one may carry identifying detail
 *
 * Every other delivery in this file deliberately carries no membership number,
 * name or benefit — §9 treats the membership list as a record of named prominent
 * individuals, and a member's own inbox is not a place to restate who they are.
 *
 * This message is different in audience, not in principle. It goes to an internal
 * operational mailbox at the hotel, and it is useless without the benefit and the
 * number: an outlet cannot honour "somebody is coming for something". So it
 * carries the membership **number**, which is what staff already read off the
 * card, and never the member's name.
 *
 * The note is the guest's own free text and is the one field a hotel may decide
 * not to send onward at all — `includeNote` is that decision, made by
 * configuration rather than by this template. See DECISIONS.md.
 */
export interface OutletDelivery {
  /** The outlet's notification address. `null` is a real, supported case. */
  email: string | null;
  purpose: 'outlet-request';
  outletName: string;
  /** Never the member's name (§9). */
  memberNumber: string;
  benefitTitle: string;
  discountPct: string;
  note?: string;
  includeNote: boolean;
}

export type MemberDelivery = CodeDelivery | LifecycleDelivery;

export type AnyDelivery = MemberDelivery | OutletDelivery;

export type DeliveryOutcome =
  | { delivered: true }
  /**
   * Delivery failed. The caller must **not** vary its HTTP response on this —
   * see the note above. It is recorded so an operator can see the failure.
   */
  | { delivered: false; reason: 'no_address' | 'transport_failed' | 'not_configured' };

export interface CodeSender {
  readonly name: string;
  send(delivery: AnyDelivery): Promise<DeliveryOutcome>;
}

/**
 * The sender used when nothing is configured.
 *
 * Not an error: for stages 0–17 this was the only state. Returning a
 * reason rather than throwing keeps a misconfigured production instance
 * answering requests normally while logging loudly, instead of failing every
 * sign-in with a 500 that also happens to confirm which numbers are members.
 */
export const nullSender: CodeSender = {
  name: 'none',
  send: () => Promise.resolve({ delivered: false, reason: 'not_configured' }),
};

/**
 * Last four digits only. §9 forbids phone numbers in application logs, and a
 * delivery failure still needs to be traceable to a member by someone holding
 * the database.
 */
export function maskPhone(phone: string): string {
  return `••••••${phone.slice(-4)}`;
}

/**
 * Masked local part, whole domain. Enough to tell "wrong domain" from "typo"
 * while reading logs, without writing a member's address into them (§9).
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '••••';
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}••••${domain}`;
}

/**
 * Records the outcome without leaking the recipient or the code.
 *
 * Deliberately `warn` on failure rather than `error`: a member with no email on
 * record is a data-completeness problem for an administrator to fix, not a
 * fault in the service.
 */
export function logDeliveryOutcome(
  log: FastifyBaseLogger,
  sender: CodeSender,
  delivery: AnyDelivery,
  outcome: DeliveryOutcome,
): void {
  const base = {
    sender: sender.name,
    purpose: delivery.purpose,
    // An outlet notice has no member phone number in it at all, so there is
    // nothing to mask — and printing a mask for an absent value would suggest
    // one had been sent.
    ...('phone' in delivery ? { phone: maskPhone(delivery.phone) } : {}),
  };

  if (outcome.delivered) {
    log.info(
      { ...base, recipient: delivery.email ? maskEmail(delivery.email) : null },
      'message delivered',
    );
    return;
  }

  log.warn({ ...base, reason: outcome.reason }, 'message delivery failed');
}

/**
 * Builds the configured sender. Called once at startup.
 *
 * Each transport is loaded lazily so a deployment that has not configured mail
 * or SMS does not pay for the dependency, and so a module's own configuration
 * errors surface here rather than at import time.
 *
 * `sms` is not an alternative to `smtp` but a layer over it: passcodes go to
 * the carrier and everything else falls through to mail. `env.ts` refuses to
 * start without both, so the SMTP sender below is always constructible by the
 * time this runs.
 */
export async function createCodeSender(env: Env, log: FastifyBaseLogger): Promise<CodeSender> {
  if (env.OTP_DELIVERY_CHANNEL === 'none') {
    log.warn(
      'OTP_DELIVERY_CHANNEL is "none": one-time passcodes are generated but not delivered. ' +
        'Members cannot sign in.',
    );
    return nullSender;
  }

  const { createSmtpSender } = await import('./smtp-sender.js');
  const smtp = createSmtpSender(env, log);

  if (env.OTP_DELIVERY_CHANNEL === 'smtp') {
    return smtp;
  }

  const [{ createSmsSender }, { createHttpTransport, createLoggingTransport }] = await Promise.all([
    import('./sms-sender.js'),
    import('./sms-transport.js'),
  ]);

  const transport =
    env.SMS_PROVIDER === 'log'
      ? createLoggingTransport(log)
      : createHttpTransport({
          name: 'http',
          // Present by construction: superRefine requires all four when the
          // channel is 'sms' and the provider is 'http'.
          endpoint: env.SMS_API_URL!,
          senderId: env.SMS_SENDER_ID!,
          username: env.SMS_API_USER!,
          password: env.SMS_API_PASSWORD!,
          timeoutMs: env.SMS_TIMEOUT_MS,
        });

  return createSmsSender({ transport, fallback: smtp, env, log });
}
