/**
 * Application errors with their HTTP mapping.
 *
 * Bodies are deliberately uninformative. A response is allowed to say that
 * something was not found; it is not allowed to say what, or why, or that a
 * record exists but belongs to somebody else.
 */

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** No principal, or one that could not be resolved. */
export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required.') {
    super(401, 'unauthorized', message);
  }
}

/**
 * A known principal whose role does not hold the route's permission. Used for
 * *routes*, never for records — see NotFoundError.
 */
export class ForbiddenError extends HttpError {
  constructor(message = 'Not permitted.') {
    super(403, 'forbidden', message);
  }
}

/**
 * R18 — the response for a record that does not exist *and* for one that
 * exists outside the caller's scope. The two must be indistinguishable: a 403
 * here would confirm the record exists, which on this membership is itself a
 * disclosure (security-implementation.md §5).
 */
export class NotFoundError extends HttpError {
  constructor(message = 'Not found.') {
    super(404, 'not_found', message);
  }
}

export class RateLimitedError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'rate_limited', 'Too many requests.');
  }
}
