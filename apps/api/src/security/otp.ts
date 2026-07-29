import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

/**
 * `crypto.randomInt` uses the platform CSPRNG — never `Math.random()`
 * (security-implementation.md §3).
 */
function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hmacSecret(): string {
  const value = process.env['OTP_CODE_HMAC_SECRET'];
  if (!value) {
    throw new Error('OTP_CODE_HMAC_SECRET is not set.');
  }
  return value;
}

/**
 * HMAC rather than Argon2: a 6-digit code is a ~20-bit space, trivially
 * brute-forced offline regardless of hash cost, so a slow hash buys nothing.
 * The real defenses are the 5-minute TTL and the 5-attempt lockout below; the
 * HMAC exists so a leaked table of hashes cannot be matched against a
 * rainbow table without the server secret (§3: "a leaked table of live codes
 * is account takeover").
 */
function hashOtpCode(code: string): string {
  return createHmac('sha256', hmacSecret()).update(code).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function ttlSeconds(): number {
  const raw = process.env['OTP_TTL_SECONDS'];
  const parsed = raw ? Number.parseInt(raw, 10) : 300;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
}

function maxAttempts(): number {
  const raw = process.env['OTP_MAX_ATTEMPTS'];
  const parsed = raw ? Number.parseInt(raw, 10) : 5;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export interface IssuedOtp {
  code: string;
  expiresAt: Date;
}

/**
 * Issuing a new code supersedes any still-outstanding one for the same
 * phone, so at most one code is ever valid at a time — otherwise an older,
 * forwarded code would remain usable alongside a freshly requested one.
 * Not explicitly required by security-implementation.md; see DECISIONS.md.
 */
export async function issueOtp(prisma: PrismaClient, phone: string): Promise<IssuedOtp> {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);

  await prisma.$transaction([
    prisma.otpCode.updateMany({
      where: { phone, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.otpCode.create({
      data: { phone, codeHash: hashOtpCode(code), expiresAt },
    }),
  ]);

  return { code, expiresAt };
}

export type OtpFailureReason = 'not_found' | 'expired' | 'max_attempts' | 'mismatch';

export type OtpVerifyResult = { ok: true } | { ok: false; reason: OtpFailureReason };

/**
 * Single use: consumed atomically on success. Constant-time comparison.
 * Fails closed after `OTP_MAX_ATTEMPTS`, matching the Stage 2 acceptance
 * criterion "OTP fails after 5 attempts".
 */
export async function verifyOtp(
  prisma: PrismaClient,
  phone: string,
  code: string,
): Promise<OtpVerifyResult> {
  const candidate = await prisma.otpCode.findFirst({
    where: { phone, usedAt: null },
    orderBy: { expiresAt: 'desc' },
  });

  if (!candidate) {
    return { ok: false, reason: 'not_found' };
  }

  if (candidate.attempts >= maxAttempts()) {
    return { ok: false, reason: 'max_attempts' };
  }

  if (candidate.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const matches = constantTimeEqual(hashOtpCode(code), candidate.codeHash);

  if (!matches) {
    await prisma.otpCode.update({
      where: { id: candidate.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: 'mismatch' };
  }

  await prisma.otpCode.update({
    where: { id: candidate.id },
    data: { usedAt: new Date() },
  });

  return { ok: true };
}
