/**
 * The provider-facing half of SMS delivery.
 *
 * `code-sender.ts` decides *what* to say and *to whom*. This file decides *how
 * it reaches a carrier*, and nothing here knows what a membership is.
 *
 * ## Why a second interface, when `CodeSender` already exists
 *
 * `CodeSender` is a seam between the application and a *channel* — email or
 * SMS. `SmsTransport` is a seam between SMS and a *carrier*. They are different
 * axes and collapsing them is what makes a provider swap turn into a rewrite:
 * the cost analysis is explicit that the provider decision may be revisited
 * once real volume is known, and Ooredoo's published rate is roughly a tenth of
 * an international API provider's. Whoever makes that switch should be writing
 * one `SmsTransport`, not touching a route.
 *
 * ## What this file provides beyond a single send
 *
 * A carrier will happily accept one message at a time and then throttle or drop
 * a burst. Two things in the programme produce bursts:
 *
 *   - an event, where hundreds of members sign in within an hour, and
 *   - any future broadcast to the membership, which is thousands at once.
 *
 * So every send — one message or ten thousand — goes through `createDispatcher`
 * below, which bounds concurrency, paces to a per-second ceiling, and retries
 * only the failures that are worth retrying. A caller that wants to send to the
 * whole membership calls `sendMany` and gets a summary; it does not get to
 * bypass the pacing, because there is no path that does.
 */
import type { FastifyBaseLogger } from 'fastify';

/** One message, already addressed and already worded. */
export interface SmsMessage {
  /** E.164, normalised upstream by `security/phone.ts`. Never logged in full. */
  to: string;
  body: string;
}

/**
 * Why a send failed, split by whether repeating it could ever help.
 *
 * `invalid_recipient` and `rejected` are terminal: the carrier has understood
 * the request and refused it, and sending it again produces the same refusal
 * while still costing an API call. `transport_failed` and `rate_limited` are
 * transient by definition, and are the only two the dispatcher retries.
 */
export type SmsFailure = 'invalid_recipient' | 'rejected' | 'rate_limited' | 'transport_failed';

export type SmsResult =
  | { ok: true; providerRef?: string }
  | { ok: false; reason: SmsFailure };

export function isRetryable(reason: SmsFailure): boolean {
  return reason === 'rate_limited' || reason === 'transport_failed';
}

export interface SmsTransport {
  /** Appears in delivery logs so an operator can tell which carrier answered. */
  readonly name: string;
  send(message: SmsMessage): Promise<SmsResult>;
}

// ── Segment accounting ──────────────────────────────────────────────────────

/**
 * The GSM 03.38 basic alphabet. A body drawn entirely from this set encodes at
 * seven bits per character; anything outside it forces the whole message to
 * UCS-2 and more than halves the per-segment budget.
 *
 * This matters in riyals, not in bytes. At the carrier's published rate every
 * segment is billed, so one stray character — a curly apostrophe pasted from a
 * document, an Arabic word in an otherwise Latin body — silently doubles the
 * cost of every message that template ever sends.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** Characters that are GSM-encodable but occupy two septets, not one. */
const GSM_EXTENDED = '^{}\\[~]|€';

export interface SmsSegmentation {
  encoding: 'GSM-7' | 'UCS-2';
  /** Billable segments. Every one of these is charged separately. */
  segments: number;
  /** Characters remaining before the next segment is charged. */
  headroom: number;
}

export function segmentsFor(body: string): SmsSegmentation {
  let septets = 0;
  let gsm = true;

  for (const char of body) {
    if (GSM_EXTENDED.includes(char)) {
      septets += 2;
    } else if (GSM_BASIC.includes(char)) {
      septets += 1;
    } else {
      gsm = false;
      break;
    }
  }

  if (gsm) {
    const segments = septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', segments, headroom: (segments === 1 ? 160 : segments * 153) - septets };
  }

  // UCS-2 counts UTF-16 code units, so an emoji or a character outside the BMP
  // costs two. `body.length` is already that count.
  const units = body.length;
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', segments, headroom: (segments === 1 ? 70 : segments * 67) - units };
}

// ── Transports ──────────────────────────────────────────────────────────────

export interface HttpTransportConfig {
  name: string;
  endpoint: string;
  senderId: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/**
 * A form-encoded HTTP gateway, which is the shape most GCC bulk providers
 * expose and the one Ooredoo's Aamali documentation describes as "HTTP/HTTPs".
 *
 * **The field names below are the common convention, not a contract.** No
 * public schema exists for the account this will run against, so treat
 * `buildRequest` as the single place to reconcile against the provider's own
 * API document when the account is opened. Everything else in this file — the
 * pacing, the retry classification, the segment accounting — is provider
 * independent and should not need to change.
 */
export function createHttpTransport(config: HttpTransportConfig): SmsTransport {
  function buildRequest(message: SmsMessage): URLSearchParams {
    return new URLSearchParams({
      username: config.username,
      password: config.password,
      sender: config.senderId,
      // E.164 with the leading '+' stripped: most gateways in the region
      // reject the plus sign rather than normalising it.
      to: message.to.replace(/^\+/, ''),
      text: message.body,
    });
  }

  return {
    name: config.name,

    async send(message: SmsMessage): Promise<SmsResult> {
      let response: Response;

      try {
        response = await fetch(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: buildRequest(message),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
        // A timeout or a socket error. The carrier may still have accepted the
        // message, which is why passcodes are single-use and short-lived rather
        // than this path trying to be clever about it.
        return { ok: false, reason: 'transport_failed' };
      }

      if (response.ok) {
        return { ok: true };
      }

      // 429 is the explicit "slow down"; 5xx is the carrier's problem and worth
      // repeating. Everything else in 4xx is a request this account will never
      // be allowed to make, and retrying it only spends money.
      if (response.status === 429) {
        return { ok: false, reason: 'rate_limited' };
      }
      if (response.status >= 500) {
        return { ok: false, reason: 'transport_failed' };
      }
      if (response.status === 400 || response.status === 422) {
        return { ok: false, reason: 'invalid_recipient' };
      }
      return { ok: false, reason: 'rejected' };
    },
  };
}

/**
 * Writes the message to the log instead of sending it, so the SMS path can be
 * exercised end to end without a carrier account or a riyal of spend.
 *
 * **The body is logged and the body contains the passcode**, so this is refused
 * in production by `createSmsSender`. It exists for the same reason the SMTP
 * path has a mail-test script: to prove the wiring before the account exists.
 */
export function createLoggingTransport(log: FastifyBaseLogger): SmsTransport {
  return {
    name: 'sms-log',
    send(message: SmsMessage): Promise<SmsResult> {
      const { encoding, segments } = segmentsFor(message.body);
      log.warn(
        { to: `••••••${message.to.slice(-4)}`, encoding, segments, body: message.body },
        'SMS not sent — logging transport is active',
      );
      return Promise.resolve({ ok: true });
    },
  };
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export interface DispatcherOptions {
  /** In-flight requests. Above a handful, gateways start refusing rather than queueing. */
  maxConcurrent: number;
  /** Ceiling on send rate. The dispatcher paces to this rather than discovering it via 429s. */
  maxPerSecond: number;
  /** Total tries per message, including the first. */
  maxAttempts: number;
}

export interface BatchSummary {
  sent: number;
  failed: number;
  /** Counts by reason, so one bad batch is diagnosable from one log line. */
  failures: Partial<Record<SmsFailure, number>>;
}

export interface SmsDispatcher {
  send(message: SmsMessage): Promise<SmsResult>;
  /**
   * Fan a batch through the same pacing as a single send. Resolves once every
   * message has reached a terminal outcome; the summary is aggregate, because
   * per-recipient results would be a list of phone numbers and §9 forbids that
   * reaching a log.
   */
  sendMany(messages: readonly SmsMessage[]): Promise<BatchSummary>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a transport with the three things that separate "it sent one message"
 * from "it sent ten thousand without being throttled off the gateway":
 * a concurrency bound, a rate ceiling, and retries confined to transient
 * failures with exponential backoff.
 *
 * Deliberately in-process and unpersisted. A durable queue would survive a
 * restart mid-broadcast, and that is a real gap — but it is also a database
 * table, a worker and a delivery-state machine, and none of it helps the case
 * this system actually has today, which is one passcode at a time. The seam to
 * add it later is `sendMany`: a queue-backed dispatcher implements the same two
 * methods and no caller changes.
 */
export function createDispatcher(
  transport: SmsTransport,
  log: FastifyBaseLogger,
  options: DispatcherOptions,
): SmsDispatcher {
  const minGapMs = 1000 / Math.max(1, options.maxPerSecond);
  let nextSlot = 0;
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  /** Reserves the next pacing slot and resolves when it is this caller's turn. */
  async function acquire(): Promise<void> {
    if (inFlight >= options.maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    inFlight += 1;

    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minGapMs;
    if (slot > now) {
      await sleep(slot - now);
    }
  }

  function release(): void {
    inFlight -= 1;
    waiting.shift()?.();
  }

  async function attempt(message: SmsMessage): Promise<SmsResult> {
    let last: SmsResult = { ok: false, reason: 'transport_failed' };

    for (let tries = 1; tries <= options.maxAttempts; tries += 1) {
      await acquire();
      try {
        last = await transport.send(message);
      } finally {
        release();
      }

      if (last.ok || !isRetryable(last.reason)) {
        return last;
      }

      if (tries < options.maxAttempts) {
        // 200ms, 400ms, 800ms … enough to clear a brief throttle without
        // holding a sign-in request open long enough for the member to give up.
        await sleep(200 * 2 ** (tries - 1));
      }
    }

    return last;
  }

  return {
    send: attempt,

    async sendMany(messages: readonly SmsMessage[]): Promise<BatchSummary> {
      const summary: BatchSummary = { sent: 0, failed: 0, failures: {} };

      // Every message is started at once and the pacing inside `attempt` does
      // the shaping. Starting them in sequence would serialise the batch to one
      // message per round trip and waste the concurrency allowance entirely.
      const results = await Promise.all(messages.map((message) => attempt(message)));

      for (const result of results) {
        if (result.ok) {
          summary.sent += 1;
        } else {
          summary.failed += 1;
          summary.failures[result.reason] = (summary.failures[result.reason] ?? 0) + 1;
        }
      }

      if (summary.failed > 0) {
        log.warn(
          { transport: transport.name, ...summary },
          'SMS batch completed with failures',
        );
      }

      return summary;
    },
  };
}
