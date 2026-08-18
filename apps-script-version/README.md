# Privilege Guest Program — Apps Script version

A port of the member app onto Google Apps Script + Google Sheets, so it runs
with **no server and no hosting bill**.

**This folder is self-contained.** Nothing here touches the PostgreSQL build in
`apps/` — that remains the reference implementation.

---

## What is here

| File | What it is |
|---|---|
| `Code.gs` | The whole backend — auth, members, benefits, requests, redemptions, outlets, reports, email |
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

### 3. Point it at the artwork

Apps Script cannot host images. Put the contents of
`apps/web-member/public/` somewhere with static hosting — GitHub Pages is free
and works well — then set:

```javascript
var ASSET_BASE = 'https://<your-user>.github.io/pgp-assets';
```

The app degrades gracefully without this: images simply do not render and every
screen still works.

The supplied `Member.html` creates membership QR codes locally with a vendored
copy of `qrcode-generator` 2.0.4 (MIT). Card data and session tokens are never
sent to an image or QR service.

### 4. Deploy

After saving `ASSET_BASE`, choose **Deploy → New deployment → Web app**.

| Setting | Value |
|---|---|
| Execute as | **Me** |
| Who has access | **Anyone** |

"Anyone" is safe here — see *Security* below. It is not safe by default, and it
is worth understanding why before you deploy. When updating an existing web
app, create a new deployment version after every code or asset-base change.

### 5. First run, in order

1. Open `<web-app-url>?page=admin` and sign in with the credentials from step 2
2. **Outlets** → add your outlets, one per benefit category
3. **Outlets** → *Issue device token* for each counter tablet.
   **The token is shown once and never again** — the sheet holds only its hash.
   Enter it on that device at `<web-app-url>?page=outlet`
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

Only five actions are reachable without a session: `requestPasscode`,
`verifyPasscode`, `claimMembership`, `staffLogin`, `outletLogin`. Every other
action that reads or writes data requires a valid, role-checked session.

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

- **Passcodes are HMAC-SHA256 hashed** before storage. The plaintext code exists
  only in the email.
- **Sign-in gives a uniform response** whether or not the number belongs to a
  member. Otherwise this endpoint becomes a way to test who is in the programme.
- **Claim codes are single-use**, bound to their member's phone number, and
  expire after 30 days.
- **Suspending a member invalidates their sessions immediately** by bumping
  `tokenVersion`, which `requireSession()` checks on every call.
- **Outlet device tokens are per-device and individually revocable.** Revoking
  one locks that tablet out on its next request — a lost tablet does not mean
  rotating a password everyone shares.
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
- **Email and SMS preferences are append-only consent records.** This version
  stores the SMS preference but does not include an SMS delivery provider.

---

## What this version cannot do

Honest list. None of these are bugs.

| | Why |
|---|---|
| **Redemption records cannot be made tamper-proof** | The PostgreSQL build revokes UPDATE and DELETE from the application role at the database level, so the guarantee holds even if the API is compromised. A spreadsheet cannot do that — anyone with edit access can change a cell. Sheet version history is the only backstop. |
| **No administrator second factor** | The PostgreSQL build uses `otplib` for authenticator-app codes. Hand-rolling TOTP is possible but it is security code and belongs in a reviewed change of its own. |
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
| `Staff` | Administrator accounts |
| `Sessions` | Hashed session tokens |
| `OtpCache` | Hashed passcodes, short-lived |
| `ConsentRecords` | Append-only email and SMS consent history |
| `Audit` | Who did what, when |
