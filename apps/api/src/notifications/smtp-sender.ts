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
  AnyDelivery,
  CodeDelivery,
  CodeSender,
  DeliveryOutcome,
  LifecycleDelivery,
  OutletDelivery,
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
    // Nothing is pending here. The guest is entitled to the benefit already, so
    // this says the outlet has been told and they can simply turn up — never
    // that anyone is reviewing anything.
    case 'request-submitted':
      return {
        subject: 'Privilege Guest — the outlet has been told',
        text: [
          delivery.outletName
            ? `${delivery.outletName} has been told you are coming for ${delivery.benefitTitle}.`
            : `The outlet has been told you are coming for ${delivery.benefitTitle}.`,
          '',
          'Nothing to wait for — just go and present your membership card. The',
          'discount is applied at the outlet and recorded afterwards.',
        ].join('\n'),
      };
    case 'request-not-used':
      return {
        subject: 'Privilege Guest — benefit not used',
        text: [
          `${delivery.benefitTitle} was not used, so nothing has been recorded.`,
          ...(delivery.reason ? ['', `Outlet note: ${delivery.reason}`] : []),
          '',
          'Your benefit is untouched and you can use it whenever you like — this',
          'is only a note that the visit did not happen.',
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

/**
 * The notice an outlet receives. Written for somebody standing up, mid-service:
 * who is coming and what they get, in the first two lines.
 *
 * Carries the membership number and never the member's name — see the note on
 * `OutletDelivery`. The guest's own note is included only when the hotel has
 * agreed it may leave the system.
 */
function outletBody(delivery: OutletDelivery): { subject: string; text: string } {
  const noteLines =
    delivery.includeNote && delivery.note ? ['', `Guest note: ${delivery.note}`] : [];

  return {
    // The membership number is in the subject on purpose: an outlet works from a
    // notification list, and a subject that reads the same for every guest means
    // opening all of them to find the one at the door.
    subject: `Privilege Guest ${delivery.memberNumber} — ${delivery.benefitTitle}`,
    text: [
      `${delivery.memberNumber} is coming to ${delivery.outletName}.`,
      '',
      `Benefit: ${delivery.benefitTitle}`,
      `Discount: ${delivery.discountPct}%`,
      ...noteLines,
      '',
      'Apply the discount on your own till as usual, then confirm it on the',
      'outlet screen so it is recorded. If they do not arrive, mark it not used —',
      'nothing is recorded either way until you confirm.',
    ].join('\n'),
  };
}

export function messageBody(
  delivery: AnyDelivery,
  ttlMinutes: number,
): { subject: string; text: string } {
  if (delivery.purpose === 'outlet-request') {
    return outletBody(delivery);
  }
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

    async send(delivery: AnyDelivery): Promise<DeliveryOutcome> {
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
