# Privilege Guest Program — Apps Script version

A port of the member app onto Google Apps Script + Google Sheets, so it runs
with **no server and no hosting bill**.

**This folder is self-contained.** Nothing here touches the PostgreSQL build in
`apps/` — that remains the reference implementation.

---

## What is here

| File | What it is |
|---|---|
| `Code.gs` | The whole backend — auth, members, benefits, requests, redemptions, outlets, reports, email, SMS |
| `Member.html` | The member app — 7 screens |
| `Admin.html` | The administrator panel — 7 sections |
| `Outlet.html` | The counter screen — device sign-in, queue, look-up, history |
| `README.md` | This file |

All three surfaces are served from one deployment, chosen by a query parameter:

```
<web-app-url>                 → member app
<web-app-url>?page=admin      → administrator panel
<web-app-url>?page=outlet     → outlet screen
```

**Only the member URL is meant to be public.** The other two are protected by
sign-in, not by secrecy — but there is also no reason to circulate them.

---

## Deploying it

### 1. Create the project

1. Make a new Google Sheet — this is the database
2. **Extensions → Apps Script**
3. Delete the placeholder `Code.gs`, paste in this one
4. **File → New → HTML** three times, named exactly `Member`, `Admin` and
   `Outlet`, pasting in the matching file each time

The names matter — `doGet` looks them up by name.

### 2. Run setup once

In the editor, select `setup_` from the function dropdown and press Run. The
trailing underscore is intentional: Apps Script keeps that owner-run function
private from `google.script.run` in the browser.

It creates every sheet with the right headers, seeds the five benefit
categories from the programme's printed benefits sheet, and creates one
administrator.

**Check the execution log.** The administrator password is printed there and
stored nowhere else. Copy it before you close the window, then change the email
address in the `Staff` sheet from `admin@example.com` to a real one.

### 3. Artwork

`Member.html` ships with the contents of `apps/web-member/public/images/` and
`apps/web-member/public/assets/` bundled directly into the page as base64 data
URIs (`BUNDLED_ASSETS`), so images render out of the box with no extra setup.
This makes `Member.html` a few megabytes — expected, since Apps Script cannot
serve separate static files.

If you'd rather not pay that page-weight cost, you can still host
`apps/web-member/public/` yourself (GitHub Pages works well) and set:

```javascript
var ASSET_BASE = 'https://<your-user>.github.io/pgp-assets';
```

`ASSET_BASE`, when set, takes priority over the bundled copies. If artwork
changes, regenerate `BUNDLED_ASSETS` from the source files (or switch to
`ASSET_BASE`) — the bundled data URIs do not update themselves.

The supplied `Member.html` creates membership QR codes locally with a vendored
copy of `qrcode-generator` 2.0.4 (MIT). Card data and session tokens are never
sent to an image or QR service.

### 4. SMS (optional)

Without this step the app runs on email alone, exactly as before — nothing
below is required. Configure it to also text the invitation code, the sign-in
passcode, and the three visit notices ("we're expecting you", "not used",
"benefit recorded") to the member's own phone, alongside the email that
already sends for each. There is no "no phone" fallback case to worry about:
`validMemberPhone` already requires one for every member.

Apps Script has no built-in SMS API, so `sendSms_` in `Code.gs` posts to an
HTTP gateway you provide the credentials for — the shape most GCC bulk SMS
providers expose. From the Apps Script editor, run this once (or use
**Project Settings → Script Properties** in the UI) with your provider's own
values:

```javascript
function setSmsCredentials_() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SMS_GATEWAY_URL', 'https://<your-provider-endpoint>');
  props.setProperty('SMS_API_USER', '<username>');
  props.setProperty('SMS_API_PASSWORD', '<password>');
  props.setProperty('SMS_SENDER_ID', '<registered sender name>');
}
```

Run `setSmsCredentials_`, then delete or blank out the values in the function
body — Script Properties are stored separately from this file's source, so
they survive that edit. `SMS_SENDER_ID` is usually a brand name the carrier
must pre-register; expect lead time before it works, the same as the
PostgreSQL build's `SMS_SENDER_ID`.

**No provider is named here** — `buildSmsPayload_` is the one place in
`Code.gs` to reconcile field names against whichever account's own API
document once one exists, in case it doesn't match the `username` /
`password` / `sender` / `to` / `text` shape assumed there.

### 5. Deploy

After saving `ASSET_BASE` (and, optionally, the SMS Script Properties), choose
**Deploy → New deployment → Web app**.

| Setting | Value |
|---|---|
| Execute as | **Me** |
| Who has access | **Anyone** |

"Anyone" is safe here — see *Security* below. It is not safe by default, and it
is worth understanding why before you deploy.

**Both settings are load-bearing, and "Anyone" is not optional.**

- **Execute as: Me** is what keeps the Sheet private. The script reaches the
  spreadsheet as *you*, so members and counter tablets never need — and never
  get — any Drive access to it. Share the Sheet itself with nobody but the one
  or two people who should read raw data.
- **Who has access: Anyone** means only "anyone may load the page", not "anyone
  may see data". Every surface behind it is gated by this app's own
  authentication: an administrator password plus a second factor, a per-device
  outlet token, or a member passcode. All three surfaces are served from one
  URL by `?page=`, so this setting cannot be narrowed per page.

> **If members get "The requested URL was not found on this server", this
> setting is why.** When access is *Anyone within \<domain\>* or *Only myself*,
> Apps Script returns a bare 404 to everyone else rather than a permission
> prompt — deliberately, so an unauthorised visitor cannot confirm the script
> exists. It looks like a broken link and is actually a locked door. The
> standalone outlet page is affected too: it reaches `doPost` by cross-origin
> `fetch`, which carries no Google credentials at all.

**When updating an existing web app, edit the current deployment
(Deploy → Manage deployments → pencil icon → Deploy) rather than creating a new
one.** A new deployment gets a *new URL*, which silently breaks the `EXEC_URL`
constant baked into `outlet-standalone/index.html`.

### 6. First run, in order

1. Open `<web-app-url>?page=admin` and sign in with the credentials from step 2.
   **The first sign-in sets up two-factor authentication:** scan the QR with any
   authenticator app (Google Authenticator, 1Password, Authy…), enter the
   six-digit code, then **save the ten recovery codes it shows — they are not
   displayed again.** Every later sign-in asks for a code from that app.
2. **Outlets** → add your outlets, one per benefit category
3. **Outlets** → *Issue device token* for each counter tablet.
   **The token is shown once and never again** — the sheet holds only its hash.
   Enter it on that device at `<web-app-url>?page=outlet`. Device enrollment is
   administrator-only by design; there is no self-service path
4. **Members** → create a member. They receive an invitation email with an
   activation code
5. The member opens `<web-app-url>`, taps *I have an activation code*, and is in

### Updating an existing installation

Replace all four project files, select `setup_`, and run it once before creating
a new deployment version. Setup adds missing sheets and columns without deleting
existing rows or extra columns. It fills newly introduced benefit fields and
migrates known legacy seed text without overwriting other edited values. If an
older sheet contains phone numbers in a legacy format, run the optional
owner-only `repairPhoneNumbers_` function after making a Sheet backup.

Existing administrators are **not** locked out by the addition of two-factor
authentication: an account with no enrollment is routed through setup on its
next sign-in, using the password it already has.

### If an administrator is locked out

Recovery codes come first — any one of the ten signs them in. If those are gone
too, open the script editor and run the owner-only `resetStaffMfa_` function
(no argument resets every administrator; pass an email to reset one). That
clears enrollment so the account sets up a new authenticator at its next
sign-in. It is a safe last resort precisely because running it requires access
to the script project, which is a higher bar than either factor it resets.
`resetStaffPasswords_` remains the equivalent for a forgotten password.

---

## Security — read this before deploying

The backend has **one browser RPC**, `apiCall`, and everything goes through its
dispatcher and session gate:

```javascript
if (PUBLIC_ACTIONS.indexOf(action) === -1) {
  var session = requireSession(token);
  if (!session.ok) return { success: false, error: ..., code: 'UNAUTHENTICATED' };
}
```

Five actions are reachable without a session: `requestPasscode`,
`verifyPasscode`, `claimMembership`, `staffLogin`, `outletLogin`. Every other
action that reads or writes data requires a valid, role-checked session.

Three more — `staffBeginMfaEnrollment`, `staffConfirmMfaEnrollment` and
`staffVerifyMfa` — sit outside the session gate because they run *before* a
session exists, between a correct password and a second factor. They are not
ungated: each requires an unexpired MFA challenge, which lives only in
`CacheService` under its own key prefix, is never written to `Sessions`, and
therefore cannot be resolved by `requireSession()` no matter what is passed to
it. A challenge authorises nothing except the attempt to present a code.

All sheet, authentication and cryptographic helpers are nested inside a private
server closure. They cannot be invoked directly with `google.script.run`.

Sessions also carry a **type**, and the type is checked per action — a member
session cannot reach `listMembers`, and an outlet device cannot reach anything
outside its own counter. An outlet records redemptions **against its own outlet
only**; the outlet id comes from the session, never from the request body.

**Why this matters.** An Apps Script web app deployed to "Anyone" is reachable
by anyone who has the URL. If actions dispatch before the session check, then
`?action=getGuests` in a browser address bar returns the entire membership list,
and `resetStaffPassword` hands over the administrator account. That is not
hypothetical — it is the default shape of an Apps Script CRUD backend, and it is
easy to write by accident.

Other decisions worth knowing:

- **Every administrator has a second factor.** A correct password no longer
  signs anyone in; it returns a challenge, and a TOTP code from an authenticator
  app completes the sign-in. Enrollment is mandatory and happens on first
  sign-in — there is no way to skip it and no setting that turns it off.
  Codes are single-use: the period a code was accepted in is recorded, so a code
  read over a shoulder cannot be replayed inside its ~90-second validity window.
  Ten single-use recovery codes are issued at enrollment. **The TOTP secret is
  stored in Script Properties, never in the Sheet**, so exporting the workbook
  does not hand over working second factors.
- **Passcodes are HMAC-SHA256 hashed** before storage. The plaintext code exists
  only in the email and, when SMS is configured, the text message.
- **Sign-in gives a uniform response** whether or not the number belongs to a
  member. Otherwise this endpoint becomes a way to test who is in the programme.
- **Claim codes are single-use**, bound to their member's phone number, and
  expire after 30 days.
- **Suspending a member invalidates their sessions immediately** by bumping
  `tokenVersion`, which `requireSession()` checks on every call.
- **Outlet device tokens are per-device and individually revocable.** Revoking
  one locks that tablet out on its next request — a lost tablet does not mean
  rotating a password everyone shares. They are issued **only** from the admin
  panel; there is no self-service enrollment path.
  Note the limit of what this proves: the token is a string in the tablet's
  `localStorage`, so it authenticates *possession of the token*, not a
  particular piece of hardware. Copied to another browser, it works there too.
  Revocation is the control that matters — use it whenever a device leaves.
- **Rate limits** on passcode requests, verification, claims and staff login.
- **Cohorts below five are suppressed** in reporting, so a figure cannot be
  traced to one identifiable member.
- **Signing secrets** are generated on first run into Script Properties. They
  are never in this file.
- **Member and counter sessions use browser `localStorage`.** Unlike the
  PostgreSQL build's HttpOnly refresh cookie, JavaScript can read these tokens.
  To reduce that risk the pages load no third-party scripts, render Sheet values
  as text or context-escape them before HTML insertion, and clear expired or
  revoked sessions immediately.
- **Visit notices expire after 24 hours** if no outlet records the visit. The
  next request or queue read closes them as `NOT_USED`; no timed trigger is
  required.
- **Email and SMS preferences are append-only consent records.**
- **SMS is optional and additive, never a replacement for email.** See *SMS
  (optional)* below to wire up a provider. Unconfigured, every send site keeps
  working on email alone.

---

## What this version cannot do

Honest list. None of these are bugs.

| | Why |
|---|---|
| **Redemption records cannot be made tamper-proof** | The PostgreSQL build revokes UPDATE and DELETE from the application role at the database level, so the guarantee holds even if the API is compromised. A spreadsheet cannot do that — anyone with edit access can change a cell. Sheet version history is the only backstop. |
| **The MFA secret is relocated, not encrypted** | The PostgreSQL build encrypts each TOTP secret with AES-256-GCM before it reaches the database, so a stolen dump yields no working second factors. Apps Script exposes no symmetric cipher, so that is not reproducible. Instead the secret is kept out of the Sheet entirely, in Script Properties — reachable only by someone who can open the script project, not by someone who can read or export the workbook. A weaker guarantee, and a deliberate one. |
| **No "add to home screen"** | Apps Script serves pages inside a sandboxed frame, which prevents registering a service worker or serving your own manifest. Members bookmark it instead. Serving the page from your own domain (with Apps Script as the data API) restores this. |
| **Reads load the whole sheet** | `rows()` reads every row on every call. Fine at 2,000 members; redemption history grows without limit, so add `CacheService` caching before it becomes a problem. |
| **Data lives on Google's infrastructure** | Region is not selectable. Weigh this against the membership list's contents. |

---

## Quotas that will actually bite

| Limit | Workspace account |
|---|---|
| **Email recipients per day** | **1,500** |
| Script runtime per execution | 6 minutes |
| Simultaneous executions | 30 per user |

Ordinary use is roughly 150 emails a day and fits comfortably. **Onboarding
2,000 members means 2,000 invitations — that exceeds the daily cap and must be
staggered across at least two days.** Plan the launch around it.

---

## Sheets it creates

| Sheet | Holds |
|---|---|
| `Members` | Name, number, phone, email, status, token version |
| `ClaimCodes` | Hashed single-use activation codes |
| `Benefits` | The five categories, discounts, caps, terms, versioned |
| `Requests` | "I'm coming" notices from members |
| `Redemptions` | **Append-only.** Corrections append a reversal row. |
| `Outlets` | Names, categories and notification addresses |
| `OutletTokens` | Hashed per-device tokens, revocable individually |
| `Staff` | Administrator accounts, and their MFA enrollment state |
| `MfaRecoveryCodes` | Hashed single-use recovery codes, marked used, never deleted |
| `Sessions` | Hashed session tokens |
| `OtpCache` | Hashed passcodes, short-lived |
| `ConsentRecords` | Append-only email and SMS consent history |
| `Audit` | Who did what, when |
