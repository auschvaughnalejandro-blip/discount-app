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

/** Why a code is being sent. Lets the template say something specific. */
export type CodePurpose = 'sign-in' | 'activation';

export interface CodeDelivery {
  /** The member's email, when one is on record. `null` is a real case. */
  email: string | null;
  /** Normalised E.164. Never logged in full, and never put in a message body. */
  phone: string;
  code: string;
  purpose: CodePurpose;
}

export type DeliveryOutcome =
  | { delivered: true }
  /**
   * Delivery failed. The caller must **not** vary its HTTP response on this —
   * see the note above. It is recorded so an operator can see the failure.
   */
  | { delivered: false; reason: 'no_address' | 'transport_failed' | 'not_configured' };

export interface CodeSender {
  readonly name: string;
  send(delivery: CodeDelivery): Promise<DeliveryOutcome>;
}

/**
 * The sender used when nothing is configured.
 *
 * Not an error: for stages 0–17 this was the only state, and the development
 * terminal echo (`src/security/dev-otp.ts`) covers local work. Returning a
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
  delivery: CodeDelivery,
  outcome: DeliveryOutcome,
): void {
  const base = {
    sender: sender.name,
    purpose: delivery.purpose,
    phone: maskPhone(delivery.phone),
  };

  if (outcome.delivered) {
    log.info({ ...base, recipient: delivery.email ? maskEmail(delivery.email) : null }, 'passcode delivered');
    return;
  }

  log.warn({ ...base, reason: outcome.reason }, 'passcode delivery failed');
}

/**
 * Builds the configured sender. Called once at startup.
 *
 * `smtp` is loaded lazily so a deployment that has not configured mail does not
 * pay for the transport, and so the SMTP module's own configuration errors
 * surface here rather than at import time.
 */
export async function createCodeSender(env: Env, log: FastifyBaseLogger): Promise<CodeSender> {
  if (env.OTP_DELIVERY_CHANNEL === 'none') {
    log.warn(
      'OTP_DELIVERY_CHANNEL is "none": one-time passcodes are generated but not delivered. ' +
        'Members cannot sign in unless DEV_OTP_ECHO is also enabled for local development.',
    );
    return nullSender;
  }

  const { createSmtpSender } = await import('./smtp-sender.js');
  return createSmtpSender(env, log);
}
