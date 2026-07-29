/**
 * The logger redaction layer.
 *
 * security-implementation.md §9:
 *
 *   "Application logs contain no member names, phone numbers or email
 *    addresses. Log the opaque member reference only. Enforce with a redaction
 *    layer on the logger rather than by convention."
 *
 * "Rather than by convention" is the operative phrase. Every developer
 * intending not to log a member object is one `log.info({ member })` away from
 * doing it anyway, usually while debugging something else. This layer means
 * that call is safe.
 *
 * Two mechanisms, because either alone leaves a gap:
 *
 *   1. **Paths** — pino's own `redact` option, for known shapes like
 *      `req.headers.authorization`.
 *   2. **Value shape** — a serializer that walks whatever it is given and
 *      removes anything *named* like personal data, at any depth. This is what
 *      catches `log.info({ member })`, where the path was never anticipated.
 */

export const REDACTED = '[redacted]';

/**
 * Keys whose values never belong in application logs, matched
 * case-insensitively and ignoring separators, so `fullName`, `full_name` and
 * `FullName` are all caught.
 */
const SENSITIVE_KEYS = [
  'fullname',
  'name',
  'firstname',
  'lastname',
  'phone',
  'phonenumber',
  'mobile',
  'email',
  'emailaddress',
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'pepper',
  'mfasecret',
  'codehash',
  'claimcode',
  'otp',
  'payload',
];

const SENSITIVE = new Set(SENSITIVE_KEYS);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(key.toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * Keys that look sensitive but are the opaque references §9 explicitly says
 * to log instead. Without this, redaction would remove the very identifiers
 * that make an audit trail useful.
 */
const ALLOWED = new Set(['membernumber', 'memberid', 'id', 'outletid', 'benefitid', 'staffuserid']);

function isAllowedKey(key: string): boolean {
  return ALLOWED.has(key.toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * Recursively replaces sensitive values. Returns a new structure; the caller's
 * object is never mutated, because a logger that quietly edits the objects it
 * is handed causes worse bugs than the one it prevents.
 */
export function redact(value: unknown, depth = 0): unknown {
  // Cheap guard against a cycle or a pathological structure.
  if (depth > 8) {
    return REDACTED;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  if (value instanceof Date) {
    return value;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isAllowedKey(key)) {
      output[key] = entry;
    } else if (isSensitiveKey(key)) {
      output[key] = REDACTED;
    } else {
      output[key] = redact(entry, depth + 1);
    }
  }

  return output;
}

/**
 * Paths pino redacts directly. Faster than walking, and covers the request and
 * response shapes it logs automatically on every request.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.fullName',
  '*.phone',
  '*.email',
];
