/**
 * Stage 18 — one-time passcode delivery (PROGRESS.md Q6).
 *
 * These are the invariants that matter more than "did the mail send", because
 * they are the ones that fail silently: a masked identifier that isn't actually
 * masked, and a delivery failure that changes the HTTP response and so turns
 * the sign-in endpoint into a membership oracle.
 *
 * No SMTP connection is opened here. `nodemailer` is not exercised — that is
 * integration territory needing real credentials, and it is verified by hand
 * against a real mailbox per the Stage 18 acceptance criteria.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  logDeliveryOutcome,
  maskEmail,
  maskPhone,
  nullSender,
  type CodeDelivery,
  type CodeSender,
} from '../src/notifications/code-sender.js';

function delivery(overrides: Partial<CodeDelivery> = {}): CodeDelivery {
  return {
    email: 'aisha.thani@example.com',
    phone: '+97455550003',
    code: '920515',
    purpose: 'sign-in',
    ...overrides,
  };
}

/** Minimal pino-shaped logger; only the three levels this code reaches. */
function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('masking keeps §9 out of the logs', () => {
  it('reduces a phone number to its last four digits', () => {
    expect(maskPhone('+97455550003')).toBe('••••••0003');
  });

  it('leaves no recoverable digits beyond the last four', () => {
    // The point of the mask is that the log cannot reconstruct the number.
    const masked = maskPhone('+97455550003');
    expect(masked).not.toContain('9745');
    expect(masked).not.toContain('5555');
  });

  it('keeps the email domain but hides the person', () => {
    expect(maskEmail('aisha.thani@example.com')).toBe('a••••@example.com');
  });

  it('does not leak a local part that happens to be short', () => {
    expect(maskEmail('a@example.com')).toBe('a••••@example.com');
  });

  it('degrades safely on something that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe('••••');
    expect(maskEmail('@leading')).toBe('••••');
  });
});

describe('the null sender', () => {
  it('reports not_configured rather than throwing', () => {
    // Throwing would fail the request, and a failed request on a number that
    // *is* a member — while a non-member's request succeeds — is the oracle
    // §3 forbids.
    return expect(nullSender.send(delivery())).resolves.toEqual({
      delivered: false,
      reason: 'not_configured',
    });
  });
});

describe('delivery logging', () => {
  it('records a success without the plaintext code or the full address', () => {
    const log = fakeLogger();
    const sent = delivery();

    logDeliveryOutcome(log as never, nullSender, sent, { delivered: true });

    expect(log.info).toHaveBeenCalledTimes(1);
    const serialised = JSON.stringify(log.info.mock.calls[0]);
    expect(serialised).not.toContain('920515');
    expect(serialised).not.toContain('aisha.thani@example.com');
    expect(serialised).not.toContain('97455550003');
    expect(serialised).toContain('0003');
  });

  it('records a failure at warn, with the reason and no plaintext code', () => {
    const log = fakeLogger();

    logDeliveryOutcome(log as never, nullSender, delivery(), {
      delivered: false,
      reason: 'no_address',
    });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const serialised = JSON.stringify(log.warn.mock.calls[0]);
    expect(serialised).toContain('no_address');
    expect(serialised).not.toContain('920515');
  });

  it('logs a null recipient rather than the string "null" address', () => {
    const log = fakeLogger();
    logDeliveryOutcome(log as never, nullSender, delivery({ email: null }), { delivered: true });
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({ recipient: null });
  });
});

describe('a sender that fails does not change what the caller can observe', () => {
  it('reports failure through the return value, never an exception', async () => {
    // Any sender added later must behave this way. The routes log the outcome
    // and then discard it precisely so §3's identical-response rule holds; a
    // sender that threw would break that from underneath them.
    const hostile: CodeSender = {
      name: 'hostile',
      send: () => Promise.resolve({ delivered: false, reason: 'transport_failed' }),
    };

    await expect(hostile.send(delivery())).resolves.toMatchObject({ delivered: false });
  });
});
