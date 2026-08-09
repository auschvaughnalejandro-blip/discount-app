/**
 * SMTP delivery of one-time passcodes. See `code-sender.ts` for why this sends
 * email rather than SMS, and why that is an interim arrangement.
 *
 * ## Configuring Gmail specifically
 *
 * - `SMTP_USER` is the full Gmail address; `SMTP_PASSWORD` must be a **Google
 *   App Password**, not the account password. Google removed basic-auth access
 *   for regular passwords, so the account needs 2-Step Verification enabled and
 *   an App Password generated for it.
 * - Port 465 with `SMTP_SECURE=true` (implicit TLS), or 587 with
 *   `SMTP_SECURE=false` (STARTTLS). Both work; 465 is the simpler default.
 * - Gmail rewrites `From` to the authenticated account unless the address is a
 *   verified alias, so `SMTP_FROM` should normally be `SMTP_USER`.
 *
 * ## Limits that will be hit
 *
 * A free Gmail account sends roughly 500 messages a day, Workspace roughly
 * 2000. Fine for a pilot of ten members; not a launch answer for a programme
 * that grows. Gmail may also rate-limit or challenge a sudden burst, which
 * would surface here as a transport failure and, to the member, as a code that
 * never arrives. Watch the delivery-failure warnings.
 */
import { createTransport, type Transporter } from 'nodemailer';

import type { Env } from '../config/env.js';
import type {
  CodeDelivery,
  CodeSender,
  DeliveryOutcome,
  LifecycleDelivery,
  MemberDelivery,
} from './code-sender.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The message body.
 *
 * Contains the code, the expiry, and nothing else — no membership number, no
 * member name, no benefit detail. §9 treats the membership list as a record of
 * named prominent individuals, and an email sitting in an inbox (or in a mail
 * provider's logs, or on a lock screen) is not a place to restate who someone
 * is. A recipient who did not request this needs to know only that they should
 * ignore it.
 */
function body(delivery: CodeDelivery, ttlMinutes: number): { subject: string; text: string } {
  // The invitation is a welcome, not a verification prompt. It arrives
  // unprompted — the member did not ask for it and may not know the programme
  // exists yet — so it has to say what it is before it says what to do.
  if (delivery.purpose === 'invitation') {
    return {
      subject: 'Welcome to the Privilege Guest programme',
      text: [
        'You have been invited to join the Privilege Guest programme.',
        '',
        'Open the app, choose "Activate membership", and enter this invitation',
        'code together with your mobile number:',
        '',
        `    ${delivery.code}`,
        '',
        `It can be used once, and is valid for ${delivery.validFor ?? 'a limited period'}.`,
        '',
        'You will then be sent a short passcode to finish signing in. We will',
        'never ask you for a password, and nobody at the hotel can see either',
        'code.',
      ].join('\n'),
    };
  }

  const reason =
    delivery.purpose === 'activation'
      ? 'activate your Privilege Guest membership'
      : 'sign in to Privilege Guest';

  return {
    // No code in the subject line: subjects show on lock screens and in
    // notification previews, which is precisely where a shoulder-surfer reads.
    subject: 'Your Privilege Guest verification code',
    text: [
      `Use this code to ${reason}:`,
      '',
      `    ${delivery.code}`,
      '',
      `The code expires in ${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'} and can be used once.`,
      '',
      'If you did not request it, you can ignore this message. Nobody can use',
      'the code without also having your phone number.',
    ].join('\n'),
  };
}

function qar(minor: number): string {
  return new Intl.NumberFormat('en-QA', {
    style: 'currency',
    currency: 'QAR',
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

function lifecycleBody(delivery: LifecycleDelivery): { subject: string; text: string } {
  switch (delivery.purpose) {
    case 'request-submitted':
      return {
        subject: 'Your Privilege Guest request was received',
        text: [
          `We received your request for ${delivery.benefitTitle}.`,
          '',
          'The hotel will review it. You can also follow its status in the app.',
        ].join('\n'),
      };
    case 'request-approved':
      return {
        subject: 'Your Privilege Guest request was approved',
        text: [
          `Your request for ${delivery.benefitTitle} has been approved.`,
          '',
          'Open the app to view the approval and any reservation details for the benefit.',
          ...(delivery.reason ? ['', `Hotel note: ${delivery.reason}`] : []),
        ].join('\n'),
      };
    case 'request-declined':
      return {
        subject: 'Update on your Privilege Guest request',
        text: [
          `Your request for ${delivery.benefitTitle} was not approved.`,
          ...(delivery.reason ? ['', `Reason: ${delivery.reason}`] : []),
          '',
          'Open the app to view the request status.',
        ].join('\n'),
      };
    case 'redemption-recorded': {
      const details = [
        delivery.outletName ? `Outlet: ${delivery.outletName}` : null,
        delivery.discountPct ? `Discount recorded: ${delivery.discountPct}%` : null,
        delivery.savedMinor === null || delivery.savedMinor === undefined
          ? null
          : `Recorded saving: ${qar(delivery.savedMinor)}`,
      ].filter((line): line is string => line !== null);
      return {
        subject: 'Your Privilege Guest benefit was recorded',
        text: [
          `Your use of ${delivery.benefitTitle} has been recorded.`,
          ...(details.length ? ['', ...details] : []),
          '',
          'You can view this activity in the app. If anything looks incorrect, contact the hotel.',
        ].join('\n'),
      };
    }
  }
}

export function messageBody(
  delivery: MemberDelivery,
  ttlMinutes: number,
): { subject: string; text: string } {
  return 'code' in delivery ? body(delivery, ttlMinutes) : lifecycleBody(delivery);
}

export function createSmtpSender(env: Env, log: FastifyBaseLogger): CodeSender {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM) {
    // Fail loudly at startup rather than silently at the first sign-in
    // attempt. A deployment that means to send mail and cannot is a
    // configuration error worth stopping for.
    throw new Error(
      'OTP_DELIVERY_CHANNEL is "smtp" but SMTP_HOST, SMTP_USER, SMTP_PASSWORD or SMTP_FROM is missing.',
    );
  }

  let transport: Transporter | null = null;

  /** Created on first use so startup does not depend on the mail host. */
  function ensureTransport(): Transporter {
    transport ??= createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    });
    return transport;
  }

  return {
    name: 'smtp',

    async send(delivery: CodeDelivery): Promise<DeliveryOutcome> {
      // Email is optional at claim time, so this is a real state rather than a
      // defensive check. The caller keeps its response identical regardless,
      // so a member in this state sees the same screen as everyone else and
      // simply never receives a code — which is why the warning matters.
      if (!delivery.email) {
        return { delivered: false, reason: 'no_address' };
      }

      const ttlMinutes = Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60));
      const { subject, text } = messageBody(delivery, ttlMinutes);

      try {
        await ensureTransport().sendMail({
          from: env.SMTP_FROM,
          to: delivery.email,
          subject,
          text,
        });
        return { delivered: true };
      } catch (cause) {
        // The message may carry the recipient address, so log the transport's
        // own error separately from anything that identifies the member, and
        // never at a level that would put it in an aggregated alert body.
        log.error(
          { err: cause instanceof Error ? cause.name : 'unknown' },
          'SMTP transport rejected a passcode message',
        );
        return { delivered: false, reason: 'transport_failed' };
      }
    },
  };
}
