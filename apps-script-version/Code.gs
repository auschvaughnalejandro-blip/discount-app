/**
 * Privilege Guest Program — Google Apps Script backend
 * ============================================================================
 *
 * A port of the Fastify + PostgreSQL API onto Apps Script + Google Sheets.
 *
 * WHAT IS DIFFERENT FROM THE POSTGRES BUILD, AND WHY
 * ---------------------------------------------------------------------------
 * 1. Redemption immutability (R7) is enforced *in code here only*. In the
 *    Postgres build UPDATE and DELETE are revoked from the application role at
 *    the database level, so the guarantee survives a compromised API. A
 *    spreadsheet cannot do that — anyone with edit access to the Sheet can
 *    change a row by hand. Sheet version history is the only backstop.
 *    THIS IS A REAL REDUCTION IN GUARANTEE. It is documented, not hidden.
 *
 * 2. Passwords/passcodes: no argon2 in Apps Script. Passcodes are one-time and
 *    short-lived so HMAC-SHA256 is appropriate for them (matches the Postgres
 *    build, which also HMACs OTP codes). No long-lived member password exists.
 *
 * 3. Staff MFA (TOTP) is NOT implemented here. The Postgres build uses otplib.
 *    Hand-rolling TOTP is possible but it is security code and belongs in a
 *    separate, reviewed change. Administrators are single-factor until then.
 *
 * SECURITY MODEL
 * ---------------------------------------------------------------------------
 * Every action goes through `requireSession()` except the five listed in
 * PUBLIC_ACTIONS. There is no path that reads or writes member data without a
 * session token. Deploying "Execute as Me / Anyone" is safe *because* of this
 * gate — remove it and the whole sheet becomes world-readable over a URL.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

var SPREADSHEET_ID = '';           // set once, or leave blank to use the bound sheet
var ASSET_BASE     = '';           // e.g. https://<user>.github.io/pgp-assets
var HOTEL_NAME     = 'Steigenberger Hotel Doha';
var SENDER_NAME    = 'Privilege Guest Program';
var SUPPORT_EMAIL  = 'doha@steigenberger.com';

var OTP_TTL_SECONDS       = 300;   // 5 minutes  — security-implementation.md §3
var OTP_MAX_ATTEMPTS      = 5;     // per code
var SESSION_TTL_DAYS      = 30;    // matches REFRESH_TOKEN_TTL_MEMBER_SECONDS
var STAFF_SESSION_TTL_HRS = 12;    // matches REFRESH_TOKEN_TTL_STAFF_SECONDS
var CLAIM_CODE_TTL_DAYS   = 30;    // CLAIM_CODE_TTL_HOURS=720
var MIN_COHORT_SIZE       = 5;     // R13 — cohorts below five are suppressed
var REQUEST_EXPIRY_HOURS  = 24;    // unanswered visit notices close as NOT_USED
var REQUEST_THROTTLE_SECONDS = 60; // stops rapid notices across several outlets
var VERIFICATION_SESSION_TTL_SECONDS = 600; // counter lookup proof, 10 minutes
var CONSENT_WORDING_VERSION = 'v1-2026-07'; // bump whenever displayed consent copy changes
var SMS_TITLE_CHARS  = 40; // truncates a benefit title in an SMS — see truncateSms_
var SMS_OUTLET_CHARS = 30; // truncates an outlet name in an SMS — see truncateSms_

// ─── Sheet definitions ──────────────────────────────────────────────────────

var SHEETS = {
  Members: ['id','memberNumber','fullName','phone','email','status','joinedAt',
            'claimedAt','tokenVersion','createdBy','createdAt'],
  ClaimCodes: ['id','memberId','codeHash','expiresAt','usedAt','createdAt'],
  Benefits: ['id','slug','category','title','discount','terms','maxParty',
             'reservationPhone','heroImage','published','version','updatedBy','updatedAt',
             'secondaryLabel','secondaryPct','childRules','minGuests','sortOrder','outletKind'],
  Requests: ['id','memberId','benefitId','outletId','status','note',
             'createdAt','resolvedAt','resolvedBy','closedReason','fulfilledAt',
             'seenAt','notifiedAt','notifyStatus','redemptionId'],
  Redemptions: ['id','memberId','benefitId','outletId','partySize','billMinor',
                'savedMinor','recordedBy','recordedAt','reversesId',
                'discountPctApplied','benefitVersion','idempotencyKey'],
  ConsentRecords: ['id','memberId','channel','granted','wordingVersion','recordedAt'],
  Outlets: ['id','name','category','notifyEmail','active'],
  OutletTokens: ['id','outletId','label','tokenHash','status','issuedBy','issuedAt','revokedAt'],
  // mfaEnrolledAt marks enrollment *completion*, distinct from "a secret
  // exists" — an abandoned setup leaves a secret in Script Properties and this
  // blank, and must not count as enrolled. mfaLastUsedEpoch is the TOTP period
  // of the last accepted code, which is what makes a code single-use.
  Staff: ['id','email','fullName','role','status','passHash','salt','createdAt',
          'mfaEnrolledAt','mfaLastUsedEpoch'],
  // Marked used rather than deleted, for the same reason redemptions are never
  // erased: nothing in the application has cause to destroy this trail.
  MfaRecoveryCodes: ['id','staffId','codeHash','usedAt','createdAt'],
  Sessions: ['tokenHash','subjectType','subjectId','tokenVersion','expiresAt','createdAt'],
  OtpCache: ['phone','codeHash','expiresAt','attempts','createdAt'],
  Audit: ['id','actorType','actorId','action','targetType','targetId','detail','at']
};

// Avoid re-reading headers repeatedly during one warm Apps Script execution.
// A new deployment gets a fresh global and therefore re-checks the schema.
var SHEET_SCHEMA_READY = {};

// Actions reachable without a session. Everything else is gated.
//
// The three staff MFA actions are here because they run *before* a session
// exists — between a correct password and a second factor. They are not
// ungated: each one requires an unexpired MFA challenge issued by staffLogin(),
// which is a different credential in a different namespace from a session token
// and authorises nothing except the attempt to present a second factor.
var PUBLIC_ACTIONS = ['requestPasscode', 'verifyPasscode', 'claimMembership',
                      'staffLogin', 'outletLogin',
                      'staffBeginMfaEnrollment', 'staffConfirmMfaEnrollment',
                      'staffVerifyMfa'];

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * Keep the whole implementation off the public `google.script.run` surface.
 *
 * Apps Script exposes every top-level function whose name does not end in an
 * underscore. Nested functions and object methods are invisible to the HTML
 * client, so this closure is the security boundary around all sheet, session,
 * role and crypto helpers. Only the small wrappers after the closure are
 * remotely callable.
 */
var Server_ = (function () {

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'member';
  var file = { member: 'Member', admin: 'Admin', outlet: 'Outlet' }[page] || 'Member';
  var t = HtmlService.createTemplateFromFile(file);
  t.assetBase = ASSET_BASE;
  t.execUrl   = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle('Privilege Guest')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * All data traffic is POST. GET serves pages only.
 *
 * Deliberate: a GET with the action in the query string ends up in browser
 * history, server logs and Referer headers. A session token must not.
 */
function doPost(e) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };
  try {
    var body   = JSON.parse(e.postData.contents || '{}');
    var action = String(body.action || '');
    var data   = body.data || {};
    var token  = String(body.token || '');

    if (PUBLIC_ACTIONS.indexOf(action) === -1) {
      var session = requireSession(token);
      if (!session.ok) return out({ success: false, error: session.error, code: 'UNAUTHENTICATED' });
      data.__session = session.value;
    }
    return out(dispatch(action, data));
  } catch (err) {
    return out({ success: false, error: String(err && err.message || err) });
  }
}

/**
 * The bridge the served pages actually use, via `google.script.run.apiCall(...)`.
 *
 * doPost() exists for callers outside the page (a native wrapper, a test
 * script). Both funnel through the same gate: anything not in PUBLIC_ACTIONS
 * requires a valid session, and there is no third way in.
 */
function apiCall(action, data, token) {
  try {
    data = data || {};
    if (PUBLIC_ACTIONS.indexOf(String(action)) === -1) {
      var session = requireSession(String(token || ''));
      if (!session.ok) return { success: false, error: session.error, code: 'UNAUTHENTICATED' };
      data.__session = session.value;
    }
    return dispatch(String(action), data);
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
}

function dispatch(action, data) {
  try {
    switch (action) {
      // public
      case 'requestPasscode':   return requestPasscode(data);
      case 'verifyPasscode':    return verifyPasscode(data);
      case 'claimMembership':   return claimMembership(data);
      case 'staffLogin':        return staffLogin(data);
      case 'outletLogin':       return outletLogin(data);
      case 'staffBeginMfaEnrollment':   return staffBeginMfaEnrollment(data);
      case 'staffConfirmMfaEnrollment': return staffConfirmMfaEnrollment(data);
      case 'staffVerifyMfa':            return staffVerifyMfa(data);
      // member, session required
      case 'getMe':             return getMe(data);
      case 'getBenefits':       return getBenefits(data);
      case 'getBenefit':        return getBenefit(data);
      case 'createRequest':     return createRequest(data);
      case 'getMyRequests':     return getMyRequests(data);
      case 'getBenefitOutlets': return getBenefitOutlets(data);
      case 'getMyActivity':     return getMyActivity(data);
      case 'updateConsent':     return updateConsent(data);
      case 'signOut':           return signOut(data);
      // staff, session required
      case 'listMembers':       return listMembers(data);
      case 'createMember':      return createMember(data);
      case 'updateMember':      return updateMember(data);
      case 'resendClaimCode':   return resendClaimCode(data);
      case 'setMemberStatus':   return setMemberStatus(data);
      case 'listRequests':      return listRequests(data);
      case 'markRequestNotUsed': return markRequestNotUsed(data);
      case 'recordRedemption':  return recordRedemption(data);
      case 'reverseRedemption': return reverseRedemption(data);
      case 'listRedemptions':   return listRedemptions(data);
      case 'getOverview':       return getOverview(data);
      case 'getReports':        return getReports(data);
      case 'upsertBenefit':     return upsertBenefit(data);
      case 'resolveMember':     return resolveMember(data);
      case 'listOutlets':       return listOutlets(data);
      case 'upsertOutlet':      return upsertOutlet(data);
      case 'issueOutletToken':  return issueOutletToken(data);
      case 'revokeOutletToken': return revokeOutletToken(data);
      case 'getOutletQueue':    return getOutletQueue(data);
      case 'whoAmI':            return whoAmI(data);
      default: return { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    // §9 parity with the Postgres build: a session that reached the gate but
    // lacked the right role (a member session hitting a staff-only action, an
    // outlet device reaching past its own counter) leaves a trace, same as any
    // other authorization failure. requireStaff/requireMember/requireCounter
    // mark their throws so this is the one place that needs to know about it.
    if (err && err.pgpAuthDenied) {
      var actor = data.__session || {};
      audit(actor.type || 'unknown', actor.id || '', 'authorization.denied', 'action', action, String(err.message || ''));
    }
    throw err;
  }
}

// ─── Sheet plumbing ─────────────────────────────────────────────────────────

function book() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet(name) {
  if (!SHEETS[name]) throw new Error('Unknown sheet: ' + name);
  var ss = book();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name].map(literalSheetValue));
    sh.setFrozenRows(1);
  }
  ensureSheetSchema(sh, name);
  return sh;
}

/**
 * Adds newly introduced columns to an existing workbook without moving or
 * overwriting any existing data. Reads and writes below use the actual header
 * order, so a workbook created by an older deployment remains aligned even if
 * somebody has also added an operational column of their own.
 */
function ensureSheetSchema(sh, name) {
  if (SHEET_SCHEMA_READY[name]) return;
  var expected = SHEETS[name];
  var headers = [];
  var addedFields = [];

  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, expected.length).setValues([
      expected.map(literalSheetValue)
    ]);
    sh.setFrozenRows(1);
    headers = expected.slice();
  } else {
    var lastColumn = Math.max(sh.getLastColumn(), 1);
    headers = sh.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (value) {
      return String(value || '').trim();
    });
    var missing = expected.filter(function (field) { return headers.indexOf(field) === -1; });
    if (missing.length) {
      sh.getRange(1, headers.length + 1, 1, missing.length).setValues([
        missing.map(literalSheetValue)
      ]);
      headers = headers.concat(missing);
      addedFields = missing.slice();
    }
  }

  // Sheets auto-detects numeric-looking text (like "+97451004272") and
  // silently converts it to a Number, dropping the leading "+". Force phone
  // columns to stay text in both new and already-created workbooks.
  var phoneCol = headers.indexOf('phone');
  if (phoneCol !== -1) sh.getRange(1, phoneCol + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  if (name === 'Benefits') {
    // Same problem, same fix: "25%" is exactly as numeric-looking to Sheets
    // as a phone number is, and it gets silently reinterpreted as the
    // fraction 0.25 (percentage formatting) instead of staying literal text.
    // Every save through upsertBenefit() writes a "NN%" string here, so
    // without this, each edit round-trip re-corrupts the value further.
    ['discount', 'secondaryPct'].forEach(function (field) {
      var col = headers.indexOf(field);
      if (col !== -1) sh.getRange(1, col + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
    upgradeBenefitSheet(sh, headers, addedFields);
  }
  SHEET_SCHEMA_READY[name] = true;
}

function sheetHeaders(sh) {
  if (sh.getLastColumn() < 1) return [];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (value) {
    return String(value || '').trim();
  });
}

/**
 * One-time repair for phone numbers written before the fix above existed.
 * Run this once from the function dropdown, then re-check the Members sheet.
 */
function repairPhoneNumbers() {
  var repaired = 0;
  var skipped = 0;
  ['Members', 'OtpCache'].forEach(function (name) {
    var sh = sheet(name);
    var col = sheetHeaders(sh).indexOf('phone') + 1;
    var lastRow = sh.getLastRow();
    if (col < 1 || lastRow < 2) return;
    var range = sh.getRange(2, col, lastRow - 1, 1);
    range.setNumberFormat('@');
    var fixed = range.getValues().map(function (row) {
      var original = row[0];
      if (original === '' || original === null || original === undefined) return [''];
      var normalized = normalisePhone(original);
      if (!validMemberPhone(normalized)) {
        skipped += 1;
        return [original];
      }
      if (String(original) !== normalized) repaired += 1;
      return [normalized];
    });
    range.setValues(fixed.map(function (row) { return [literalSheetValue(row[0])]; }));
  });
  Logger.log('Phone columns repaired: ' + repaired + ' normalised; ' + skipped +
             ' invalid value(s) left unchanged for manual review.');
}

function rows(name) {
  var sh = sheet(name);
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var h = v[0].map(function (value) { return String(value || '').trim(); });
  return v.slice(1).map(function (r, i) {
    var o = { __row: i + 2 };
    h.forEach(function (k, j) {
      if (k) o[k] = r[j] === null || r[j] === undefined ? '' : r[j];
    });
    return o;
  });
}

/**
 * Sheets treats any string beginning with "=" as a formula, including values
 * supplied by a member in a request note. Prefixing the spreadsheet's literal
 * marker keeps the displayed/read-back text unchanged while preventing code
 * execution in the privileged workbook.
 */
function literalSheetValue(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' && value.charAt(0) === '=' ? "'" + value : value;
}

function append(name, obj) {
  var sh = sheet(name);
  var headers = sheetHeaders(sh);
  sh.appendRow(headers.map(function (k) {
    return literalSheetValue(obj[k]);
  }));
  return obj;
}

function updateWhere(name, predicate, updates) {
  var sh = sheet(name);
  var all = rows(name);
  var hit = null;
  for (var i = 0; i < all.length; i++) { if (predicate(all[i])) { hit = all[i]; break; } }
  if (!hit) return false;
  var headers = sheetHeaders(sh);
  var current = sh.getRange(hit.__row, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (k, i) {
    if (updates[k] !== undefined) current[i] = literalSheetValue(updates[k]);
  });
  sh.getRange(hit.__row, 1, 1, headers.length).setValues([
    current.map(literalSheetValue)
  ]);
  return true;
}

function findOne(name, predicate) {
  var all = rows(name);
  for (var i = 0; i < all.length; i++) if (predicate(all[i])) return all[i];
  return null;
}

/** Serialises writes that must not interleave (redemptions, claim codes). */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

function secret() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('PGP_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('PGP_SECRET', s); }
  return s;
}

/** Separate key domain for long-lived printed card codes. */
function cardSecret() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('PGP_CARD_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PGP_CARD_SECRET', s);
  }
  return s;
}

function hmac(value) {
  var raw = Utilities.computeHmacSha256Signature(String(value), secret());
  return raw.map(function (b) {
    var h = (b & 0xff).toString(16);
    return h.length < 2 ? '0' + h : h;
  }).join('');
}

/** Constant-time-ish compare. Avoids leaking position of first mismatch. */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stable code printed on the member card and rendered as the in-app QR.
 *
 * The body contains the opaque internal UUID, never the sequential PG number,
 * and the signature covers both the version and UUID. Possession identifies a
 * member but grants nothing: resolution remains behind requireCounter(), and a
 * redemption still requires an authenticated, attributable counter session.
 */
function cardCodeFor(memberId) {
  var body = 'v2.' + String(memberId);
  var raw = Utilities.computeHmacSha256Signature(body, cardSecret());
  var signature = Utilities.base64EncodeWebSafe(raw).replace(/=+$/g, '');
  return body + '.' + signature;
}

function memberIdFromCardCode(value) {
  value = String(value || '').trim();
  if (value.length > 160) return null;
  var parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2') return null;
  var memberId = parts[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId))
    return null;
  var expected = cardCodeFor(memberId).split('.')[2];
  return safeEqual(parts[2], expected) ? memberId : null;
}

function randomToken() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); }

/** Six digits, from a CSPRNG rather than Math.random(). */
function randomPasscode() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + String(Date.now()), Utilities.Charset.UTF_8);
  var n = 0;
  for (var i = 0; i < 4; i++) n = (n * 256) + (bytes[i] & 0xff);
  return String(100000 + (Math.abs(n) % 900000));
}

/** Crockford Base32, matching the Postgres build's claim-code alphabet. */
function randomClaimCode() {
  var A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid(), Utilities.Charset.UTF_8);
  var s = '';
  for (var i = 0; i < 16; i++) s += A[bytes[i] & 31];
  return s.replace(/(.{4})(?=.)/g, '$1-');
}

function nowIso() { return new Date().toISOString(); }
function isoString(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]')
    return isNaN(value.getTime()) ? '' : value.toISOString();
  return String(value);
}
function plusDays(d) { return new Date(Date.now() + d * 86400000).toISOString(); }
function plusSeconds(s) { return new Date(Date.now() + s * 1000).toISOString(); }
function expired(iso) { return !iso || new Date(iso).getTime() < Date.now(); }

function audit(actorType, actorId, action, targetType, targetId, detail) {
  append('Audit', {
    id: Utilities.getUuid(), actorType: actorType, actorId: actorId, action: action,
    targetType: targetType, targetId: targetId, detail: detail || '', at: nowIso()
  });
}

// ─── Sessions ───────────────────────────────────────────────────────────────

function issueSession(subjectType, subjectId, tokenVersion, ttlDays) {
  var token = randomToken();
  append('Sessions', {
    tokenHash: hmac(token), subjectType: subjectType, subjectId: subjectId,
    tokenVersion: tokenVersion || 1, expiresAt: plusDays(ttlDays), createdAt: nowIso()
  });
  return token;
}

function requireSession(token) {
  if (!token) return { ok: false, error: 'Sign in required.' };
  var h = hmac(token);
  var s = findOne('Sessions', function (r) { return r.tokenHash === h; });
  if (!s) return { ok: false, error: 'Sign in required.' };
  if (expired(s.expiresAt)) return { ok: false, error: 'Session expired.' };

  // A suspended member's outstanding sessions must stop working immediately.
  if (s.subjectType === 'member') {
    var m = findOne('Members', function (r) { return r.id === s.subjectId; });
    if (!m || m.status !== 'ACTIVE' || !m.claimedAt)
      return { ok: false, error: 'Membership is not active.' };
    if (Number(m.tokenVersion || 1) !== Number(s.tokenVersion || 1))
      return { ok: false, error: 'Session revoked.' };
  }
  if (s.subjectType === 'staff') {
    var st = findOne('Staff', function (r) { return r.id === s.subjectId; });
    if (!st || st.status !== 'active' || String(st.role).toLowerCase() !== 'administrator')
      return { ok: false, error: 'Account is not authorised.' };
  }
  // An outlet session is only as good as the device token behind it. Revoking
  // a token must lock that tablet out immediately, not at session expiry.
  if (s.subjectType === 'outlet') {
    var tok = findOne('OutletTokens', function (r) { return r.id === s.subjectId; });
    if (!tok || tok.status !== 'active') return { ok: false, error: 'This device is no longer authorised.' };
    var out = findOne('Outlets', function (r) { return r.id === tok.outletId; });
    if (!out || String(out.active).toLowerCase() === 'false')
      return { ok: false, error: 'This outlet is not active.' };
    return {
      ok: true,
      value: { type: 'outlet', id: s.subjectId, outletId: tok.outletId, tokenHash: h }
    };
  }
  return { ok: true, value: { type: s.subjectType, id: s.subjectId, tokenHash: h } };
}

/** A role mismatch, not a missing session — dispatch() audits these as `authorization.denied`. */
function authDenied_(message) {
  var e = new Error(message);
  e.pgpAuthDenied = true;
  return e;
}

function requireStaff(data) {
  var s = data.__session;
  if (!s || s.type !== 'staff') throw authDenied_('Administrator access required.');
  return s;
}

function requireMember(data) {
  var s = data.__session;
  if (!s || s.type !== 'member') throw authDenied_('Member access required.');
  return s;
}

/** A counter action: either an administrator or a signed-in outlet device. */
function requireCounter(data) {
  var s = data.__session;
  if (!s || (s.type !== 'staff' && s.type !== 'outlet'))
    throw authDenied_('Administrator or outlet access required.');
  return s;
}

function whoAmI(data) {
  var s = data.__session;
  var out = { success: true, type: s.type };
  if (s.type === 'staff') {
    var st = findOne('Staff', function (r) { return r.id === s.id; });
    out.name = st ? st.fullName : ''; out.role = st ? st.role : '';
  }
  if (s.type === 'outlet') {
    var o = findOne('Outlets', function (r) { return r.id === s.outletId; });
    out.name = o ? o.name : ''; out.outletId = s.outletId; out.category = o ? o.category : '';
  }
  if (s.type === 'member') {
    var m = findOne('Members', function (r) { return r.id === s.id; });
    out.name = m ? m.fullName : '';
  }
  return out;
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

function rateLimit(key, max, windowSeconds) {
  var cache = CacheService.getScriptCache();
  var k = 'rl_' + hmac(key).slice(0, 24);
  var n = Number(cache.get(k) || 0);
  if (n >= max) return false;
  cache.put(k, String(n + 1), windowSeconds);
  return true;
}

function verificationCacheKey(token) {
  return 'counter_verify_' + hmac(String(token || '')).slice(0, 40);
}

function issueCounterVerification(session, memberId) {
  var token = randomToken();
  CacheService.getScriptCache().put(verificationCacheKey(token), JSON.stringify({
    actorType: session.type,
    actorId: session.id,
    outletId: session.outletId || '',
    memberId: memberId,
    expiresAt: Date.now() + VERIFICATION_SESSION_TTL_SECONDS * 1000
  }), VERIFICATION_SESSION_TTL_SECONDS);
  return token;
}

function verifyCounterVerification(session, memberId, token) {
  token = String(token || '').trim();
  if (!token || token.length > 200) return false;
  var raw = CacheService.getScriptCache().get(verificationCacheKey(token));
  if (!raw) return false;
  try {
    var proof = JSON.parse(raw);
    return proof.expiresAt >= Date.now() &&
      proof.actorType === session.type && proof.actorId === session.id &&
      String(proof.outletId || '') === String(session.outletId || '') &&
      proof.memberId === memberId;
  } catch (err) {
    return false;
  }
}

function consumeCounterVerification(token) {
  CacheService.getScriptCache().remove(verificationCacheKey(token));
}

// ─── Member authentication ──────────────────────────────────────────────────

function normalisePhone(p) {
  var source = String(p || '').trim();
  var digits = source.replace(/\D/g, '');
  if (!digits) return '';
  // An explicit international prefix is authoritative. In particular,
  // "+12345678" must not be reinterpreted as an eight-digit Qatar number.
  var pluses = (source.match(/\+/g) || []).length;
  if (pluses) {
    if (pluses !== 1 || source.charAt(0) !== '+') return '';
    return '+' + digits;
  }
  if (digits.length === 11 && digits.indexOf('974') === 0) return '+' + digits;
  if (digits.length === 8) return '+974' + digits;
  return '+' + digits;
}

function validMemberPhone(phone) {
  // The member UI has a fixed +974 prefix and accepts exactly eight national
  // digits. Do not let Admin create an account that that UI can never reach.
  return /^\+974\d{8}$/.test(String(phone || ''));
}

function validEmail(email) {
  email = String(email || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Uniform response, always. security-implementation.md §3 requires that the
 * caller cannot tell whether a phone number belongs to a member — otherwise
 * this endpoint becomes a membership oracle.
 */
function requestPasscode(data) {
  var phone = normalisePhone(data.phone);
  var uniform = { success: true, message: 'If that number is registered, a passcode is on its way.' };
  if (!phone) return uniform;
  if (!rateLimit('otp_req_' + phone, 3, 900)) return uniform;

  var m = findOne('Members', function (r) { return normalisePhone(r.phone) === phone; });
  if (!m || m.status !== 'ACTIVE' || !m.claimedAt || !m.email) return uniform;

  var code = randomPasscode();
  withLock(function () {
    var sh = sheet('OtpCache');
    var all = rows('OtpCache');
    for (var i = all.length - 1; i >= 0; i--) {
      if (normalisePhone(all[i].phone) === phone || expired(all[i].expiresAt)) sh.deleteRow(all[i].__row);
    }
    append('OtpCache', {
      phone: phone, codeHash: hmac(phone + ':' + code),
      expiresAt: plusSeconds(OTP_TTL_SECONDS), attempts: 0, createdAt: nowIso()
    });
  });

  sendPasscodeEmail(m.email, m.fullName, code);
  sendPasscodeSms_(m.phone, code);
  audit('member', m.id, 'passcode.requested', 'member', m.id, '');
  return uniform;
}

function verifyPasscode(data) {
  var phone = normalisePhone(data.phone);
  var code  = String(data.code || '').trim();
  var fail  = { success: false, error: 'That code is not valid.' };
  if (!phone || !code) return fail;
  if (!rateLimit('otp_ver_' + phone, 20, 900)) return fail;

  return withLock(function () {
    var rec = findOne('OtpCache', function (r) { return normalisePhone(r.phone) === phone; });
    if (!rec) return fail;
    if (expired(rec.expiresAt)) { sheet('OtpCache').deleteRow(rec.__row); return fail; }
    if (Number(rec.attempts || 0) >= OTP_MAX_ATTEMPTS) { sheet('OtpCache').deleteRow(rec.__row); return fail; }

    if (!safeEqual(rec.codeHash, hmac(phone + ':' + code))) {
      updateWhere('OtpCache', function (r) { return r.__row === rec.__row; },
                  { attempts: Number(rec.attempts || 0) + 1 });
      return fail;
    }
    sheet('OtpCache').deleteRow(rec.__row);

    var m = findOne('Members', function (r) { return normalisePhone(r.phone) === phone; });
    if (!m || m.status !== 'ACTIVE' || !m.claimedAt) return fail;

    var token = issueSession('member', m.id, Number(m.tokenVersion || 1), SESSION_TTL_DAYS);
    audit('member', m.id, 'signed.in', 'member', m.id, '');
    return { success: true, token: token, member: memberViewForSelf(m) };
  });
}

function claimMembership(data) {
  var code  = String(data.code || data.claimCode || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  var phone = normalisePhone(data.phone);
  var fail  = { success: false, error: 'That activation code is not valid.' };
  if (!code || !phone) return fail;
  var suppliedConsent = data.consent;
  if (suppliedConsent !== undefined &&
      (!suppliedConsent || typeof suppliedConsent !== 'object' ||
       typeof suppliedConsent.email !== 'boolean' || typeof suppliedConsent.sms !== 'boolean')) {
    return { success: false, error: 'Choose a notification preference for both channels.' };
  }
  // Older versions of the Apps Script page had no consent controls. Treat an
  // omitted object as an explicit decline, never as implicit permission.
  var consent = suppliedConsent || { email: false, sms: false };
  if (!rateLimit('claim_' + phone, 10, 900)) return fail;

  return withLock(function () {
    var all = rows('ClaimCodes');
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      if (!all[i].usedAt && safeEqual(all[i].codeHash, hmac(code))) { hit = all[i]; break; }
    }
    if (!hit || expired(hit.expiresAt)) return fail;

    var m = findOne('Members', function (r) { return r.id === hit.memberId; });
    if (!m) return fail;
    // An unused invitation must not reactivate a member whom an administrator
    // suspended, and an already-claimed account must use the sign-in flow.
    if (m.status !== 'ACTIVE' || m.claimedAt) return fail;
    if (normalisePhone(m.phone) !== phone) return fail;   // code is bound to its member

    var claimedAt = nowIso();
    updateWhere('ClaimCodes', function (r) { return r.id === hit.id; }, { usedAt: claimedAt });
    updateWhere('Members', function (r) { return r.id === m.id; },
                { claimedAt: claimedAt, status: 'ACTIVE' });
    appendConsentRecord(m.id, 'EMAIL', consent.email);
    appendConsentRecord(m.id, 'SMS', consent.sms);
    m.claimedAt = claimedAt;
    m.status = 'ACTIVE';

    var token = issueSession('member', m.id, Number(m.tokenVersion || 1), SESSION_TTL_DAYS);
    audit('member', m.id, 'membership.claimed', 'member', m.id, '');
    return { success: true, token: token, member: memberViewForSelf(m) };
  });
}

function signOut(data) {
  // The caller proves possession by presenting the token; find and drop its row.
  var s = data.__session;
  if (!s || !s.tokenHash) return { success: false, error: 'Sign in required.' };
  return withLock(function () {
    // Re-read inside the lock. Cached row numbers can shift after another
    // simultaneous sign-out deletes a row.
    var all = rows('Sessions');
    var sh = sheet('Sessions');
    for (var i = all.length - 1; i >= 0; i--) {
      if (safeEqual(String(all[i].tokenHash), String(s.tokenHash))) {
        sh.deleteRow(all[i].__row);
        break;
      }
    }
    return { success: true };
  });
}

// ─── Member data ────────────────────────────────────────────────────────────

function publicMember(m) {
  return {
    id: m.id, memberNumber: m.memberNumber, fullName: m.fullName,
    phone: m.phone || null, email: m.email || null, status: m.status,
    joinedAt: isoString(m.joinedAt), claimedAt: m.claimedAt ? isoString(m.claimedAt) : null
  };
}

function boolFromSheet(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function appendConsentRecord(memberId, channel, granted) {
  append('ConsentRecords', {
    id: Utilities.getUuid(), memberId: memberId, channel: channel,
    granted: granted === true, wordingVersion: CONSENT_WORDING_VERSION,
    recordedAt: nowIso()
  });
}

/** Latest append-only state per channel; an absent row means not granted. */
function currentConsent(memberId) {
  var state = { EMAIL: null, SMS: null };
  rows('ConsentRecords').forEach(function (r) {
    if (r.memberId !== memberId) return;
    var channel = String(r.channel || '').toUpperCase();
    if (channel !== 'EMAIL' && channel !== 'SMS') return;
    var candidate = {
      channel: channel,
      granted: boolFromSheet(r.granted),
      wordingVersion: String(r.wordingVersion || ''),
      recordedAt: isoString(r.recordedAt)
    };
    var existing = state[channel];
    if (!existing || new Date(candidate.recordedAt).getTime() >= new Date(existing.recordedAt).getTime())
      state[channel] = candidate;
  });
  return state;
}

function memberViewForSelf(m) {
  var out = publicMember(m);
  out.consent = currentConsent(m.id);
  out.cardCode = cardCodeFor(m.id);
  return out;
}

function getMe(data) {
  var s = requireMember(data);
  var m = findOne('Members', function (r) { return r.id === s.id; });
  if (!m) return { success: false, error: 'Not found.' };
  return { success: true, member: memberViewForSelf(m), stats: memberStats(s.id) };
}

function updateConsent(data) {
  var s = requireMember(data);
  var hasEmail = data.email !== undefined;
  var hasSms = data.sms !== undefined;
  if (!hasEmail && !hasSms)
    return { success: false, error: 'At least one notification channel is required.' };
  if ((hasEmail && typeof data.email !== 'boolean') || (hasSms && typeof data.sms !== 'boolean'))
    return { success: false, error: 'Notification preferences must be true or false.' };

  withLock(function () {
    if (hasEmail) appendConsentRecord(s.id, 'EMAIL', data.email);
    if (hasSms) appendConsentRecord(s.id, 'SMS', data.sms);
  });
  var channels = [];
  if (hasEmail) channels.push('EMAIL');
  if (hasSms) channels.push('SMS');
  audit('member', s.id, 'member.consent_changed', 'member', s.id, channels.join(','));
  return { success: true, consent: currentConsent(s.id) };
}

/**
 * The profile stat bar: what the membership has been worth.
 *
 * `savedMinor` is nullable and stays nullable. A visit with no bill entered
 * contributes to `visits` but not to `savedMinor`, and the client renders "—"
 * rather than "QAR 0" — telling a member a visit saved them nothing is worse
 * than admitting we do not know.
 */
function memberStats(memberId) {
  var mine = rows('Redemptions').filter(function (r) { return r.memberId === memberId; });
  var reversedIds = {};
  mine.forEach(function (r) { if (r.reversesId) reversedIds[String(r.reversesId)] = true; });
  var visits = mine.filter(function (r) { return !r.reversesId && !reversedIds[String(r.id)]; });
  var savedMinor = 0, hasAnyAmount = false;
  var benefits = {};
  mine.forEach(function (r) {
    if (r.savedMinor !== '' && r.savedMinor !== null) {
      var amount = Number(r.savedMinor);
      if (isFinite(amount)) { savedMinor += amount; hasAnyAmount = true; }
    }
  });
  visits.forEach(function (r) { if (r.benefitId) benefits[r.benefitId] = true; });
  return {
    visits: visits.length,
    benefitsUsed: Object.keys(benefits).length,
    savedMinor: hasAnyAmount ? savedMinor : null
  };
}

function getMyActivity(data) {
  var s = requireMember(data);
  var benefits = {}, outlets = {};
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });
  rows('Outlets').forEach(function (o) { outlets[o.id] = o; });
  var mine = rows('Redemptions')
    .filter(function (r) { return r.memberId === s.id; })
    .sort(function (a, b) { return String(b.recordedAt).localeCompare(String(a.recordedAt)); })
    .map(function (r) {
      var benefit = benefits[r.benefitId];
      var outlet = outlets[r.outletId];
      var discountPctApplied = r.discountPctApplied !== ''
        ? percentString(r.discountPctApplied)
        : percentString(benefit ? benefit.discount : '');
      return {
        id: r.id,
        partySize: finiteNumberOrNull(r.partySize),
        discountPctApplied: discountPctApplied,
        savedMinor: finiteNumberOrNull(r.savedMinor),
        occurredAt: isoString(r.recordedAt),
        reversesId: r.reversesId || null,
        benefit: {
          key: benefit ? String(benefit.slug || '') : '',
          title: benefit ? benefit.title : 'Benefit'
        },
        outlet: { name: outlet ? outlet.name : '' },
        // Compatibility aliases for the first Apps Script member page.
        benefitTitle: benefit ? benefit.title : 'Benefit',
        outletName: outlet ? outlet.name : '',
        recordedAt: isoString(r.recordedAt),
        reversal: !!r.reversesId
      };
    });
  return { success: true, activity: mine, redemptions: mine };
}

// ─── Benefits ───────────────────────────────────────────────────────────────

function percentString(value) {
  if (value === null || value === undefined || value === '') return '';
  // A raw JS number here means the cell was written before the discount
  // column was forced to text (see ensureSheetSchema) and Sheets silently
  // stored it as a percentage fraction — "25%" became 0.25. This code only
  // ever writes "NN%"-shaped text, so a bare number can only have arrived
  // this way; recovering it by multiplying back up is safe and lets an
  // already-corrupted row self-heal the next time it's read, without a
  // separate one-time repair pass.
  if (typeof value === 'number') return String(Math.round(value * 10000) / 100);
  var text = String(value).trim();
  return text.replace(/\s*%\s*$/, '');
}

function storedDiscount(value) {
  var pct = percentString(value);
  return pct ? pct + '%' : '';
}

function finiteNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function childRulesValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (Object.prototype.toString.call(value) === '[object Object]') {
    try { return JSON.parse(JSON.stringify(value)); } catch (objectError) { return null; }
  }
  if (typeof value === 'object') return null;
  try {
    var parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

function childRulesForSheet(value) {
  if (value === '' || value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function getBenefits(data) {
  var includeUnpublished = data && data.__session && data.__session.type === 'staff';
  var list = rows('Benefits')
    .filter(function (b) {
      return includeUnpublished || String(b.published).toLowerCase() !== 'false';
    })
    .sort(function (a, b) {
      var aSort = finiteNumberOrNull(a.sortOrder);
      var bSort = finiteNumberOrNull(b.sortOrder);
      var ao = aSort === null ? 100000 + Number(a.__row || 0) : aSort;
      var bo = bSort === null ? 100000 + Number(b.__row || 0) : bSort;
      return ao - bo;
    })
    .map(publicBenefit);
  return { success: true, benefits: list };
}

function getBenefit(data) {
  var identifier = String(data.slug || data.key || data.benefitKey || data.benefitId || '').trim();
  var b = findOne('Benefits', function (r) {
    return (r.slug === identifier || r.id === identifier) &&
      String(r.published).toLowerCase() !== 'false';
  });
  if (!b) return { success: false, error: 'Not found.' };
  return { success: true, benefit: publicBenefit(b) };
}

function publicBenefit(b) {
  var maxGuests = finiteNumberOrNull(b.maxParty);
  var minGuests = finiteNumberOrNull(b.minGuests);
  var sortOrder = finiteNumberOrNull(b.sortOrder);
  var version = finiteNumberOrNull(b.version);
  return {
    id: b.id, slug: b.slug, key: b.slug, category: b.category, title: b.title,
    discount: b.discount, terms: b.terms,
    discountPct: percentString(b.discount),
    secondaryLabel: b.secondaryLabel || null,
    secondaryPct: b.secondaryPct === '' ? null : percentString(b.secondaryPct),
    childRules: childRulesValue(b.childRules),
    maxParty: maxGuests, maxGuests: maxGuests, minGuests: minGuests,
    reservationPhone: b.reservationPhone || null, heroImage: b.heroImage || '',
    sortOrder: sortOrder === null ? Number(b.__row || 0) : sortOrder,
    outletKind: b.outletKind || null,
    version: version === null ? 1 : version,
    published: String(b.published).toLowerCase() !== 'false'
  };
}

function upsertBenefit(data) {
  var s = requireStaff(data);
  var b = data.benefit || {};
  var existing = b.id ? findOne('Benefits', function (r) { return r.id === b.id; }) : null;
  var discount = b.discount !== undefined ? String(b.discount) :
    (b.discountPct !== undefined ? storedDiscount(b.discountPct) : undefined);
  var maxParty = b.maxParty !== undefined ? b.maxParty : b.maxGuests;
  var effectiveTitle = String(b.title !== undefined ? b.title : (existing ? existing.title : '')).trim();
  var effectiveCategory = String(b.category !== undefined ? b.category : (existing ? existing.category : '')).trim();
  var effectiveDiscount = percentString(discount !== undefined ? discount : (existing ? existing.discount : ''));
  var discountNumber = Number(effectiveDiscount);
  if (!effectiveTitle || effectiveTitle.length > 200)
    return { success: false, error: 'Benefit title must be between 1 and 200 characters.' };
  if (!effectiveCategory || effectiveCategory.length > 100)
    return { success: false, error: 'Benefit category must be between 1 and 100 characters.' };
  if (!recognisedCategory(effectiveCategory))
    return {
      success: false,
      error: 'Category "' + effectiveCategory + '" is not recognised. Use Dining, Rooms, Spa, Events, or Other.'
    };
  if (!/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/.test(effectiveDiscount) ||
      !isFinite(discountNumber) || discountNumber < 0 || discountNumber > 100)
    return { success: false, error: 'Discount must be a number from 0 to 100.' };
  discount = String(discountNumber) + '%';

  function guestLimit(value, label) {
    if (value === '' || value === null || value === undefined) return { ok: true, value: null };
    var input = String(value).trim();
    var number = Number(input);
    if (!/^\d+$/.test(input) || !isFinite(number) || Math.floor(number) !== number || number < 1)
      return { ok: false, error: label + ' must be a positive whole number.' };
    return { ok: true, value: number };
  }
  var effectiveMax = maxParty !== undefined ? maxParty : (existing ? existing.maxParty : '');
  var effectiveMin = b.minGuests !== undefined ? b.minGuests : (existing ? existing.minGuests : '');
  var maxCheck = guestLimit(effectiveMax, 'Maximum guests');
  var minCheck = guestLimit(effectiveMin, 'Minimum guests');
  if (!maxCheck.ok) return { success: false, error: maxCheck.error };
  if (!minCheck.ok) return { success: false, error: minCheck.error };
  if (minCheck.value !== null && maxCheck.value !== null && minCheck.value > maxCheck.value)
    return { success: false, error: 'Minimum guests cannot be greater than maximum guests.' };
  var effectiveTerms = String(b.terms !== undefined ? b.terms : (existing ? existing.terms : '')).trim();
  if (!effectiveTerms || effectiveTerms.length > 5000)
    return { success: false, error: 'Benefit terms must be between 1 and 5,000 characters.' };
  if (b.reservationPhone !== undefined && b.reservationPhone !== null &&
      String(b.reservationPhone).trim().length > 50)
    return { success: false, error: 'Reservation phone must be 50 characters or fewer.' };
  if (b.published !== undefined && typeof b.published !== 'boolean')
    return { success: false, error: 'Published must be true or false.' };

  if (existing) {
    updateWhere('Benefits', function (r) { return r.id === b.id; }, {
      slug: b.slug !== undefined ? b.slug : b.key,
      category: b.category, title: b.title, discount: discount, terms: b.terms,
      maxParty: maxParty === null ? '' : maxParty,
      reservationPhone: b.reservationPhone === null ? '' : b.reservationPhone,
      heroImage: b.heroImage,
      published: b.published !== undefined ? b.published !== false : undefined,
      secondaryLabel: b.secondaryLabel === null ? '' : b.secondaryLabel,
      secondaryPct: b.secondaryPct === null ? '' : b.secondaryPct,
      childRules: b.childRules === null ? '' :
        (b.childRules === undefined ? undefined : childRulesForSheet(b.childRules)),
      minGuests: b.minGuests === null ? '' : b.minGuests,
      sortOrder: b.sortOrder,
      outletKind: b.outletKind === null ? '' : b.outletKind,
      version: Number(existing.version || 1) + 1, updatedBy: s.id, updatedAt: nowIso()
    });
    audit('staff', s.id, 'benefit.updated', 'benefit', b.id, b.title);
  } else {
    var id = Utilities.getUuid();
    append('Benefits', {
      id: id, slug: b.slug || b.key, category: b.category, title: b.title, discount: discount || '',
      terms: b.terms, maxParty: maxParty || '', reservationPhone: b.reservationPhone || '',
      heroImage: b.heroImage || '', published: b.published !== false, version: 1,
      secondaryLabel: b.secondaryLabel || '', secondaryPct: b.secondaryPct || '',
      childRules: childRulesForSheet(b.childRules), minGuests: b.minGuests || '',
      sortOrder: b.sortOrder === undefined ? '' : b.sortOrder, outletKind: b.outletKind || '',
      updatedBy: s.id, updatedAt: nowIso()
    });
    audit('staff', s.id, 'benefit.created', 'benefit', id, b.title);
  }
  return { success: true };
}

// ─── Requests ───────────────────────────────────────────────────────────────

function canonicalOutletKind(value) {
  var text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  if (/DINING|RESTAURANT|FOOD|F\s*&\s*B/.test(text)) return 'DINING';
  if (/SPA|WELLNESS/.test(text)) return 'SPA';
  if (/ROOM|SUITE|RESIDENCE/.test(text)) return 'ROOMS';
  if (/EVENT|MEETING|CATERING/.test(text)) return 'EVENTS';
  return 'OTHER';
}

/**
 * The Postgres build rejects an unrecognised outlet kind at the schema level
 * (a strict enum). A spreadsheet has no enum, so the equivalent guarantee has
 * to be enforced here, once, at the point an administrator types a category —
 * otherwise a typo silently falls through canonicalOutletKind() to 'OTHER' at
 * every future lookup with no error anywhere.
 */
function recognisedCategory(category) {
  var text = String(category || '').trim();
  if (!text) return true;
  return canonicalOutletKind(text) !== 'OTHER' || /^other$/i.test(text);
}

function outletChoice(o) {
  return { id: o.id, name: o.name, kind: canonicalOutletKind(o.category) || 'OTHER' };
}

function outletsForBenefitSheet(b) {
  var active = rows('Outlets').filter(function (o) {
    return String(o.active).toLowerCase() !== 'false';
  });
  var exactCategory = active.filter(function (o) {
    return String(o.category || '').trim().toLowerCase() ===
      String(b.category || '').trim().toLowerCase();
  });
  if (!b.outletKind && exactCategory.length) return exactCategory;

  var benefitKind = canonicalOutletKind(b.outletKind || b.category);
  if (!benefitKind) return active;
  return active.filter(function (o) { return canonicalOutletKind(o.category) === benefitKind; });
}

function publishedBenefitFromInput(data) {
  var identifier = String(data.benefitId || data.benefitKey || data.slug || data.key || '').trim();
  if (!identifier || identifier.length > 100) return null;
  return findOne('Benefits', function (r) {
    return (r.id === identifier || r.slug === identifier) &&
      String(r.published).toLowerCase() !== 'false';
  });
}

function memberRequestStatus(value) {
  var status = String(value || '').trim().toUpperCase();
  var aliases = {
    SUBMITTED: 'SENT', SENT: 'SENT',
    USED: 'FULFILLED', FULFILLED: 'FULFILLED',
    NOT_USED: 'NOT_USED', EXPIRED: 'NOT_USED',
    PENDING: 'PENDING', APPROVED: 'APPROVED', DECLINED: 'DECLINED'
  };
  return aliases[status] || 'SENT';
}

/**
 * Apps Script has no always-on process, so stale visit notices are closed
 * lazily whenever a request/queue surface is read or a new notice is created.
 * This mirrors the PostgreSQL 24-hour expiry job and prevents a missed visit
 * from blocking the member forever.
 */
function expireStaleRequests() {
  var cutoff = Date.now() - REQUEST_EXPIRY_HOURS * 60 * 60 * 1000;
  return withLock(function () {
    var sh = sheet('Requests');
    var headers = sheetHeaders(sh);
    var statusCol = headers.indexOf('status') + 1;
    var resolvedAtCol = headers.indexOf('resolvedAt') + 1;
    var resolvedByCol = headers.indexOf('resolvedBy') + 1;
    var closedReasonCol = headers.indexOf('closedReason') + 1;
    var changed = 0;
    rows('Requests').forEach(function (r) {
      var created = new Date(r.createdAt).getTime();
      if (memberRequestStatus(r.status) !== 'SENT' || !isFinite(created) || created > cutoff) return;
      var closedAt = nowIso();
      sh.getRange(r.__row, statusCol).setValue(literalSheetValue('not_used'));
      sh.getRange(r.__row, resolvedAtCol).setValue(literalSheetValue(closedAt));
      sh.getRange(r.__row, resolvedByCol).setValue(literalSheetValue('system'));
      sh.getRange(r.__row, closedReasonCol)
        .setValue(literalSheetValue('No outlet recorded this visit within 24 hours.'));
      changed += 1;
    });
    return changed;
  });
}

function requestForMember(r, benefit, outlet) {
  var status = memberRequestStatus(r.status);
  var closedAt = r.resolvedAt ? isoString(r.resolvedAt) : null;
  var fulfilledAt = r.fulfilledAt ? isoString(r.fulfilledAt) :
    (status === 'FULFILLED' ? closedAt : null);
  return {
    id: r.id,
    status: status,
    requestedAt: isoString(r.createdAt),
    note: r.note || null,
    closedAt: closedAt,
    closedReason: r.closedReason || null,
    fulfilledAt: fulfilledAt,
    benefit: {
      key: benefit ? benefit.slug : '',
      title: benefit ? benefit.title : 'Benefit',
      discountPct: benefit ? percentString(benefit.discount) : ''
    },
    outlet: outlet ? { id: outlet.id, name: outlet.name } : null
  };
}

function createRequest(data) {
  var s = requireMember(data);
  expireStaleRequests();
  var b = publishedBenefitFromInput(data);
  if (!b) return { success: false, error: 'Benefit not found.' };
  var candidates = outletsForBenefitSheet(b);
  var choices = candidates.map(outletChoice).sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  });
  if (!candidates.length) {
    return {
      success: false, code: 'NO_OUTLET_AVAILABLE',
      error: 'No outlet is currently taking this benefit. Please ask at reception.'
    };
  }

  var requestedOutletId = String(data.outletId || '').trim();
  if (requestedOutletId.length > 100)
    return { success: false, code: 'OUTLET_NOT_VALID', error: 'That outlet is not taking this benefit.', outlets: choices };
  var selected = null;
  if (!requestedOutletId && candidates.length === 1) selected = candidates[0];
  if (requestedOutletId) {
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].id === requestedOutletId) { selected = candidates[c]; break; }
    }
  }
  if (!selected) {
    return {
      success: false,
      code: requestedOutletId ? 'OUTLET_NOT_VALID' : 'OUTLET_REQUIRED',
      error: requestedOutletId ? 'That outlet is not taking this benefit.' : 'Choose where you are going.',
      outlets: choices
    };
  }

  var note = String(data.note || '').trim();
  if (note.length > 500) {
    return {
      success: false, code: 'INVALID_NOTE',
      error: 'The note must be 500 characters or fewer.'
    };
  }

  var open = findOne('Requests', function (r) {
    return r.memberId === s.id && r.benefitId === b.id && r.outletId === selected.id &&
      memberRequestStatus(r.status) === 'SENT';
  });
  if (open) {
    return {
      success: false, code: 'REQUEST_ALREADY_OPEN', requestId: open.id,
      error: selected.name + ' already knows you are coming. Just present your card.'
    };
  }

  var id = Utilities.getUuid();
  var writeResult = withLock(function () {
    // Repeat the duplicate check inside the write lock so two quick taps cannot
    // put the same member in the same outlet queue twice.
    var duplicate = findOne('Requests', function (r) {
      return r.memberId === s.id && r.benefitId === b.id && r.outletId === selected.id &&
        memberRequestStatus(r.status) === 'SENT';
    });
    if (duplicate) {
      return {
        success: false, code: 'REQUEST_ALREADY_OPEN', requestId: duplicate.id,
        error: selected.name + ' already knows you are coming. Just present your card.'
      };
    }

    var throttleAfter = Date.now() - REQUEST_THROTTLE_SECONDS * 1000;
    var tooSoon = findOne('Requests', function (r) {
      return r.memberId === s.id && new Date(r.createdAt).getTime() > throttleAfter;
    });
    if (tooSoon) {
      return {
        success: false, code: 'RATE_LIMITED',
        error: 'Please wait a moment before sending another visit notice.'
      };
    }

    var requestRow = {
      id: id, memberId: s.id, benefitId: b.id, outletId: selected.id,
      status: 'submitted', note: note,
      createdAt: nowIso(), resolvedAt: '', resolvedBy: '', closedReason: '',
      fulfilledAt: '', seenAt: '', notifiedAt: '', notifyStatus: '', redemptionId: ''
    };
    append('Requests', requestRow);
    return { success: true, requestRow: requestRow };
  });
  if (!writeResult.success) return writeResult;

  // Mail is deliberately outside the write lock. A slow delivery provider must
  // not block claim-code or redemption writes for the whole application.
  var requestRow = writeResult.requestRow;
  audit('member', s.id, 'request.created', 'request', id,
        b.title + ' · ' + selected.name);
  var m = findOne('Members', function (r) { return r.id === s.id; });
  if (m && m.email) sendRequestSubmittedEmail(m.email, m.fullName, b, selected, note);
  if (m && m.phone) sendRequestSubmittedSms_(m.phone, b, selected);
  var delivered = notifyOutlet(b, m, selected, note);
  requestRow.notifiedAt = nowIso();
  requestRow.notifyStatus = delivered ? 'delivered' : 'not_delivered';
  updateWhere('Requests', function (r) { return r.id === id; }, {
    notifiedAt: requestRow.notifiedAt, notifyStatus: requestRow.notifyStatus
  });
  return {
    success: true, requestId: id,
    request: requestForMember(requestRow, b, selected)
  };
}

function getMyRequests(data) {
  var s = requireMember(data);
  expireStaleRequests();
  var benefits = {}, outlets = {};
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });
  rows('Outlets').forEach(function (o) { outlets[o.id] = o; });
  var mine = rows('Requests')
    .filter(function (r) { return r.memberId === s.id; })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
    .slice(0, 50)
    .map(function (r) { return requestForMember(r, benefits[r.benefitId], outlets[r.outletId]); });
  return { success: true, requests: mine };
}

function getBenefitOutlets(data) {
  requireMember(data);
  var b = publishedBenefitFromInput(data);
  if (!b) return { success: false, error: 'Benefit not found.' };
  var choices = outletsForBenefitSheet(b).map(outletChoice).sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  });
  return { success: true, outlets: choices };
}

function listRequests(data) {
  requireStaff(data);
  expireStaleRequests();
  var members = {}, benefits = {};
  rows('Members').forEach(function (m) { members[m.id] = m; });
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });
  var list = rows('Requests')
    .filter(function (r) { return memberRequestStatus(r.status) === 'SENT'; })
    .map(function (r) {
      return {
        id: r.id, createdAt: isoString(r.createdAt),
        member: members[r.memberId] ? members[r.memberId].fullName : '',
        memberNumber: members[r.memberId] ? members[r.memberId].memberNumber : '',
        benefit: benefits[r.benefitId] ? benefits[r.benefitId].title : '',
        note: r.note
      };
    });
  return { success: true, requests: list };
}

/**
 * They never came. Not a refusal — the entitlement is untouched and the guest
 * can send another notice whenever they like. Mirrors the Postgres build's
 * POST /outlet/requests/:id/not-used: closes a no-show immediately instead of
 * leaving it to the passive 24h sweep in expireStaleRequests().
 */
function markRequestNotUsed(data) {
  var s = requireCounter(data);
  expireStaleRequests();
  var id = String(data.requestId || '').trim();
  if (!id) return { success: false, error: 'Request not found.' };
  var reason = String(data.reason || '').trim();
  if (reason.length > 500) return { success: false, error: 'Reason must be 500 characters or fewer.' };

  var r = findOne('Requests', function (row) { return row.id === id; });
  if (!r) return { success: false, error: 'Request not found.' };
  if (memberRequestStatus(r.status) !== 'SENT')
    return { success: false, error: 'This has already been dealt with.' };

  var b = findOne('Benefits', function (row) { return row.id === r.benefitId; });
  if (s.type === 'outlet') {
    var o = findOne('Outlets', function (row) { return row.id === s.outletId; });
    var belongsHere = r.outletId ? r.outletId === s.outletId :
      (o && b && canonicalOutletKind(b.outletKind || b.category) === canonicalOutletKind(o.category));
    if (!belongsHere) return { success: false, error: 'Request not found.' };
  }

  var writeResult = withLock(function () {
    var current = findOne('Requests', function (row) { return row.id === id; });
    if (!current || memberRequestStatus(current.status) !== 'SENT')
      return { success: false, error: 'This has already been dealt with.' };
    updateWhere('Requests', function (row) { return row.id === id; }, {
      status: 'not_used', resolvedAt: nowIso(), resolvedBy: s.id,
      closedReason: reason || 'Marked not used by the outlet.'
    });
    return { success: true };
  });
  if (!writeResult.success) return writeResult;

  audit(s.type, s.id, 'request.not_used', 'request', id, reason || '');
  var m = findOne('Members', function (row) { return row.id === r.memberId; });
  if (m && m.email && b) sendRequestNotUsedEmail(m.email, m.fullName, b, reason);
  if (m && m.phone && b) sendRequestNotUsedSms_(m.phone, b);
  return { success: true };
}

// ─── Redemptions ────────────────────────────────────────────────────────────

/**
 * R7 — append only. This function never updates or deletes a Redemption row,
 * and neither does reverseRedemption(): a correction appends a second row that
 * points back at the first. See the header note about what this does and does
 * not guarantee on a spreadsheet.
 */
function recordRedemption(data) {
  var s = requireCounter(data);
  expireStaleRequests();
  // An outlet device records against its own outlet and nothing else. Only an
  // administrator may name the outlet, because only they can see all of them.
  if (s.type === 'outlet') data.outletId = s.outletId;
  var memberId  = String(data.memberId || '').trim();
  var benefitId = String(data.benefitId || '').trim();
  var partySize = Number(data.partySize || 0);
  if (memberId.length > 100 || benefitId.length > 100)
    return { success: false, error: 'Member or benefit reference is not valid.' };

  var idempotencyKey = String(data.idempotencyKey || '').trim();
  var verificationSession = String(data.verificationSession || '').trim();
  if (s.type === 'outlet') {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
      return { success: false, error: 'Start the lookup again before recording this visit.' };
    var prior = findOne('Redemptions', function (r) {
      return r.recordedBy === s.id && r.idempotencyKey === idempotencyKey;
    });
    if (prior) {
      if (prior.memberId !== memberId || prior.benefitId !== benefitId || prior.outletId !== s.outletId)
        return { success: false, error: 'That recording reference has already been used.' };
      return {
        success: true, redemptionId: prior.id,
        savedMinor: finiteNumberOrNull(prior.savedMinor),
        fulfilledRequestId: null, duplicate: true
      };
    }
    if (!verifyCounterVerification(s, memberId, verificationSession)) {
      return {
        success: false, code: 'VERIFICATION_REQUIRED',
        error: 'Scan the card or look up the membership number again before recording this visit.'
      };
    }
  } else if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
    return { success: false, error: 'Recording reference is not valid.' };
  }

  var m = findOne('Members', function (r) { return r.id === memberId; });
  if (!m) return { success: false, error: 'Member not found.' };
  if (m.status !== 'ACTIVE' || !m.claimedAt)
    return { success: false, error: 'Membership is not active.' };

  var b = findOne('Benefits', function (r) {
    return r.id === benefitId && String(r.published).toLowerCase() !== 'false';
  });
  if (!b) return { success: false, error: 'Benefit is not available.' };

  // Party size is required, not an optional note: the caps are unenforceable
  // without it and reporting cannot say what the programme costs.
  if (!isFinite(partySize) || Math.floor(partySize) !== partySize || partySize < 1)
    return { success: false, error: 'Party size is required.' };
  var cap = finiteNumberOrNull(b.maxParty);
  if (b.maxParty !== '' && cap === null)
    return { success: false, error: 'This benefit has an invalid guest limit. Ask an administrator to correct it.' };
  if (cap && partySize > cap)
    return { success: false, error: 'This benefit allows a maximum of ' + cap + ' people.' };
  var floor = finiteNumberOrNull(b.minGuests);
  if (b.minGuests !== '' && floor === null)
    return { success: false, error: 'This benefit has an invalid minimum guest count. Ask an administrator to correct it.' };
  if (floor && partySize < floor)
    return { success: false, error: 'This benefit requires at least ' + floor + ' people.' };

  var billMinor  = (data.billMinor === '' || data.billMinor === undefined || data.billMinor === null)
                     ? null : Number(data.billMinor);
  if (billMinor !== null && (!isFinite(billMinor) || Math.floor(billMinor) !== billMinor || billMinor < 0))
    return { success: false, error: 'Bill amount must be a non-negative whole number of fils.' };
  var savedMinor = null;
  var discountPctApplied = percentString(b.discount);
  var appliedRate = Number(discountPctApplied);
  if (!isFinite(appliedRate) || appliedRate < 0 || appliedRate > 100)
    return { success: false, error: 'This benefit has an invalid discount. Ask an administrator to correct it.' };
  if (billMinor !== null) {
    savedMinor = Math.round(billMinor * (appliedRate / 100));
  }

  var outletId = String(data.outletId || '').trim();
  var outlet = findOne('Outlets', function (r) { return r.id === outletId; });
  if (!outlet) return { success: false, error: 'Outlet not found.' };
  var honoursBenefit = outletsForBenefitSheet(b).some(function (candidate) {
    return candidate.id === outletId;
  });
  if (!honoursBenefit)
    return { success: false, error: 'This outlet is not authorised for that benefit.' };

  var requestId = String(data.requestId || '').trim();
  if (!requestId) {
    // The original outlet page opens a queued member and then records from the
    // lookup screen without carrying the queue id forward. There can be only
    // one open row for this member/benefit/outlet, so close that row implicitly.
    var matchingNotice = findOne('Requests', function (r) {
      return r.memberId === memberId && r.benefitId === benefitId &&
        (!r.outletId || r.outletId === outletId) &&
        memberRequestStatus(r.status) === 'SENT';
    });
    if (matchingNotice) requestId = String(matchingNotice.id);
  }
  if (requestId.length > 100) return { success: false, error: 'Request reference is not valid.' };
  if (requestId) {
    var requested = findOne('Requests', function (r) { return r.id === requestId; });
    if (!requested || requested.memberId !== memberId || requested.benefitId !== benefitId ||
        (requested.outletId && requested.outletId !== outletId) ||
        memberRequestStatus(requested.status) !== 'SENT')
      return { success: false, error: 'That visit notice cannot be fulfilled.' };
  }

  var writeResult = withLock(function () {
    if (idempotencyKey) {
      var duplicate = findOne('Redemptions', function (r) {
        return r.recordedBy === s.id && r.idempotencyKey === idempotencyKey;
      });
      if (duplicate) {
        if (duplicate.memberId !== memberId || duplicate.benefitId !== benefitId || duplicate.outletId !== outletId)
          return { success: false, error: 'That recording reference has already been used.' };
        return {
          success: true, redemptionId: duplicate.id,
          savedMinor: finiteNumberOrNull(duplicate.savedMinor),
          fulfilledRequestId: null, duplicate: true
        };
      }
    }
    if (s.type === 'outlet' && !verifyCounterVerification(s, memberId, verificationSession)) {
      return {
        success: false, code: 'VERIFICATION_REQUIRED',
        error: 'Scan the card or look up the membership number again before recording this visit.'
      };
    }
    if (requestId) {
      var stillOpen = findOne('Requests', function (r) {
        return r.id === requestId && r.memberId === memberId && r.benefitId === benefitId &&
          (!r.outletId || r.outletId === outletId) && memberRequestStatus(r.status) === 'SENT';
      });
      if (!stillOpen) return { success: false, error: 'That visit notice has already been closed.' };
    }
    var id = Utilities.getUuid();
    var recordedAt = nowIso();
    append('Redemptions', {
      id: id, memberId: memberId, benefitId: benefitId, outletId: outletId,
      partySize: partySize,
      billMinor: billMinor === null ? '' : billMinor,
      savedMinor: savedMinor === null ? '' : savedMinor,
      recordedBy: s.id, recordedAt: recordedAt, reversesId: '',
      discountPctApplied: discountPctApplied,
      benefitVersion: finiteNumberOrNull(b.version) === null ? 1 : finiteNumberOrNull(b.version),
      idempotencyKey: idempotencyKey
    });
    if (requestId) {
      updateWhere('Requests', function (r) { return r.id === requestId; }, {
        status: 'used', resolvedAt: recordedAt, resolvedBy: s.id,
        fulfilledAt: recordedAt, redemptionId: id
      });
    }
    if (s.type === 'outlet') consumeCounterVerification(verificationSession);
    return {
      success: true, redemptionId: id, savedMinor: savedMinor,
      fulfilledRequestId: requestId || null
    };
  });
  if (!writeResult.success) return writeResult;
  if (writeResult.duplicate) return writeResult;
  // Mirrors the Postgres build's split between fulfilling an announced visit
  // notice (.outlet) and a walk-up counter scan with no notice (.scan) — so an
  // investigator can tell which happened without opening the row itself.
  // Admin-recorded entries with neither keep the generic event; the Postgres
  // build has no equivalent path since admins never call the outlet routes.
  var recordedAction = writeResult.fulfilledRequestId ? 'redemption.recorded.outlet' :
    (s.type === 'outlet' ? 'redemption.recorded.scan' : 'redemption.recorded');
  audit(s.type, s.id, recordedAction, 'redemption', writeResult.redemptionId,
        b.title + ' · party ' + partySize);
  if (m.email) sendRedemptionRecordedEmail(m.email, m.fullName, b, savedMinor);
  if (m.phone) sendRedemptionRecordedSms_(m.phone, b, savedMinor);
  return writeResult;
}

function reverseRedemption(data) {
  var s = requireStaff(data);
  var reason = String(data.reason || '').trim();
  if (!reason || reason.length > 500)
    return { success: false, error: 'A correction reason of 500 characters or fewer is required.' };
  var original = findOne('Redemptions', function (r) { return r.id === String(data.redemptionId || ''); });
  if (!original) return { success: false, error: 'Redemption not found.' };
  if (original.reversesId) return { success: false, error: 'That entry is itself a reversal.' };
  var originalParty = finiteNumberOrNull(original.partySize);
  var originalBill = finiteNumberOrNull(original.billMinor);
  var originalSaved = finiteNumberOrNull(original.savedMinor);
  if (originalParty === null)
    return { success: false, error: 'That redemption has an invalid party size and cannot be reversed automatically.' };
  if (findOne('Redemptions', function (r) { return r.reversesId === original.id; }))
    return { success: false, error: 'That entry has already been reversed.' };

  return withLock(function () {
    if (findOne('Redemptions', function (r) { return r.reversesId === original.id; }))
      return { success: false, error: 'That entry has already been reversed.' };
    var id = Utilities.getUuid();
    var benefit = findOne('Benefits', function (r) { return r.id === original.benefitId; });
    append('Redemptions', {
      id: id, memberId: original.memberId, benefitId: original.benefitId,
      outletId: original.outletId, partySize: Math.abs(originalParty),
      billMinor: originalBill === null ? '' : -Math.abs(originalBill),
      savedMinor: originalSaved === null ? '' : -Math.abs(originalSaved),
      recordedBy: s.id, recordedAt: nowIso(), reversesId: original.id,
      discountPctApplied: original.discountPctApplied ||
        (benefit ? percentString(benefit.discount) : ''),
      benefitVersion: finiteNumberOrNull(original.benefitVersion) === null
        ? (benefit && finiteNumberOrNull(benefit.version) !== null ? finiteNumberOrNull(benefit.version) : '')
        : finiteNumberOrNull(original.benefitVersion),
      idempotencyKey: ''
    });
    audit('staff', s.id, 'redemption.reversed', 'redemption', original.id,
          reason);
    return { success: true, reversalId: id };
  });
}

function listRedemptions(data) {
  var session = requireCounter(data);
  var members = {}, benefits = {}, outlets = {};
  rows('Members').forEach(function (m) { members[m.id] = m; });
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });
  rows('Outlets').forEach(function (o) { outlets[o.id] = o; });
  var limit = Math.floor(Number(data.limit || 200));
  if (!isFinite(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 200);
  var list = rows('Redemptions')
    .filter(function (r) {
      return session.type !== 'outlet' || r.outletId === session.outletId;
    })
    .sort(function (a, b) { return String(b.recordedAt).localeCompare(String(a.recordedAt)); })
    .slice(0, limit)
    .map(function (r) {
      return {
        id: r.id, recordedAt: isoString(r.recordedAt),
        member: members[r.memberId] ? members[r.memberId].fullName : '',
        memberNumber: members[r.memberId] ? members[r.memberId].memberNumber : '',
        benefit: benefits[r.benefitId] ? benefits[r.benefitId].title : '',
        outlet: outlets[r.outletId] ? outlets[r.outletId].name : '',
        partySize: finiteNumberOrNull(r.partySize),
        savedMinor: finiteNumberOrNull(r.savedMinor),
        reversal: !!r.reversesId
      };
    });
  // Staff only — an outlet device checking its own recent counter history is
  // routine shift use, not the bulk-record access §9 asks to be traced.
  if (session.type === 'staff')
    audit('staff', session.id, 'report.viewed', 'report', '', 'redemptions · ' + list.length);
  return { success: true, redemptions: list };
}

function resolveMember(data) {
  var session = requireCounter(data);
  var raw = String(data.cardCode || data.payload || data.membershipNumber || data.query || '').trim();
  if (!raw) return { success: false, error: 'Enter a membership number or card code.' };
  if (raw.length > 200) return { success: false, error: 'No matching member.' };
  if (!rateLimit('resolve_' + session.type + '_' + session.id, 60, 3600)) {
    audit(session.type, session.id, 'verification.lookup.rate_limited', 'member', '', '');
    return { success: false, code: 'RATE_LIMITED', error: 'Too many lookups. Try again later.' };
  }

  var looksLikeCard = !!String(data.cardCode || data.payload || '').trim() ||
    raw.slice(0, 3).toLowerCase() === 'v2.';
  var cardMemberId = looksLikeCard ? memberIdFromCardCode(raw) : null;
  var method = looksLikeCard ? 'cardCode' : 'membershipNumber';
  if (looksLikeCard && !cardMemberId) {
    audit(session.type, session.id, 'verification.lookup.failure', 'member', '', method);
    return { success: false, error: 'No matching member.' };
  }

  var q = raw.toUpperCase();
  var m = findOne('Members', function (r) {
    if (cardMemberId) return r.id === cardMemberId;
    return String(r.memberNumber).trim().toUpperCase() === q;
  });
  if (!m) {
    audit(session.type, session.id, 'verification.lookup.failure', 'member', '', method);
    return { success: false, error: 'No matching member.' };
  }
  audit(session.type, session.id, 'verification.lookup.success', 'member', m.id, method);

  var valid = m.status === 'ACTIVE' && !!m.claimedAt;
  var benefits = getBenefits({}).benefits;
  if (session.type === 'outlet') {
    var outlet = findOne('Outlets', function (r) { return r.id === session.outletId; });
    if (outlet) {
      benefits = benefits.filter(function (benefit) {
        return outletsForBenefitSheet(benefit).some(function (candidate) {
          return candidate.id === outlet.id;
        });
      });
    } else benefits = [];
  }
  var verificationSession = valid ? issueCounterVerification(session, m.id) : null;
  return {
    success: true,
    member: {
      id: valid ? m.id : '',
      memberNumber: m.memberNumber,
      fullName: valid ? m.fullName : '',
      status: valid ? 'ACTIVE' : 'INACTIVE'
    },
    matchedBy: method,
    valid: valid,
    verificationSession: verificationSession,
    verificationSessionExpiresIn: valid ? VERIFICATION_SESSION_TTL_SECONDS : 0,
    benefits: valid ? benefits : []
  };
}

// ─── Members (administrator) ────────────────────────────────────────────────

function nextMemberNumber() {
  var max = 0;
  rows('Members').forEach(function (m) {
    var n = parseInt(String(m.memberNumber).replace(/\D/g, ''), 10);
    if (n > max) max = n;
  });
  return 'PG-' + String(max + 1).padStart(4, '0');
}

function listMembers(data) {
  var s = requireStaff(data);
  var list = rows('Members').map(function (m) {
    var st = memberStats(m.id);
    var o = publicMember(m); o.visits = st.visits; o.savedMinor = st.savedMinor;
    return o;
  });
  // §9 parity with the Postgres build's per-record member.viewed: the Sheet
  // architecture reads the whole roster on every call, so the honest
  // equivalent is one event per list, not one per row.
  audit('staff', s.id, 'member.listed', 'member', '', 'count:' + list.length);
  return { success: true, members: list };
}

function createMember(data) {
  var s = requireStaff(data);
  var name  = String(data.fullName || '').trim();
  var phone = normalisePhone(data.phone);
  var email = String(data.email || '').trim();
  if (!name)  return { success: false, error: 'Name is required.' };
  if (!validMemberPhone(phone))
    return { success: false, error: 'Enter an eight-digit Qatar mobile number.' };
  if (!validEmail(email))
    return { success: false, error: 'Enter a valid email address — passcodes are delivered by email.' };

  if (findOne('Members', function (r) { return normalisePhone(r.phone) === phone; }))
    return { success: false, error: 'That mobile number is already registered.' };

  var created = withLock(function () {
    if (findOne('Members', function (r) { return normalisePhone(r.phone) === phone; }))
      return { success: false, error: 'That mobile number is already registered.' };
    var id = Utilities.getUuid();
    var number = nextMemberNumber();
    append('Members', {
      id: id, memberNumber: number, fullName: name, phone: phone, email: email,
      status: 'ACTIVE', joinedAt: nowIso(), claimedAt: '', tokenVersion: 1,
      createdBy: s.id, createdAt: nowIso()
    });

    var code = randomClaimCode();
    append('ClaimCodes', {
      id: Utilities.getUuid(), memberId: id, codeHash: hmac(code.replace(/-/g, '')),
      expiresAt: plusDays(CLAIM_CODE_TTL_DAYS), usedAt: '', createdAt: nowIso()
    });
    return { success: true, id: id, memberNumber: number, claimCode: code };
  });
  if (!created.success) return created;

  var emailDelivered = sendInvitationEmail(email, name, created.memberNumber, created.claimCode);
  var smsDelivered = sendInvitationSms_(phone, created.claimCode);
  var delivered = emailDelivered || smsDelivered;
  audit('staff', s.id, 'member.created', 'member', created.id, created.memberNumber);

  // If delivery failed on every channel the administrator must be able to
  // pass the code on by hand, so it is returned. When at least one channel
  // succeeded it is not — the member already has it and there is no reason
  // to put it on a second screen.
  return {
    success: true, memberNumber: created.memberNumber, delivered: delivered,
    claimCode: delivered ? null : created.claimCode
  };
}

function setMemberStatus(data) {
  var s = requireStaff(data);
  var m = findOne('Members', function (r) { return r.id === String(data.memberId || ''); });
  if (!m) return { success: false, error: 'Member not found.' };
  var status = String(data.status || '').toUpperCase();
  if (['ACTIVE', 'SUSPENDED'].indexOf(status) === -1) return { success: false, error: 'Invalid status.' };

  // Suspension must invalidate outstanding sessions immediately, so bump the
  // token version — requireSession() compares it on every request.
  updateWhere('Members', function (r) { return r.id === m.id; },
              { status: status, tokenVersion: Number(m.tokenVersion || 1) + 1 });
  audit('staff', s.id, 'member.' + status.toLowerCase(), 'member', m.id, '');
  return { success: true };
}

/**
 * Corrects a member's own details after creation — a typo'd email or a phone
 * number that changed. Mirrors the Postgres build's PATCH /admin/members/:id;
 * without it a mistake made at createMember() could only be fixed by editing
 * the Sheet by hand.
 */
function updateMember(data) {
  var s = requireStaff(data);
  var m = findOne('Members', function (r) { return r.id === String(data.memberId || ''); });
  if (!m) return { success: false, error: 'Member not found.' };

  var patch = {};
  var changed = [];

  if (data.fullName !== undefined) {
    var name = String(data.fullName || '').trim();
    if (!name) return { success: false, error: 'Name is required.' };
    patch.fullName = name; changed.push('fullName');
  }
  if (data.phone !== undefined) {
    var phone = normalisePhone(data.phone);
    if (!validMemberPhone(phone))
      return { success: false, error: 'Enter an eight-digit Qatar mobile number.' };
    if (findOne('Members', function (r) { return r.id !== m.id && normalisePhone(r.phone) === phone; }))
      return { success: false, error: 'That mobile number is already registered.' };
    patch.phone = phone; changed.push('phone');
  }
  if (data.email !== undefined) {
    var email = String(data.email || '').trim();
    if (!validEmail(email))
      return { success: false, error: 'Enter a valid email address — passcodes are delivered by email.' };
    patch.email = email; changed.push('email');
  }
  if (!changed.length) return { success: false, error: 'Nothing to update.' };

  updateWhere('Members', function (r) { return r.id === m.id; }, patch);
  audit('staff', s.id, 'member.updated', 'member', m.id, changed.join(','));
  return { success: true };
}

/**
 * Recovery path for an invitation that never arrived, bounced, or expired
 * unclaimed. Mirrors the Postgres build's POST /admin/members/:id/resend-claim:
 * any outstanding code is superseded so only the newest one is usable, and the
 * plaintext is always returned to the administrator — unlike createMember(),
 * which withholds it on a successful send — because this route exists
 * precisely for when the normal delivery did not reach the member.
 */
function resendClaimCode(data) {
  var s = requireStaff(data);
  var m = findOne('Members', function (r) { return r.id === String(data.memberId || ''); });
  if (!m) return { success: false, error: 'Member not found.' };
  if (m.claimedAt) return { success: false, error: 'This membership has already been activated.' };

  return withLock(function () {
    var supersededAt = nowIso();
    rows('ClaimCodes').forEach(function (r) {
      if (r.memberId === m.id && !r.usedAt) {
        updateWhere('ClaimCodes', function (row) { return row.id === r.id; }, { usedAt: supersededAt });
      }
    });
    var code = randomClaimCode();
    append('ClaimCodes', {
      id: Utilities.getUuid(), memberId: m.id, codeHash: hmac(code.replace(/-/g, '')),
      expiresAt: plusDays(CLAIM_CODE_TTL_DAYS), usedAt: '', createdAt: nowIso()
    });
    var emailDelivered = sendInvitationEmail(m.email, m.fullName, m.memberNumber, code);
    var smsDelivered = sendInvitationSms_(m.phone, code);
    var delivered = emailDelivered || smsDelivered;
    audit('staff', s.id, 'member.claim_code_issued', 'member', m.id, m.memberNumber);
    return { success: true, delivered: delivered, claimCode: code };
  });
}

// ─── Outlets and their devices ──────────────────────────────────────────────

/**
 * The credential belongs to the *device*, not a person. Every tablet or counter
 * computer gets its own token, so one can be revoked without disturbing the
 * others — and a lost tablet does not mean rotating a shared password.
 */
function outletLogin(data) {
  var raw = String(data.deviceToken || '').trim();
  var fail = { success: false, error: 'That device token is not valid.' };
  if (!raw) return fail;
  if (!rateLimit('outlet_' + raw.slice(0, 8), 10, 900)) return fail;

  var h = hmac(raw);
  var tok = findOne('OutletTokens', function (r) {
    return r.status === 'active' && safeEqual(String(r.tokenHash), h);
  });
  if (!tok) {
    // Never the token or its hash — same §9 parity as staffLogin's failure trace.
    audit('outlet', '', 'auth.outlet.login.failure', 'outlet', '', '');
    return fail;
  }

  var o = findOne('Outlets', function (r) { return r.id === tok.outletId; });
  if (!o || String(o.active).toLowerCase() === 'false') {
    audit('outlet', tok.id, 'auth.outlet.login.failure', 'outlet', tok.outletId, '');
    return fail;
  }

  var session = issueSession('outlet', tok.id, 1, 30);
  audit('outlet', tok.id, 'outlet.signed.in', 'outlet', o.id, tok.label);
  return { success: true, token: session, outlet: { id: o.id, name: o.name, category: o.category } };
}

function listOutlets(data) {
  requireStaff(data);
  var tokens = rows('OutletTokens');
  return { success: true, outlets: rows('Outlets').map(function (o) {
    return {
      id: o.id, name: o.name, category: o.category, notifyEmail: o.notifyEmail,
      active: String(o.active).toLowerCase() !== 'false',
      devices: tokens.filter(function (t) { return t.outletId === o.id && t.status === 'active'; })
        .map(function (t) {
          return { id: t.id, label: t.label, status: t.status, issuedAt: isoString(t.issuedAt) };
        })
        .map(function (t) { return { id: t.id, label: t.label, issuedAt: t.issuedAt }; })
    };
  }) };
}

function upsertOutlet(data) {
  var s = requireStaff(data);
  var o = data.outlet || {};
  if (!String(o.name || '').trim()) return { success: false, error: 'Name is required.' };
  if (!recognisedCategory(o.category))
    return {
      success: false,
      error: 'Category "' + String(o.category || '').trim() + '" is not recognised. Use Dining, Rooms, Spa, Events, or Other.'
    };
  if (o.id && findOne('Outlets', function (r) { return r.id === o.id; })) {
    updateWhere('Outlets', function (r) { return r.id === o.id; }, {
      name: o.name, category: o.category || '', notifyEmail: o.notifyEmail || '',
      active: o.active !== false
    });
    audit('staff', s.id, 'outlet.updated', 'outlet', o.id, o.name);
    return { success: true, id: o.id };
  }
  var id = Utilities.getUuid();
  append('Outlets', {
    id: id, name: o.name, category: o.category || '',
    notifyEmail: o.notifyEmail || '', active: true
  });
  audit('staff', s.id, 'outlet.created', 'outlet', id, o.name);
  return { success: true, id: id };
}

/**
 * Returned in plaintext exactly once. There is no way to read it back — the
 * sheet holds only the hash — so a lost token is replaced, never recovered.
 */
function issueOutletToken(data) {
  var s = requireStaff(data);
  var o = findOne('Outlets', function (r) { return r.id === String(data.outletId || ''); });
  if (!o) return { success: false, error: 'Outlet not found.' };
  var raw = randomToken().slice(0, 24).toUpperCase();
  var id = Utilities.getUuid();
  append('OutletTokens', {
    id: id, outletId: o.id, label: String(data.label || 'Counter device').slice(0, 60),
    tokenHash: hmac(raw), status: 'active', issuedBy: s.id, issuedAt: nowIso(), revokedAt: ''
  });
  audit('staff', s.id, 'outlet.token.issued', 'outlet', o.id, data.label || '');
  var delivered = o.notifyEmail ? sendOutletTokenEmail(o.notifyEmail, o.name, raw) : false;
  return { success: true, deviceToken: raw, outlet: o.name, delivered: delivered };
}

function revokeOutletToken(data) {
  var s = requireStaff(data);
  var ok = updateWhere('OutletTokens', function (r) { return r.id === String(data.tokenId || ''); },
                       { status: 'revoked', revokedAt: nowIso() });
  if (!ok) return { success: false, error: 'Device not found.' };
  audit('staff', s.id, 'outlet.token.revoked', 'outletToken', data.tokenId, '');
  return { success: true };
}

// requestOutletToken() was removed deliberately. It let anyone who knew an
// outlet's registered address self-provision an *active* counter device token,
// emailed to that address, with no administrator involved — so possession of
// (or access to) an outlet mailbox was enough to enroll a tablet. Device
// enrollment is now issueOutletToken() only, which is behind requireStaff().
// Do not reintroduce a public path here without replacing the admin approval
// step it removes.

/** What this outlet is expecting. Scoped to the signed-in device's outlet. */
function getOutletQueue(data) {
  var s = requireCounter(data);
  expireStaleRequests();
  var outletId = s.type === 'outlet' ? s.outletId : String(data.outletId || '');
  var o = findOne('Outlets', function (r) { return r.id === outletId; });
  var members = {}, benefits = {};
  rows('Members').forEach(function (m) { members[m.id] = m; });
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });

  var list = rows('Requests').filter(function (r) {
    if (memberRequestStatus(r.status) !== 'SENT') return false;
    if (r.outletId) return r.outletId === outletId;
    // Requests made from the member app carry no outlet, so match on category —
    // a spa request belongs in the spa's queue.
    var b = benefits[r.benefitId];
    return o && b && canonicalOutletKind(b.outletKind || b.category) ===
      canonicalOutletKind(o.category);
  }).sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
    .map(function (r) {
      var m = members[r.memberId], b = benefits[r.benefitId];
      return {
        id: r.id, requestedAt: isoString(r.createdAt), note: r.note,
        memberId: r.memberId,
        member: m ? m.fullName : '', memberNumber: m ? m.memberNumber : '',
        valid: m ? m.status === 'ACTIVE' && !!m.claimedAt : false,
        benefitId: r.benefitId, benefit: b ? b.title : '',
        maxParty: b ? finiteNumberOrNull(b.maxParty) : null
      };
    });
  return { success: true, outlet: o ? o.name : '', queue: list };
}

// ─── Staff ──────────────────────────────────────────────────────────────────

// ─── Staff MFA (TOTP) ───────────────────────────────────────────────────────
//
// Closes the "no administrator second factor" gap this port previously carried
// as a documented limitation. It is a hand-rolled RFC 6238 implementation
// because Apps Script has no otplib and no crypto library to lean on; that is
// exactly why it is one contiguous, commented block rather than helpers
// scattered through the file.
//
// WHERE THIS DIFFERS FROM THE POSTGRES BUILD, AND WHY
// ---------------------------------------------------------------------------
// 1. `security/mfa.ts` encrypts the TOTP secret with AES-256-GCM before it
//    reaches the database, so a stolen dump yields no working second factors.
//    Apps Script exposes no symmetric cipher, so that is not reproducible here.
//    Instead the secret never goes in the Sheet at all — it lives in Script
//    Properties, which a Sheet editor cannot read and which only someone who
//    can open the script project can reach. That is a *relocation* of the
//    secret out of the exportable surface, not encryption of it. It is a
//    weaker guarantee than the Postgres build's and is recorded as such.
// 2. Recovery codes are HMAC-SHA256 hashed rather than Argon2id, for the same
//    reason passcodes are (see the file header): there is no argon2 here. They
//    carry ~49 bits from a CSPRNG, so they are not password-shaped guessable
//    secrets, and the key is a Script Property rather than a value in the row.
//
// Everything else matches: mandatory for every active administrator, ±1 period
// of skew tolerance, single-use codes enforced by recording the accepted
// period, and ten single-use recovery codes.

var TOTP_PERIOD_SECONDS = 30;
var TOTP_DIGITS         = 6;
/**
 * One period either side of the current one. RFC 6238 §5.2 anticipates this
 * much skew; wider meaningfully extends how long an intercepted code stays
 * usable, so it is a constant and not configuration.
 */
var TOTP_DRIFT_STEPS = 1;

var MFA_CHALLENGE_TTL_SECONDS = 300;
/** No 0/O or 1/I/L — these get read aloud and typed from a printout. */
var RECOVERY_ALPHABET    = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var RECOVERY_CODE_LENGTH = 10;
var RECOVERY_CODE_COUNT  = 10;

var BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Apps Script byte arrays are signed (-128..127); ours are built unsigned. */
function toSignedBytes_(values) {
  return values.map(function (b) {
    b = b & 0xff;
    return b > 127 ? b - 256 : b;
  });
}

function base32Encode_(bytes) {
  var bits = 0, value = 0, out = '';
  for (var i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] & 0xff);
    bits += 8;
    while (bits >= 5) { out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31); bits -= 5; }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Returns null on any character outside the alphabet, rather than guessing. */
function base32Decode_(text) {
  text = String(text || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  if (!text) return null;
  var bits = 0, value = 0, out = [];
  for (var i = 0; i < text.length; i++) {
    var index = BASE32_ALPHABET.indexOf(text.charAt(i));
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return out;
}

/** 20 bytes / 160 bits — the RFC 4226 recommendation. */
function generateMfaSecret_() {
  var bytes = [];
  while (bytes.length < 20) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + String(Date.now()), Utilities.Charset.UTF_8);
    for (var i = 0; i < digest.length && bytes.length < 20; i++) bytes.push(digest[i] & 0xff);
  }
  return base32Encode_(bytes);
}

/** RFC 4226 HOTP: HMAC-SHA1 over the 8-byte counter, dynamically truncated. */
function hotpAt_(secretBase32, counter) {
  var key = base32Decode_(secretBase32);
  if (!key || !key.length) return null;

  var message = [];
  var remaining = counter;
  for (var i = 7; i >= 0; i--) { message[i] = remaining & 0xff; remaining = Math.floor(remaining / 256); }

  var signature = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1, toSignedBytes_(message), toSignedBytes_(key));

  var offset = signature[signature.length - 1] & 0x0f;
  var binary = ((signature[offset] & 0x7f) << 24) |
               ((signature[offset + 1] & 0xff) << 16) |
               ((signature[offset + 2] & 0xff) << 8) |
                (signature[offset + 3] & 0xff);
  var code = String(binary % Math.pow(10, TOTP_DIGITS));
  while (code.length < TOTP_DIGITS) code = '0' + code;
  return code;
}

/**
 * A correct code from a period already spent is refused even though it is
 * cryptographically valid. §3 requires the member OTP to be single use, and
 * there is no principled reason a staff second factor should be weaker: a code
 * is valid for ~90 seconds here, which is ample to reuse one read over a
 * shoulder or lifted from a keylogger.
 */
function verifyTotp_(secret, token, afterEpoch) {
  token = String(token || '').replace(/\s/g, '');
  if (!new RegExp('^\\d{' + TOTP_DIGITS + '}$').test(token)) return { valid: false };

  var current = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (var drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift++) {
    var counter = current + drift;
    var expected = hotpAt_(secret, counter);
    if (expected && safeEqual(expected, token)) {
      // `<=` not `<`: the same period must not be reusable, which is the point.
      if (afterEpoch !== null && afterEpoch !== undefined && counter <= Number(afterEpoch))
        return { valid: false };
      return { valid: true, epoch: counter };
    }
  }
  return { valid: false };
}

// ── Secret storage ──────────────────────────────────────────────────────────
// Script Properties, never the Sheet. See the note at the top of this section.

function mfaSecretKey_(staffId) { return 'MFA_SECRET_' + String(staffId); }

function storedMfaSecret_(staffId) {
  return PropertiesService.getScriptProperties().getProperty(mfaSecretKey_(staffId)) || '';
}

function storeMfaSecret_(staffId, secret) {
  PropertiesService.getScriptProperties().setProperty(mfaSecretKey_(staffId), secret);
}

function clearMfaSecret_(staffId) {
  PropertiesService.getScriptProperties().deleteProperty(mfaSecretKey_(staffId));
}

function mfaEnrollmentUri_(email, secret) {
  return 'otpauth://totp/' + encodeURIComponent(SENDER_NAME + ':' + email) +
    '?secret=' + secret +
    '&issuer=' + encodeURIComponent(SENDER_NAME) +
    '&algorithm=SHA1&digits=' + TOTP_DIGITS + '&period=' + TOTP_PERIOD_SECONDS;
}

// ── The challenge between password and second factor ────────────────────────

/**
 * The credential issued after a correct password and before a second factor.
 *
 * The one thing that must not happen is a challenge being accepted where a
 * session token is. In the Postgres build that separation is a distinct JWT
 * audience; here it is stronger by construction — a challenge lives only in
 * CacheService under its own key prefix and is never written to `Sessions`, so
 * `requireSession()` cannot resolve one no matter what is passed to it.
 *
 * It carries no role and authorises nothing except the attempt to present a
 * second factor.
 */
function mfaChallengeKey_(token) {
  return 'staff_mfa_' + hmac(String(token || '')).slice(0, 40);
}

function issueMfaChallenge_(staffId, stage) {
  var token = randomToken();
  CacheService.getScriptCache().put(mfaChallengeKey_(token), JSON.stringify({
    staffId: staffId, stage: stage, expiresAt: Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000
  }), MFA_CHALLENGE_TTL_SECONDS);
  return token;
}

/** Re-checks the account on every read: a suspension mid-challenge must bite. */
function readMfaChallenge_(token, stage) {
  token = String(token || '').trim();
  if (!token || token.length > 200) return null;
  var raw = CacheService.getScriptCache().get(mfaChallengeKey_(token));
  if (!raw) return null;
  try {
    var challenge = JSON.parse(raw);
    if (Number(challenge.expiresAt) < Date.now()) return null;
    if (challenge.stage !== stage) return null;
    var staff = findOne('Staff', function (r) { return r.id === challenge.staffId; });
    if (!staff || staff.status !== 'active' ||
        String(staff.role).toLowerCase() !== 'administrator') return null;
    return { staffId: challenge.staffId, stage: challenge.stage, staff: staff, token: token };
  } catch (err) {
    return null;
  }
}

function consumeMfaChallenge_(token) {
  CacheService.getScriptCache().remove(mfaChallengeKey_(token));
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/**
 * An administrator locked out at 2am needs a route in that is not "telephone
 * the developer" — especially here, where the programme may have exactly one.
 */
function generateRecoveryCode_() {
  var out = '';
  while (out.length < RECOVERY_CODE_LENGTH) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + out, Utilities.Charset.UTF_8);
    for (var i = 0; i < digest.length && out.length < RECOVERY_CODE_LENGTH; i++) {
      var b = digest[i] & 0xff;
      // 248 = 31 * 8, the largest multiple of the alphabet below 256. Rejecting
      // above it keeps every character equally likely rather than biasing the
      // first seven, which plain modulo would.
      if (b < 248) out += RECOVERY_ALPHABET.charAt(b % RECOVERY_ALPHABET.length);
    }
  }
  return out;
}

/** Typed from a printout, so case and separators are forgiven. */
function normaliseRecoveryCode_(code) {
  return String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function issueRecoveryCodes_(staffId) {
  var sh = sheet('MfaRecoveryCodes');
  // Replace any codes left by an earlier, abandoned enrollment — the secret
  // they were issued alongside is no longer the one in force.
  var existing = rows('MfaRecoveryCodes');
  for (var i = existing.length - 1; i >= 0; i--) {
    if (existing[i].staffId === staffId) sh.deleteRow(existing[i].__row);
  }
  var codes = [];
  for (var n = 0; n < RECOVERY_CODE_COUNT; n++) {
    var code = generateRecoveryCode_();
    codes.push(code);
    append('MfaRecoveryCodes', {
      id: Utilities.getUuid(), staffId: staffId, codeHash: hmac(code),
      usedAt: '', createdAt: nowIso()
    });
  }
  return codes;
}

function redeemRecoveryCode_(staffId, supplied) {
  var normalised = normaliseRecoveryCode_(supplied);
  if (normalised.length !== RECOVERY_CODE_LENGTH) return false;
  var wanted = hmac(normalised);
  var hit = null;
  rows('MfaRecoveryCodes').forEach(function (r) {
    if (hit || r.staffId !== staffId || r.usedAt) return;
    if (safeEqual(String(r.codeHash), wanted)) hit = r;
  });
  if (!hit) return false;
  updateWhere('MfaRecoveryCodes', function (r) { return r.id === hit.id; }, { usedAt: nowIso() });
  audit('staff', staffId, 'auth.mfa.recovery_code_used', 'staff', staffId, '');
  return true;
}

function remainingRecoveryCodes_(staffId) {
  return rows('MfaRecoveryCodes').filter(function (r) {
    return r.staffId === staffId && !r.usedAt;
  }).length;
}

// ── The three pre-session MFA actions ───────────────────────────────────────

function staffBeginMfaEnrollment(data) {
  var challenge = readMfaChallenge_(data.challenge, 'enroll');
  if (!challenge) return { success: false, error: 'That sign-in attempt expired. Start again.' };
  if (!rateLimit('mfa_enroll_' + challenge.staffId, 15, 900))
    return { success: false, error: 'Too many attempts. Try again later.' };

  // Reuse a secret already generated for this account's unfinished enrollment,
  // so reloading the page does not invalidate a QR that was already scanned.
  var secret = storedMfaSecret_(challenge.staffId);
  if (!secret) {
    secret = generateMfaSecret_();
    storeMfaSecret_(challenge.staffId, secret);
  }
  return {
    success: true,
    secret: secret,
    uri: mfaEnrollmentUri_(challenge.staff.email, secret)
  };
}

function staffConfirmMfaEnrollment(data) {
  var challenge = readMfaChallenge_(data.challenge, 'enroll');
  if (!challenge) return { success: false, error: 'That sign-in attempt expired. Start again.' };
  if (!rateLimit('mfa_confirm_' + challenge.staffId, 15, 900))
    return { success: false, error: 'Too many attempts. Try again later.' };

  var secret = storedMfaSecret_(challenge.staffId);
  if (!secret) return { success: false, error: 'Start the setup again.' };

  var result = verifyTotp_(secret, data.code, null);
  if (!result.valid) {
    audit('staff', challenge.staffId, 'auth.mfa.failure', 'staff', challenge.staffId, 'enroll');
    return { success: false, error: 'That code is not valid. Check the app and try again.' };
  }

  return withLock(function () {
    var codes = issueRecoveryCodes_(challenge.staffId);
    updateWhere('Staff', function (r) { return r.id === challenge.staffId; },
                { mfaEnrolledAt: nowIso(), mfaLastUsedEpoch: result.epoch });
    consumeMfaChallenge_(challenge.token);
    audit('staff', challenge.staffId, 'auth.mfa.enrolled', 'staff', challenge.staffId, '');
    audit('staff', challenge.staffId, 'staff.signed.in', 'staff', challenge.staffId, 'enrollment');
    return {
      success: true,
      token: issueSession('staff', challenge.staffId, 1, STAFF_SESSION_TTL_HRS / 24),
      recoveryCodes: codes,
      staff: { id: challenge.staff.id, fullName: challenge.staff.fullName, role: challenge.staff.role }
    };
  });
}

function staffVerifyMfa(data) {
  var challenge = readMfaChallenge_(data.challenge, 'verify');
  if (!challenge) return { success: false, error: 'That sign-in attempt expired. Start again.' };
  var fail = { success: false, error: 'That code is not valid.' };
  // Tighter than the password limit above: a six-digit code has a search space
  // a password does not, so the rate limit is the substantive defence here.
  if (!rateLimit('mfa_verify_' + challenge.staffId, 10, 900)) return fail;

  var supplied = String(data.code || '').trim();
  if (!supplied) return fail;

  return withLock(function () {
    // Re-read inside the lock: two codes presented at once must not both pass
    // the replay check against the same stale mfaLastUsedEpoch.
    var staff = findOne('Staff', function (r) { return r.id === challenge.staffId; });
    if (!staff) return fail;
    var secret = storedMfaSecret_(challenge.staffId);
    if (!secret) return fail;

    var raw = staff.mfaLastUsedEpoch;
    var last = (raw === '' || raw === null || raw === undefined) ? null : Number(raw);
    var result = verifyTotp_(secret, supplied, last);
    var usedRecovery = false;

    if (result.valid) {
      updateWhere('Staff', function (r) { return r.id === challenge.staffId; },
                  { mfaLastUsedEpoch: result.epoch });
    } else {
      if (!redeemRecoveryCode_(challenge.staffId, supplied)) {
        audit('staff', challenge.staffId, 'auth.mfa.failure', 'staff', challenge.staffId, 'verify');
        return fail;
      }
      usedRecovery = true;
    }

    consumeMfaChallenge_(challenge.token);
    audit('staff', challenge.staffId, 'staff.signed.in', 'staff', challenge.staffId,
          usedRecovery ? 'recovery-code' : 'totp');
    return {
      success: true,
      token: issueSession('staff', challenge.staffId, 1, STAFF_SESSION_TTL_HRS / 24),
      usedRecoveryCode: usedRecovery,
      recoveryCodesRemaining: usedRecovery ? remainingRecoveryCodes_(challenge.staffId) : null,
      staff: { id: staff.id, fullName: staff.fullName, role: staff.role }
    };
  });
}

// ─── Staff authentication ───────────────────────────────────────────────────

function staffLogin(data) {
  var email = String(data.email || '').trim().toLowerCase();
  var pass  = String(data.password || '');
  var fail  = { success: false, error: 'Invalid email or password.' };
  if (!email || !pass) return fail;
  if (!rateLimit('staff_' + email, 10, 900)) return fail;

  var u = findOne('Staff', function (r) { return String(r.email).toLowerCase() === email; });
  var validAccount = u && u.status === 'active' && String(u.role).toLowerCase() === 'administrator';
  if (!validAccount || !safeEqual(String(u.passHash), hmac(pass + ':' + u.salt))) {
    // §9 parity with the Postgres build: every failed sign-in leaves a trace.
    // Never the email or password attempted — only the account id, and only
    // when the email actually matched one, so a guess against a non-existent
    // address does not itself get written into the audit trail.
    audit('staff', u ? u.id : '', 'auth.login.failure', 'staff', u ? u.id : '', '');
    return fail;
  }

  // A correct password is now half a sign-in. No session token is issued on
  // this path under any circumstance — the only thing returned is a challenge.
  //
  // An account marked enrolled whose secret has gone missing (Script Properties
  // cleared, say) falls back to enrollment rather than to no second factor at
  // all. That self-heals without opening a bypass: it still costs the password,
  // and it still ends in a working authenticator.
  var enrolled = !!u.mfaEnrolledAt && !!storedMfaSecret_(u.id);
  var stage = enrolled ? 'verify' : 'enroll';
  audit('staff', u.id, 'auth.password.accepted', 'staff', u.id, stage);
  return { success: true, mfa: stage, challenge: issueMfaChallenge_(u.id, stage) };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

/**
 * The admin landing screen. Distinct from getReports() below: this answers
 * "what needs attention, and is the programme working" at a glance, not the
 * full breakdown tables. Three things product-definition.md §7/§11 calls out
 * specifically motivate the shape here — none of them existed before:
 *   - estimated discount value given, "the only way to answer whether the
 *     programme is worth its cost"
 *   - a three-way membership funnel (unclaimed / claimed-but-dormant /
 *     active) instead of one dormant bucket, since each gap is a different
 *     problem to fix
 *   - invitations approaching their expiry, so staff can resend before the
 *     code lapses rather than after
 */
function getOverview(data) {
  var s = requireStaff(data);
  expireStaleRequests();

  var benefits = {}, members = {}, outlets = {};
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });
  rows('Members').forEach(function (m) { members[m.id] = m; });
  rows('Outlets').forEach(function (o) { outlets[o.id] = o; });

  // String arithmetic on the same UTC ISO shape nowIso() already writes to
  // recordedAt, so "this month" here means exactly what byMonth grouping
  // elsewhere in the file means — no local-timezone Date reconstruction to
  // get subtly wrong at a month boundary.
  var nowKey = nowIso();
  var thisMonthKey = nowKey.slice(0, 7);
  var y = Number(nowKey.slice(0, 4)), mo = Number(nowKey.slice(5, 7));
  var lastMonthKey = (mo === 1 ? (y - 1) : y) + '-' + String(mo === 1 ? 12 : mo - 1).padStart(2, '0');

  var byBenefitThisMonth = {}, memberSeen = {};
  var redemptionsThisMonth = 0, redemptionsLastMonth = 0, savedMinorThisMonth = 0;
  rows('Redemptions').filter(function (r) { return !r.reversesId; }).forEach(function (r) {
    if (r.memberId) memberSeen[r.memberId] = true;
    var month = String(r.recordedAt).slice(0, 7);
    if (month === thisMonthKey) {
      redemptionsThisMonth += 1;
      var minor = finiteNumberOrNull(r.savedMinor);
      if (minor !== null) savedMinorThisMonth += minor;
      var title = benefits[r.benefitId] ? benefits[r.benefitId].title : 'Unknown';
      if (!byBenefitThisMonth[title]) byBenefitThisMonth[title] = { count: 0, members: {} };
      byBenefitThisMonth[title].count += 1;
      if (r.memberId) byBenefitThisMonth[title].members[r.memberId] = true;
    } else if (month === lastMonthKey) {
      redemptionsLastMonth += 1;
    }
  });

  // R13 — ranked only among benefits with at least five distinct members this
  // month, so "least redeemed" can never point at a cohort of one.
  var ranked = Object.keys(byBenefitThisMonth)
    .map(function (title) {
      return { title: title, count: byBenefitThisMonth[title].count, distinct: Object.keys(byBenefitThisMonth[title].members).length };
    })
    .filter(function (row) { return row.distinct >= MIN_COHORT_SIZE; })
    .sort(function (a, b) { return b.count - a.count; });

  var totalMembers = 0, unclaimedMembers = 0, claimedDormantMembers = 0, activeMembers = 0;
  rows('Members').forEach(function (m) {
    totalMembers += 1;
    if (!m.claimedAt) { unclaimedMembers += 1; return; }
    if (memberSeen[m.id]) activeMembers += 1; else claimedDormantMembers += 1;
  });

  var expiringInvitations = rows('ClaimCodes')
    .filter(function (c) { return !c.usedAt && !expired(c.expiresAt); })
    .map(function (c) {
      var m = members[c.memberId];
      return m ? { memberId: m.id, fullName: m.fullName, memberNumber: m.memberNumber, expiresAt: isoString(c.expiresAt) } : null;
    })
    .filter(function (row) { return row; })
    .sort(function (a, b) { return String(a.expiresAt).localeCompare(String(b.expiresAt)); })
    .slice(0, 8);

  var recentActivity = rows('Redemptions')
    .filter(function (r) { return !r.reversesId; })
    .sort(function (a, b) { return String(b.recordedAt).localeCompare(String(a.recordedAt)); })
    .slice(0, 6)
    .map(function (r) {
      var m = members[r.memberId], b = benefits[r.benefitId], o = outlets[r.outletId];
      return {
        recordedAt: isoString(r.recordedAt),
        member: m ? m.fullName : '', memberNumber: m ? m.memberNumber : '',
        benefit: b ? b.title : '', outlet: o ? o.name : ''
      };
    });

  audit('staff', s.id, 'report.viewed', 'report', '', 'overview');
  return {
    success: true,
    totalMembers: totalMembers,
    unclaimedMembers: unclaimedMembers,
    claimedDormantMembers: claimedDormantMembers,
    activeMembers: activeMembers,
    redemptionsThisMonth: redemptionsThisMonth,
    redemptionsLastMonth: redemptionsLastMonth,
    savedMinorThisMonth: savedMinorThisMonth,
    mostRedeemedBenefit: ranked.length ? ranked[0].title : null,
    leastRedeemedBenefit: ranked.length ? ranked[ranked.length - 1].title : null,
    expiringInvitations: expiringInvitations,
    recentActivity: recentActivity,
    minCohort: MIN_COHORT_SIZE
  };
}

/**
 * R13 — a cohort smaller than five is suppressed rather than reported, so a
 * figure cannot be traced back to one identifiable member.
 */
function getReports(data) {
  var s = requireStaff(data);
  var benefits = {};
  rows('Benefits').forEach(function (b) { benefits[b.id] = b; });

  var byBenefit = {}, byMonth = {}, memberSeen = {};
  function addGroup(groups, key, memberId) {
    if (!groups[key]) groups[key] = { count: 0, members: {} };
    groups[key].count += 1;
    if (memberId) groups[key].members[memberId] = true;
  }
  // Match the PostgreSQL report: reversal rows are audit evidence, not another
  // redemption. Originals remain part of historical usage reporting.
  rows('Redemptions').filter(function (r) { return !r.reversesId; }).forEach(function (r) {
    var title = benefits[r.benefitId] ? benefits[r.benefitId].title : 'Unknown';
    var month = String(r.recordedAt).slice(0, 7);
    addGroup(byBenefit, title, r.memberId);
    if (/^\d{4}-\d{2}$/.test(month)) addGroup(byMonth, month, r.memberId);
    if (r.memberId) memberSeen[r.memberId] = true;
  });

  var totalMembers = rows('Members').length;
  var suppress = function (groups) {
    var out = {};
    Object.keys(groups).forEach(function (k) {
      var group = groups[k];
      // Five visits by one person are still a cohort of one. Suppression is
      // therefore based on distinct members, never the raw row count.
      out[k] = Object.keys(group.members).length < MIN_COHORT_SIZE ? null : group.count;
    });
    return out;
  };

  audit('staff', s.id, 'report.viewed', 'report', '', 'analytics');
  return {
    success: true,
    totalMembers: totalMembers,
    activeMembers: Object.keys(memberSeen).length,
    dormantMembers: totalMembers - Object.keys(memberSeen).length,
    byBenefit: suppress(byBenefit),
    byMonth: suppress(byMonth),
    minCohort: MIN_COHORT_SIZE
  };
}

// ─── Email ──────────────────────────────────────────────────────────────────

function htmlEscape(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(title, bodyHtml) {
  return '<div style="background:#edeae4;padding:24px 0;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2ddd3">' +
      '<div style="background:#221c1b;padding:26px 30px;text-align:center">' +
        '<div style="color:#ecd7a3;font-size:10px;letter-spacing:.18em;font-weight:700">PRIVILEGE GUEST</div>' +
        '<div style="color:#f5f1ea;font-size:20px;letter-spacing:.04em;margin-top:6px">' + htmlEscape(title) + '</div>' +
      '</div>' +
      '<div style="padding:28px 30px;color:#3a3230;font-size:14px;line-height:1.7">' + bodyHtml + '</div>' +
      '<div style="border-top:1px solid #efeae1;padding:16px 30px;text-align:center;color:#a9a29a;font-size:11px">' +
        htmlEscape(HOTEL_NAME) + '</div>' +
    '</div></div>';
}

function send(to, subject, plain, html) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: plain, htmlBody: html, name: SENDER_NAME });
    return true;
  } catch (err) {
    console.warn('mail failed: ' + err.message);
    return false;
  }
}

function sendPasscodeEmail(to, name, code) {
  return send(to, HOTEL_NAME + ' — your sign-in code',
    'Your Privilege Guest sign-in code is ' + code + '. It expires in 5 minutes.',
    shell('Your sign-in code',
      '<p>Dear ' + htmlEscape(name) + ',</p><p>Use this code to sign in:</p>' +
      '<div style="font-size:32px;letter-spacing:12px;text-align:center;background:#f6f3ee;' +
      'padding:16px;color:#221c1b;font-weight:700;margin:18px 0">' + htmlEscape(code) + '</div>' +
      '<p>It expires in 5 minutes. If you did not ask for it, you can ignore this message.</p>'));
}

function sendInvitationEmail(to, name, memberNumber, code) {
  return send(to, HOTEL_NAME + ' — your Privilege Guest membership',
    'Your membership number is ' + memberNumber + '. Activation code: ' + code,
    shell('Welcome',
      '<p>Dear ' + htmlEscape(name) + ',</p><p>Your Privilege Guest membership is ready.</p>' +
      '<p><strong>Membership number:</strong> ' + htmlEscape(memberNumber) + '</p>' +
      '<p>Enter this activation code in the app to get started:</p>' +
      '<div style="font-size:20px;letter-spacing:4px;text-align:center;background:#f6f3ee;' +
      'padding:14px;color:#221c1b;font-weight:700;margin:16px 0">' + htmlEscape(code) + '</div>' +
      '<p style="color:#8a827a;font-size:12px">This code can be used once and expires in ' +
      CLAIM_CODE_TTL_DAYS + ' days.</p>'));
}

function sendOutletTokenEmail(to, outletName, token) {
  return send(to, HOTEL_NAME + ' — outlet sign-in token',
    'Your sign-in token for ' + outletName + ' is: ' + token,
    shell('Outlet sign-in token',
      '<p>A sign-in token for <strong>' + htmlEscape(outletName) + '</strong> was issued for this address.</p>' +
      '<p>Enter this on the counter device:</p>' +
      '<div style="font-size:18px;letter-spacing:2px;text-align:center;background:#f6f3ee;' +
      'padding:14px;color:#221c1b;font-weight:700;margin:16px 0;word-break:break-all">' + htmlEscape(token) + '</div>' +
      '<p style="color:#8a827a;font-size:12px">This grants access to this outlet’s counter screen — do not forward it. ' +
      'If you did not request this, an administrator can revoke it from the Outlets panel.</p>'));
}

function sendRequestSubmittedEmail(to, name, benefit, outlet, note) {
  var destination = outlet ? ' at ' + outlet.name : '';
  var notePlain = note ? '\nYour note: ' + note : '';
  var noteHtml = note ? '<p><strong>Your note:</strong><br>' +
    htmlEscape(note).replace(/\r?\n/g, '<br>') + '</p>' : '';
  return send(to, HOTEL_NAME + ' — we are expecting you',
    'Your request for ' + benefit.title + destination + ' has been noted.' + notePlain,
    shell('We are expecting you',
      '<p>Dear ' + htmlEscape(name) + ',</p><p>We have let the team know you are coming for <strong>' +
      htmlEscape(benefit.title) + '</strong>' + (outlet ? ' at <strong>' + htmlEscape(outlet.name) + '</strong>' : '') + '.</p>' +
      noteHtml + (benefit.reservationPhone ? '<p>To reserve a time, call ' + htmlEscape(benefit.reservationPhone) + '.</p>' : '')));
}

function sendRequestNotUsedEmail(to, name, benefit, reason) {
  var reasonPlain = reason ? '\nNote from the outlet: ' + reason : '';
  var reasonHtml = reason ? '<p><strong>Note from the outlet:</strong> ' + htmlEscape(reason) + '</p>' : '';
  return send(to, HOTEL_NAME + ' — your visit notice was closed',
    'Your ' + benefit.title + ' visit notice was closed as not used.' + reasonPlain,
    shell('Your notice was closed',
      '<p>Dear ' + htmlEscape(name) + ',</p><p>Your visit notice for <strong>' + htmlEscape(benefit.title) +
      '</strong> was closed because the outlet did not record a visit. Your benefit is unaffected — send another ' +
      'notice whenever you are on your way.</p>' + reasonHtml));
}

function sendRedemptionRecordedEmail(to, name, benefit, savedMinor) {
  var savedLine = (savedMinor === null || savedMinor === undefined) ? '' :
    '<p>You saved <strong>QAR ' + (savedMinor / 100).toFixed(2) + '</strong> on this visit.</p>';
  return send(to, HOTEL_NAME + ' — thank you for your visit',
    'Your ' + benefit.title + ' benefit has been recorded.',
    shell('Thank you for your visit',
      '<p>Dear ' + htmlEscape(name) + ',</p><p>Your <strong>' + htmlEscape(benefit.title) +
      '</strong> benefit has been recorded.</p>' + savedLine));
}

function notifyOutlet(benefit, member, selectedOutlet, note) {
  var o = selectedOutlet || findOne('Outlets', function (r) {
    return String(r.category) === String(benefit.category) &&
           String(r.active).toLowerCase() !== 'false';
  });
  if (!o || !o.notifyEmail) return false;
  var notePlain = note ? '\nMember note: ' + note : '';
  var noteHtml = note ? '<p><strong>Member note:</strong><br>' +
    htmlEscape(note).replace(/\r?\n/g, '<br>') + '</p>' : '';
  return send(o.notifyEmail, 'Privilege Guest expected — ' + benefit.title,
    (member ? member.fullName + ' (' + member.memberNumber + ')' : 'A member') +
    ' has requested ' + benefit.title + '.' + notePlain,
    shell('A Privilege Guest is expected',
      '<p><strong>' + htmlEscape(member ? member.fullName : 'A member') + '</strong>' +
      (member ? ' · ' + htmlEscape(member.memberNumber) : '') + '</p>' +
      '<p>Benefit: ' + htmlEscape(benefit.title) + '</p>' + noteHtml +
      '<p style="color:#8a827a;font-size:12px">Apply the discount as usual, then record it in the panel.</p>'));
}

// ─── SMS (optional) ─────────────────────────────────────────────────────────
//
// Apps Script has no built-in SMS API, so this posts to a configurable HTTP
// gateway — the shape most GCC bulk providers expose, and the same design as
// `sms-transport.ts` in the Postgres build. Nothing here is wired to a
// specific provider: `buildSmsPayload_` is the one place to reconcile field
// names against whichever account's own API document once one exists.
//
// Set these once, from the editor (never hard-code a credential into this
// file): PropertiesService.getScriptProperties().setProperty('SMS_GATEWAY_URL', ...)
// and the same for SMS_API_USER, SMS_API_PASSWORD, SMS_SENDER_ID.
//
// Unconfigured is a supported, silent state, exactly like a `send()` mail
// failure: every call site below sends SMS *in addition to* the email it
// already sends, so a deployment that has not set these up keeps working on
// email alone rather than throwing on every passcode request or visit notice.
// Every member has a phone number (`validMemberPhone` requires one at
// creation), so unlike email there is no "no address" case to branch on.

function smsConfigured_() {
  var props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('SMS_GATEWAY_URL') && props.getProperty('SMS_API_USER') &&
            props.getProperty('SMS_API_PASSWORD') && props.getProperty('SMS_SENDER_ID'));
}

function buildSmsPayload_(to, body) {
  var props = PropertiesService.getScriptProperties();
  return {
    username: props.getProperty('SMS_API_USER'),
    password: props.getProperty('SMS_API_PASSWORD'),
    sender: props.getProperty('SMS_SENDER_ID'),
    // E.164 with the leading '+' stripped — most gateways in the region
    // reject the plus sign rather than normalising it.
    to: String(to || '').replace(/^\+/, ''),
    text: body
  };
}

/**
 * Best-effort by construction: a failure here must never break the write it
 * is reporting on (a passcode was issued, a visit was recorded either way),
 * so every path returns `false` rather than throwing. Callers do not branch
 * on the result — the email already sent (or attempted) is the record of
 * delivery this version relies on; this is a bonus channel on top of it.
 */
function sendSms_(to, body) {
  if (!smsConfigured_()) return false;
  try {
    var response = UrlFetchApp.fetch(PropertiesService.getScriptProperties().getProperty('SMS_GATEWAY_URL'), {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: buildSmsPayload_(to, body),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      console.warn('SMS gateway returned ' + code);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('SMS send failed: ' + err.message);
    return false;
  }
}

/**
 * Cuts administrator-authored text down before it reaches a template.
 *
 * A benefit title or outlet name has no length bound that keeps a message
 * inside a single 160-character GSM-7 segment the way the fixed passcode and
 * invitation bodies do below — `Benefits.title` is free text. Rather than let
 * one long title silently double the bill, every rendering is bounded here.
 * The ellipsis is three ASCII periods, not the Unicode "…" character: that
 * single character falls outside the GSM-7 alphabet and would force the
 * *whole message* to UCS-2 encoding, cutting the segment budget from 160
 * characters to 70 — the same invisible-cost failure this function exists to
 * avoid.
 */
function truncateSms_(text, max) {
  text = String(text === null || text === undefined ? '' : text);
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function sendPasscodeSms_(phone, code) {
  return sendSms_(phone, 'Privilege Guest: use code ' + code + ' to sign in. Expires in ' +
    Math.max(1, Math.round(OTP_TTL_SECONDS / 60)) + ' min. Never share it.');
}

function sendInvitationSms_(phone, code) {
  return sendSms_(phone, 'Privilege Guest: activation code ' + code + '. Valid ' +
    CLAIM_CODE_TTL_DAYS + ' days. Open the app to begin.');
}

function sendRequestSubmittedSms_(phone, benefit, outlet) {
  var outletName = outlet && outlet.name ? truncateSms_(outlet.name, SMS_OUTLET_CHARS) : 'The outlet';
  return sendSms_(phone, 'Privilege Guest: ' + outletName + ' has been told you are coming for ' +
    truncateSms_(benefit.title, SMS_TITLE_CHARS) + '. Just show your card.');
}

function sendRequestNotUsedSms_(phone, benefit) {
  return sendSms_(phone, 'Privilege Guest: ' + truncateSms_(benefit.title, SMS_TITLE_CHARS) +
    ' was not used, nothing recorded. Your benefit is still available.');
}

function sendRedemptionRecordedSms_(phone, benefit, savedMinor) {
  var saved = (savedMinor === null || savedMinor === undefined || savedMinor === '') ? '' :
    ', saved QAR ' + (Number(savedMinor) / 100).toFixed(2);
  return sendSms_(phone, 'Privilege Guest: ' + truncateSms_(benefit.title, SMS_TITLE_CHARS) +
    ' recorded' + saved + '.');
}

// ─── First-run setup ────────────────────────────────────────────────────────

/**
 * Run once from the editor. Creates every sheet, seeds the five benefit
 * categories from the programme's benefits sheet, and creates one
 * administrator. The password is printed to the log and never stored anywhere
 * else — change it on first sign-in.
 */
function canonicalBenefitSeeds() {
  return [
    {
      slug: 'fnb', title: 'F&B Outlets', category: 'Dining', discount: '25%',
      secondaryLabel: '', secondaryPct: '', childRules: { '6-12': 50, '0-6': 100 },
      maxParty: 6, minGuests: '', reservationPhone: '4020 1720', sortOrder: 1,
      outletKind: 'DINING', heroImage: 'benefit-fnb.jpg',
      terms: 'Maximum 6 people per cardholder. 50% discount for children aged 6–12; children under 6 dine free. Benefits are subject to change; you will be notified of significant changes.',
      legacyTitle: 'Dining', legacyCategory: 'F&B Outlets',
      legacyTerms: '25% discount · 50% for children 6–12 · free for children 0–6. Maximum 6 people per cardholder.'
    },
    {
      slug: 'rooms', title: 'Rooms & Suites', category: 'Rooms', discount: '30%',
      secondaryLabel: '', secondaryPct: '', childRules: null,
      maxParty: '', minGuests: '', reservationPhone: '4020 1666', sortOrder: 2,
      outletKind: 'ROOMS', heroImage: 'benefit-rooms.avif',
      terms: 'Off published bar rates at the Hotel & Residence. Subject to availability. Benefits are subject to change; you will be notified of significant changes.',
      legacyTitle: 'Rooms & Suites', legacyCategory: 'Rooms & Suites',
      legacyTerms: '30% off published bar rates, Hotel & Residence. Subject to availability.'
    },
    {
      slug: 'spa', title: 'Spa', category: 'Spa', discount: '40%',
      secondaryLabel: 'Retail products', secondaryPct: '25.00', childRules: null,
      maxParty: 2, minGuests: '', reservationPhone: '4020 1625', sortOrder: 3,
      outletKind: 'SPA', heroImage: 'benefit-spa.jpg',
      terms: 'Maximum 2 people per cardholder. Applies to all treatments booked directly with the spa. Subject to availability. Benefits are subject to change; you will be notified of significant changes.',
      legacyTitle: 'Spa', legacyCategory: 'Spa',
      legacyTerms: '40% off all treatments · 25% off retail products. Maximum 2 people.'
    },
    {
      slug: 'events', title: 'Meetings & Events', category: 'Events', discount: '25%',
      secondaryLabel: 'Outside catering', secondaryPct: '20.00', childRules: null,
      maxParty: '', minGuests: 20, reservationPhone: '', sortOrder: 4,
      outletKind: 'EVENTS', heroImage: 'benefit-events.jpg',
      terms: 'Minimum 20 people. 20% discount applies to outside catering. Benefits are subject to change; you will be notified of significant changes.',
      legacyTitle: 'Meetings & Events', legacyCategory: 'Meetings & Events',
      legacyTerms: '25% off events · 20% off outside catering. Events minimum 20 people.'
    },
    {
      slug: 'lifestyle', title: 'Lifestyle & SPG Memberships', category: 'Lifestyle', discount: '30%',
      secondaryLabel: 'Pool day pass', secondaryPct: '25.00', childRules: null,
      maxParty: '', minGuests: '', reservationPhone: '', sortOrder: 5,
      outletKind: 'OTHER', heroImage: '',
      terms: 'Complimentary valet parking and wifi included. Benefits are subject to change; you will be notified of significant changes.',
      legacyTitle: 'Lifestyle & Memberships', legacyCategory: 'Lifestyle',
      legacyTerms: '30% off memberships · 25% off pool day pass · free valet parking · free wifi.'
    }
  ];
}

/**
 * Automatic, non-destructive benefit migration for workbooks created by the
 * earlier Apps Script build. New columns are filled by slug. Existing editable
 * copy changes only when it still exactly equals this file's former seed.
 */
function upgradeBenefitSheet(sh, headers, addedFields) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var index = {};
  headers.forEach(function (field, i) { if (field) index[field] = i; });
  if (index.slug === undefined) return;

  var seeds = {};
  canonicalBenefitSeeds().forEach(function (seed) { seeds[seed.slug] = seed; });
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var changed = false;

  values.forEach(function (row) {
    var seed = seeds[String(row[index.slug] || '')];
    if (!seed) return;
    function fillBlank(field, value) {
      if (addedFields.indexOf(field) === -1) return;
      if (index[field] === undefined || value === null || value === undefined || value === '') return;
      if (row[index[field]] === '' || row[index[field]] === null) {
        row[index[field]] = field === 'childRules' ? childRulesForSheet(value) : value;
        changed = true;
      }
    }
    fillBlank('secondaryLabel', seed.secondaryLabel);
    fillBlank('secondaryPct', seed.secondaryPct);
    fillBlank('childRules', seed.childRules);
    fillBlank('minGuests', seed.minGuests);
    fillBlank('sortOrder', seed.sortOrder);
    fillBlank('outletKind', seed.outletKind);

    [
      ['title', 'legacyTitle'],
      ['category', 'legacyCategory'],
      ['terms', 'legacyTerms']
    ].forEach(function (pair) {
      var field = pair[0], legacyField = pair[1];
      if (index[field] !== undefined && String(row[index[field]]) === String(seed[legacyField]) &&
          String(row[index[field]]) !== String(seed[field])) {
        row[index[field]] = seed[field];
        changed = true;
      }
    });
  });

  if (changed) {
    sh.getRange(2, 1, values.length, headers.length).setValues(values.map(function (row) {
      return row.map(literalSheetValue);
    }));
  }
}

function setup() {
  Object.keys(SHEETS).forEach(function (n) { sheet(n); });

  if (rows('Benefits').length === 0) {
    canonicalBenefitSeeds().forEach(function (b) {
      append('Benefits', {
        id: Utilities.getUuid(), slug: b.slug, category: b.category, title: b.title,
        discount: b.discount, terms: b.terms, maxParty: b.maxParty,
        reservationPhone: b.reservationPhone, heroImage: b.heroImage,
        secondaryLabel: b.secondaryLabel, secondaryPct: b.secondaryPct,
        childRules: childRulesForSheet(b.childRules), minGuests: b.minGuests,
        sortOrder: b.sortOrder, outletKind: b.outletKind,
        published: true, version: 1, updatedBy: 'setup', updatedAt: nowIso()
      });
    });
  }

  if (rows('Staff').length === 0) {
    var pass = randomToken().slice(0, 14);
    var salt = randomToken().slice(0, 16);
    append('Staff', {
      id: Utilities.getUuid(), email: 'admin@' + 'example.com', fullName: 'Administrator',
      role: 'administrator', status: 'active',
      passHash: hmac(pass + ':' + salt), salt: salt, createdAt: nowIso()
    });
    console.log('ADMINISTRATOR CREATED');
    console.log('  email    : admin@example.com   ← change this in the Staff sheet');
    console.log('  password : ' + pass);
    console.log('This password is not stored anywhere else. Copy it now.');
  }

  secret();      // force session/OTP signing secret creation on first run
  cardSecret();  // separate key for stable printed identity codes
  console.log('Setup complete. Deploy → New deployment → Web app, Execute as Me, Access Anyone.');
}

/**
 * Recovery path when nobody has the administrator password anymore. It is
 * printed once at creation time (see setup(), above) and never stored in the
 * clear, so there is no in-app "forgot password" flow — this is the
 * owner-only equivalent, run from the script editor's function dropdown.
 * Every staff row gets a freshly generated password; none of the old ones
 * work again afterwards.
 */
function resetStaffPasswords() {
  var count = 0;
  rows('Staff').forEach(function (r) {
    var pass = randomToken().slice(0, 14);
    var salt = randomToken().slice(0, 16);
    updateWhere('Staff', function (row) { return row.id === r.id; },
                { passHash: hmac(pass + ':' + salt), salt: salt });
    console.log(r.email + ' : ' + pass);
    count += 1;
  });
  console.log(count + ' password(s) reset. Not stored anywhere else — copy them now.');
  return count;
}

/**
 * The last resort when an administrator has lost both their authenticator and
 * their ten recovery codes. Clearing enrollment sends the account back through
 * setup on its next sign-in; it does not weaken the second factor, because
 * running this requires access to the script project itself, which is a
 * strictly higher bar than either factor it resets.
 *
 * Pass an email to reset one account, or omit it to reset every administrator
 * — the dropdown in the editor cannot pass arguments, so the no-argument form
 * is the one that works there.
 */
function resetStaffMfa(email) {
  var wanted = String(email || '').trim().toLowerCase();
  var count = 0;
  rows('Staff').forEach(function (r) {
    if (wanted && String(r.email).toLowerCase() !== wanted) return;
    clearMfaSecret_(r.id);
    updateWhere('Staff', function (row) { return row.id === r.id; },
                { mfaEnrolledAt: '', mfaLastUsedEpoch: '' });
    var sh = sheet('MfaRecoveryCodes');
    var existing = rows('MfaRecoveryCodes');
    for (var i = existing.length - 1; i >= 0; i--) {
      if (existing[i].staffId === r.id) sh.deleteRow(existing[i].__row);
    }
    audit('staff', r.id, 'auth.mfa.reset', 'staff', r.id, 'script-owner');
    console.log('MFA reset for ' + r.email + ' — they will set it up again at next sign-in.');
    count += 1;
  });
  if (!count) console.log('No matching administrator found.');
  return count;
}

return {
  doGet: doGet,
  doPost: doPost,
  apiCall: apiCall,
  setup: setup,
  repairPhoneNumbers: repairPhoneNumbers,
  resetStaffPasswords: resetStaffPasswords,
  resetStaffMfa: resetStaffMfa
};
})();

// The only browser-callable RPC. All authorization still happens inside it.
function apiCall(action, data, token) {
  return Server_.apiCall(action, data, token);
}

// Apps Script web-app entry points. They do not expose sheet operations.
function doGet(e) {
  return Server_.doGet(e);
}

function doPost(e) {
  return Server_.doPost(e);
}

// Editor-only maintenance entry points. A trailing underscore makes each one
// private to `google.script.run` while keeping it runnable by the script owner.
function setup_() {
  return Server_.setup();
}

function repairPhoneNumbers_() {
  return Server_.repairPhoneNumbers();
}

function resetStaffPasswords_() {
  return Server_.resetStaffPasswords();
}

/**
 * Clears staff MFA enrollment. No argument resets every administrator; pass an
 * email to reset one. Run from the editor after a lost phone *and* lost
 * recovery codes — see resetStaffMfa() for why that is safe.
 */
function resetStaffMfa_(email) {
  return Server_.resetStaffMfa(email);
}

// NOTE: a `TEMP_resetStaffPasswords` wrapper used to sit here so the editor's
// Run dropdown could reach the password reset. It was removed: a top-level
// function without a trailing underscore is callable by anyone who has the web
// app URL, so it let a stranger scramble the administrator password at will.
// If the dropdown will not run an underscored function, run it from the editor
// with `Server_.resetStaffPasswords()` in a scratch function you delete after,
// rather than leaving a permanently reachable one in the deployed source.
