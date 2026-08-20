/**
 * SMS passcode delivery.
 *
 * The assertions here are the ones that fail *silently* in production, in the
 * same spirit as `code-delivery.test.ts`:
 *
 *   - a template that grew past one segment still sends, and bills twice
 *     forever, with nothing on screen to show for it;
 *   - a retry on a terminal rejection still costs a message every time;
 *   - an outlet notice routed to SMS has no phone number to reach, so the
 *     outlet simply stops being told a guest is coming;
 *   - a delivery failure that changes the HTTP response turns the sign-in
 *     endpoint into a membership oracle (§3).
 *
 * No carrier is contacted. The transport is a stub throughout — real delivery
 * is verified by hand against a registered sender ID, as with SMTP.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AnyDelivery, CodeDelivery, CodeSender } from '../src/notifications/code-sender.js';
import { assertSingleSegment, createSmsSender } from '../src/notifications/sms-sender.js';
import {
  createDispatcher,
  isRetryable,
  segmentsFor,
  type SmsResult,
  type SmsTransport,
} from '../src/notifications/sms-transport.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function code(overrides: Partial<CodeDelivery> = {}): CodeDelivery {
  return {
    email: 'aisha.thani@example.com',
    phone: '+97455550003',
    code: '920515',
    purpose: 'sign-in',
    ...overrides,
  };
}

/** Only the fields the SMS sender reads. */
const env = {
  OTP_TTL_SECONDS: 300,
  SMS_MAX_CONCURRENT: 4,
  SMS_MAX_PER_SECOND: 1000,
  SMS_MAX_ATTEMPTS: 3,
} as never;

function stubTransport(results: SmsResult[]): SmsTransport & { calls: number } {
  let index = 0;
  const transport = {
    name: 'stub',
    calls: 0,
    send(): Promise<SmsResult> {
      transport.calls += 1;
      return Promise.resolve(results[Math.min(index++, results.length - 1)]!);
    },
  };
  return transport;
}

describe('segment accounting', () => {
  it('counts a Latin passcode body as one GSM-7 segment', () => {
    const result = segmentsFor('Privilege Guest: use code 920515 to sign in. Expires in 5 min.');
    expect(result.encoding).toBe('GSM-7');
    expect(result.segments).toBe(1);
  });

  it('drops to UCS-2 and halves the budget on a single Arabic character', () => {
    const result = segmentsFor('Privilege Guest code 920515 — رمز');
    expect(result.encoding).toBe('UCS-2');
    expect(result.headroom).toBeLessThan(70);
  });

  it('bills a second segment past 160 GSM-7 characters', () => {
    expect(segmentsFor('a'.repeat(160)).segments).toBe(1);
    expect(segmentsFor('a'.repeat(161)).segments).toBe(2);
  });

  it('bills a second segment past 70 UCS-2 characters', () => {
    expect(segmentsFor('ر'.repeat(70)).segments).toBe(1);
    expect(segmentsFor('ر'.repeat(71)).segments).toBe(2);
  });

  it('charges the extension table two septets, not one', () => {
    // '€' is GSM-encodable but escaped, so 160 of them overrun a single segment.
    expect(segmentsFor('€'.repeat(81)).segments).toBeGreaterThan(1);
  });
});

describe('the passcode templates stay inside one segment', () => {
  it('accepts the shipped templates', () => {
    expect(() => assertSingleSegment(5)).not.toThrow();
  });

  it('still fits with a three-digit expiry', () => {
    // A deployment is free to set a long OTP_TTL_SECONDS; the template must not
    // silently gain a segment because the number got wider.
    expect(() => assertSingleSegment(120)).not.toThrow();
  });
});

describe('retry classification', () => {
  it('retries only what repeating could fix', () => {
    expect(isRetryable('rate_limited')).toBe(true);
    expect(isRetryable('transport_failed')).toBe(true);
    expect(isRetryable('invalid_recipient')).toBe(false);
    expect(isRetryable('rejected')).toBe(false);
  });

  it('does not send a rejected recipient twice — every attempt is billed', async () => {
    const transport = stubTransport([{ ok: false, reason: 'rejected' }]);
    const dispatcher = createDispatcher(transport, fakeLogger() as never, {
      maxConcurrent: 4,
      maxPerSecond: 1000,
      maxAttempts: 3,
    });

    const result = await dispatcher.send({ to: '+97455550003', body: 'x' });

    expect(result.ok).toBe(false);
    expect(transport.calls).toBe(1);
  });

  it('retries a transient failure up to the attempt ceiling', async () => {
    const transport = stubTransport([{ ok: false, reason: 'transport_failed' }]);
    const dispatcher = createDispatcher(transport, fakeLogger() as never, {
      maxConcurrent: 4,
      maxPerSecond: 1000,
      maxAttempts: 3,
    });

    await dispatcher.send({ to: '+97455550003', body: 'x' });

    expect(transport.calls).toBe(3);
  });

  it('stops retrying as soon as one succeeds', async () => {
    const transport = stubTransport([{ ok: false, reason: 'rate_limited' }, { ok: true }]);
    const dispatcher = createDispatcher(transport, fakeLogger() as never, {
      maxConcurrent: 4,
      maxPerSecond: 1000,
      maxAttempts: 3,
    });

    const result = await dispatcher.send({ to: '+97455550003', body: 'x' });

    expect(result.ok).toBe(true);
    expect(transport.calls).toBe(2);
  });
});

describe('bulk sending', () => {
  it('never exceeds the concurrency bound', async () => {
    let peak = 0;
    let live = 0;
    const transport: SmsTransport = {
      name: 'stub',
      async send() {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 1));
        live -= 1;
        return { ok: true };
      },
    };

    const dispatcher = createDispatcher(transport, fakeLogger() as never, {
      maxConcurrent: 3,
      maxPerSecond: 1000,
      maxAttempts: 1,
    });

    const messages = Array.from({ length: 40 }, (_, index) => ({
      to: `+9745555${String(index).padStart(4, '0')}`,
      body: 'x',
    }));
    const summary = await dispatcher.sendMany(messages);

    expect(summary.sent).toBe(40);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports failures by reason rather than by recipient', async () => {
    const transport = stubTransport([{ ok: false, reason: 'invalid_recipient' }]);
    const dispatcher = createDispatcher(transport, fakeLogger() as never, {
      maxConcurrent: 4,
      maxPerSecond: 1000,
      maxAttempts: 1,
    });

    const summary = await dispatcher.sendMany([
      { to: '+97455550003', body: 'x' },
      { to: '+97455550004', body: 'x' },
    ]);

    expect(summary).toEqual({ sent: 0, failed: 2, failures: { invalid_recipient: 2 } });
    // §9: no phone number reaches the summary at all.
    expect(JSON.stringify(summary)).not.toContain('5555');
  });
});

describe('routing by purpose', () => {
  function build(transport: SmsTransport) {
    const fallback: CodeSender & { seen: AnyDelivery[] } = {
      name: 'fallback',
      seen: [],
      send(delivery: AnyDelivery) {
        fallback.seen.push(delivery);
        return Promise.resolve({ delivered: true as const });
      },
    };
    const sender = createSmsSender({
      transport,
      fallback,
      env,
      log: fakeLogger() as never,
    });
    return { sender, fallback };
  }

  it('sends passcodes over SMS', async () => {
    const transport = stubTransport([{ ok: true }]);
    const { sender, fallback } = build(transport);

    await expect(sender.send(code())).resolves.toEqual({ delivered: true });
    expect(transport.calls).toBe(1);
    expect(fallback.seen).toHaveLength(0);
  });

  it('routes outlet notices to mail — they have no phone number', async () => {
    const transport = stubTransport([{ ok: true }]);
    const { sender, fallback } = build(transport);

    await sender.send({
      email: 'restaurant@example.com',
      purpose: 'outlet-request',
      outletName: 'Al Nakheel',
      memberNumber: 'PG-0003',
      benefitTitle: 'F&B discount',
      discountPct: '25',
      includeNote: false,
    });

    expect(transport.calls).toBe(0);
    expect(fallback.seen).toHaveLength(1);
  });

  it('sends a lifecycle notice over SMS when the member has a phone on record', async () => {
    const transport = stubTransport([{ ok: true }]);
    const { sender, fallback } = build(transport);

    const outcome = await sender.send({
      email: 'aisha.thani@example.com',
      phone: '+97455550003',
      purpose: 'redemption-recorded',
      benefitTitle: 'Spa treatment',
    });

    expect(outcome).toEqual({ delivered: true });
    expect(transport.calls).toBe(1);
    expect(fallback.seen).toHaveLength(0);
  });

  it('falls back to mail for a lifecycle notice when no phone is on record', async () => {
    const transport = stubTransport([{ ok: true }]);
    const { sender, fallback } = build(transport);

    await sender.send({
      email: 'aisha.thani@example.com',
      phone: '',
      purpose: 'request-submitted',
      benefitTitle: 'Spa treatment',
      outletName: 'Al Nakheel',
    });

    expect(transport.calls).toBe(0);
    expect(fallback.seen).toHaveLength(1);
  });

  it('falls back to mail when the carrier rejects a lifecycle notice', async () => {
    const transport = stubTransport([{ ok: false, reason: 'rejected' }]);
    const { sender, fallback } = build(transport);

    const outcome = await sender.send({
      email: 'aisha.thani@example.com',
      phone: '+97455550003',
      purpose: 'request-not-used',
      benefitTitle: 'Spa treatment',
    });

    expect(transport.calls).toBe(1);
    expect(fallback.seen).toHaveLength(1);
    expect(outcome).toEqual({ delivered: true });
  });
});

describe('lifecycle SMS bodies stay affordable', () => {
  async function captureBody(delivery: AnyDelivery): Promise<string> {
    let captured = '';
    const transport: SmsTransport = {
      name: 'stub',
      send(message) {
        captured = message.body;
        return Promise.resolve({ ok: true });
      },
    };
    const sender = createSmsSender({
      transport,
      fallback: { name: 'noop', send: () => Promise.resolve({ delivered: true as const }) },
      env,
      log: fakeLogger() as never,
    });
    await sender.send(delivery);
    return captured;
  }

  it('stays inside one GSM-7 segment for a realistic title and outlet name', async () => {
    const body = await captureBody({
      email: null,
      phone: '+97455550003',
      purpose: 'redemption-recorded',
      benefitTitle: '25% off food and beverage',
      outletName: 'Al Nakheel Restaurant',
      discountPct: '25',
      savedMinor: 12345,
    });

    expect(segmentsFor(body).segments).toBe(1);
  });

  it('truncates an administrator-authored title long enough to otherwise overrun a segment', async () => {
    const longTitle = 'A'.repeat(200);
    const body = await captureBody({
      email: null,
      phone: '+97455550003',
      purpose: 'request-not-used',
      benefitTitle: longTitle,
    });

    expect(body).not.toContain(longTitle);
    expect(segmentsFor(body).segments).toBe(1);
  });

  it('formats a saved amount without a non-breaking space that would force UCS-2', async () => {
    const body = await captureBody({
      email: null,
      phone: '+97455550003',
      purpose: 'redemption-recorded',
      benefitTitle: 'Spa treatment',
      savedMinor: 5000,
    });

    expect(segmentsFor(body).encoding).toBe('GSM-7');
    expect(body).toContain('QAR 50.00');
  });
});

describe('failure never becomes a membership oracle', () => {
  it('reports a carrier rejection as an outcome, not an exception', async () => {
    const transport = stubTransport([{ ok: false, reason: 'rejected' }]);
    const sender = createSmsSender({
      transport,
      fallback: { name: 'noop', send: () => Promise.resolve({ delivered: true as const }) },
      env,
      log: fakeLogger() as never,
    });

    // The route awaits this and keeps its response identical either way. A
    // throw here would surface as a 500 on exactly the numbers that fail to
    // deliver, which is the disclosure §3 forbids.
    await expect(sender.send(code())).resolves.toEqual({
      delivered: false,
      reason: 'transport_failed',
    });
  });
});
