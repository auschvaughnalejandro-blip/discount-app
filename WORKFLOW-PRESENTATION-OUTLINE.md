# Presentation outline — how the system works, screen by screen

An outline for building slides from. Not the slides themselves.

**Screen names, routes and endpoints below are read from the code** and are
accurate as of this file's writing. Where a behaviour is inferred rather than
verified line-by-line it is marked **[verify]**.

---

# The shape of the presentation

Seven parts. Parts B–D are the screen-by-screen walk your supervisor asked for.
**Part E is the one that will actually land** — screens in isolation don't show
how a system works, journeys do.

| Part | What it covers | Rough slides |
|---|---|---:|
| A | The three apps and who uses them | 2 |
| B | Member app, screen by screen | 7 |
| C | Outlet screen, screen by screen | 4 |
| D | Administrator panel, section by section | 9 |
| E | **Three end-to-end journeys** | 3 |
| F | Every automatic message the system sends | 1 |
| G | What it costs to run | 3 |

---

# PART A — The three apps

## A1 · Who uses what, and from where

| App | Address | Who | Reachable from |
|---|---|---|---|
| Member app | `my.<domain>` | Members | **Anywhere in the world** |
| Outlet screen | `outlet.<domain>` | Outlet staff | **Hotel network only** |
| Administrator panel | `admin.<domain>` | Named administrators | **Hotel network only** |

All three talk to one backend and one database. The restriction is enforced at
the front desk (Caddy) by source address — not by the apps themselves.

## A2 · The system in one sentence

> A member is invited by an administrator, activates on their phone, browses
> benefits, tells us they are coming, and the outlet records what they used.

Everything in Parts B–D is a detail of that sentence.

---

# PART B — The member app · 7 screens

For each slide: **what it shows · what you can press · what happens behind it ·
where it leads.**

> **Use the SVG designs as your slides.** Every member screen has a finished
> design export, and the file names are the screen numbering your supervisor will
> find easiest to follow:
>
> | Screen | Design file |
> |---|---|
> | Offers | `A1-offers-list.svg` |
> | Offer detail | `A2-offer-detail.svg` |
> | Profile | `A3-profile.svg` |
> | Membership card | `A4-membership-card.svg` |
> | Sign in | `A5-signin.svg` |
> | Passcode | `A6-passcode.svg` |
> | Activate | `A7-activate.svg` |
>
> Drop the SVG straight onto the slide rather than screenshotting the running
> app — they are the source artwork and will render sharp at any size.

## B1 · Sign in — `/signin` · design `A5-signin.svg`

- **Shows:** a phone number field
- **Press "Send code":** calls `POST /auth/member/request-otp`
- **Behind it:** generates a passcode, stores only a hash of it, sends the
  plaintext to the member by email
- **Important:** the response is identical whether or not that phone number is a
  member. Deliberate — a different response would let anyone test whether a
  person is in the programme.
- **Leads to:** Verify

**The identity model, worth stating once at the top of Part B:** a member signs in
with **a mobile number and nothing else** — no username, no password. The phone
number *is* the credential. That is why `A5`, `A6` and `A7` all centre on a
`+974` field, and why the profile screen carries no password controls.

## B2 · Verify — `/signin/verify` · design `A6-passcode.svg`

- **Shows:** a code field
- **Press "Verify":** calls `POST /auth/member/verify-otp`
- **Behind it:** hashes the entered code, compares, issues a session. The member
  stays signed in for **30 days** without needing another code.
- **Limits:** 5 attempts, code expires in 5 minutes
- **Leads to:** Offers

## B3 · Activate — `/activate`

- **Shows:** a claim-code field, for a member who has been invited but not yet
  joined
- **Press "Activate":** calls `POST /member/claim`
- **Behind it:** validates the claim code, marks the membership as claimed,
  records the date
- **⚠️ The detail your supervisor asked about:** *pressing Activate does **not**
  send an email.* The invitation email was already sent when the administrator
  created the member. Activate **consumes** that code.
- **Leads to:** Offers

*(Design file: `A7-activate.svg`)*

## B4 · Offers — `/offers` · design `A1-offers-list.svg`

- **Shows:** the five benefit categories with their discounts, each with its own
  **hero photograph** — `benefit-fnb.jpg`, `benefit-spa.jpg`, `benefit-events.jpg`
  and so on, named for the offer they belong to
- **Loaded by:** `GET /benefits`
- **Press a benefit:** goes to its detail page
- **Leads to:** Offer detail

## B5 · Offer detail — `/offers/:slug` · design `A2-offer-detail.svg`

- **Shows:** the hero image, the discount, the terms, the caps, the reservation
  number
- **Press "I'm coming" / request:** calls `POST /member/me/requests`
- **Behind it:** creates a benefit request and notifies the outlet that a
  Privilege Guest is expected
- **Leads to:** the request appears in that outlet's queue

## B6 · Profile — `/profile` · design `A3-profile.svg`

**This screen is the member-facing payoff and deserves its own slide.**

- **Shows:**
  - Name, membership number, contact details, consent status
  - **A savings stat bar** — QAR saved, visits, benefits used
  - **An activity list** — every past visit: which benefit, which outlet, the
    date, and what that visit saved
- **Loaded by:** `GET /member/me`
- **Press consent toggle:** `PATCH /member/me/consent` — records consent against
  the exact wording version shown
- **Also links to:** privacy policy and terms *(content does not exist yet)*
- **Leads to:** Card

### The detail worth calling out

`savedMinor` is **nullable**, and the interface honours that. When no bill amount
was entered at the outlet, the row shows **“—”**, not “QAR 0”.

From [ActivityRow.tsx](apps/web-member/src/components/ActivityRow.tsx): *“a
missing amount stays missing … would tell a member a visit saved them nothing.”*

That is the difference between *“we don’t know”* and *“you saved nothing”*, and
getting it wrong would insult the member. Worth one line in the presentation —
it demonstrates the care that separates a finished product from a prototype.

### Why this matters commercially

The dashboard answers *“is the programme worth its cost”* **for the hotel.**
This screen answers the same question **for the member** — it shows them, in
riyals, what their membership has been worth. That is a retention feature, and
it only exists because redemptions are recorded.

## B7 · Card — `/profile/card` · design `A4-membership-card.svg`

- **Shows:** the digital equivalent of the printed card — name, membership
  number, and the scannable code
- **Press nothing:** it is a display screen (fullscreen modal)
- **Note for the slide:** the physical card is not replaced. This is a
  convenience copy carrying the same code the outlet screen scans.

---

# PART C — The outlet screen · 4 states

## C1 · Device sign-in

- **Shows:** a token field, once per device
- **Behind it:** `POST /outlet/auth/token`
- **Key point:** the credential belongs to the **device**, not a person. Each
  tablet or counter computer gets its own token, so one can be revoked without
  disturbing the others.

## C2 · Queue tab

- **Shows:** members this outlet is expecting
- **Loaded by:** `GET /outlet/requests`
- **Why it matters:** this is the payoff of B5. The restaurant knows a Privilege
  Guest is coming before they walk in.

## C3 · Lookup tab — **the scan**

- **Shows:** a camera view, plus manual search
- **Press scan / enter a number:** `POST /outlet/resolve`
- **Behind it — what your supervisor specifically asked:**
  1. The code is read and sent to the server
  2. The server looks up **who** that member is and **whether the membership is
     currently valid**
  3. It returns the member's name, number, status and what they are entitled to
  4. Nothing is recorded yet — this step only **identifies**
- **⚠️ The security line for the slide:** the code **identifies, it does not
  authorise.** Someone photographing it gains nothing they could not read off the
  front of the printed card. Applying a discount needs a signed-in outlet device.

## C4 · History tab

- **Shows:** redemptions this outlet has recorded
- **Why it matters:** staff can confirm what they entered, and disputes have a
  record

---

# PART D — The administrator panel · 9 sections

## D0 · Sign-in and second factor

- `POST /auth/staff/login`, then MFA
- Two stages: **enroll** (first time — scan a QR into an authenticator app) and
  **verify** (every time after)
- **Endpoints:** `/auth/staff/mfa/enroll`, `/enroll/confirm`, `/verify`
- **Point for the slide:** every administrator has a second factor. This is the
  account that can see the whole membership list.

## D1 · Overview

- Headline figures and what needs attention
- `GET /admin/reports/summary`
- Where the panel opens

## D2 · Requests

- Who each outlet is expecting
- `GET /admin/requests`

## D3 · Members

- **Full list, create, suspend, reinstate**
- `GET /admin/members`, `POST /admin/members`, `PATCH /admin/members/:id`
- **⚠️ What "Create member" actually does — worth its own slide:**
  1. Creates the member record
  2. Generates a **claim code** and stores a hash of it
  3. **Sends the member an invitation** containing that code
  4. **If the email fails to send, the code is shown to the administrator on
     screen** so it can be passed on by hand
- There is also a **reissue** path: it invalidates any outstanding claim codes
  and sends a fresh one

## D4 · Redemptions

- **The immutable log** — `GET /admin/redemptions`
- **Record a redemption:** `POST /admin/redemptions` — benefit, outlet, party
  size, member
- **Reverse a redemption:** `POST /admin/redemptions/:id/reverse`
- **⚠️ The point worth making:** a redemption is **never edited or deleted**. A
  mistake is corrected by recording a *reversal* — both entries remain. This is
  enforced at the database level, not by application code, so it holds even if
  the application is compromised.
- **Party size is required, not optional** — F&B caps at 6, spa at 2. Without it
  the caps are unenforceable and reporting cannot say what the programme costs.

## D5 · Reports

- `GET /admin/reports/by-month`
- Redemptions per month by category, most and least used benefits, active vs
  dormant members, by outlet, average party size

## D6 · Benefits

- `GET/POST /admin/benefits`, `PATCH /admin/benefits/:id`
- **The test of success:** changing F&B from 25% to 20% is a **form field**, not
  a development request. Every change is versioned and attributed.

## D7 · Outlets

- `GET /admin/outlets/manage`, `PATCH /admin/outlets/:id`
- Notification addresses, and issuing/rotating the per-device outlet tokens
  from C1

## D8 · Administrators

- `GET/POST /admin/staff`
- Creating and offboarding administrator accounts
- **Point:** before this existed, removing someone meant editing the database by
  hand

---

# PART E — Three end-to-end journeys ⭐

**This is the part that answers "how does each screen lead to the other."**
Build these as flow diagrams, one per slide. They are the strongest three slides
in the deck.

## E1 · A new member joins

```
ADMIN                          SYSTEM                      MEMBER
Members → Create        →  creates record
                           generates claim code
                           sends invitation  ──────────→  receives email
                                                          opens my.<domain>
                                                    ←──   /activate, enters code
                           marks claimed
                                                    ←──   /offers — sees benefits
```

**Fallback to mention:** if the invitation email fails, the code appears on the
administrator's screen to pass on by hand.

## E2 · A member uses a benefit

```
MEMBER                    SYSTEM                     OUTLET
/offers/:slug
"I'm coming"      →   creates request
                      notifies outlet    ──────→   Queue tab: guest expected

(arrives at outlet)
shows card        →                      ──────→   Lookup tab: scan
                      resolves identity  ──────→   name, number, entitlement
                                                   applies discount (as today)
                                          ←─────   records: benefit, outlet,
                                                   party size
                      writes immutable
                      redemption record
                                          ──────→  appears in admin Redemptions
                                                   and in Reports
```

**The line for this slide:** *the system records the discount, it does not apply
it.* The outlet's existing process is untouched.

## E3 · A discount changes

```
ADMIN                         SYSTEM                    MEMBER
Benefits → edit 25%→20%  →  new version saved
                            attributed to the
                            administrator
                                              ──────→  /offers shows 20%
                                                       immediately
```

**The line:** no reprinting, no developer, and the old version is still on record
so past redemptions still make sense.

---

# PART F — Every automatic message

One table, one slide. Answers "does pressing X send an email" for all of it.

| Trigger | Message | Goes to |
|---|---|---|
| Administrator creates a member | **invitation** (contains claim code) | Member |
| Administrator reissues a code | **invitation** (new code, old ones voided) | Member |
| Member requests a sign-in code | **sign-in** passcode | Member |
| Member activates | *(none — the code was already sent)* | — |
| Member requests a benefit | **request-submitted** | Member |
| Member requests a benefit | **outlet-request** | Outlet |
| Visit did not happen | **request-not-used** | Member |
| Redemption recorded | **redemption-recorded** | Member |

**All of these go by email.** Delivery is one setting — the code was built so the
channel can be swapped without touching anything else.

---

# PART G — Costing

Three slides. See the cost briefing for the sourced detail.

## G1 · The server — QR 147/month

`t4g.medium`, 4 GiB, on IT's recommendation for performance headroom.

| Line | Monthly |
|---|---:|
| Server | $29.78 |
| Storage (disk + backups) | $6.89 |
| Internet address | $3.65 |
| Data transfer | $0.00 |
| **Total** | **$40.32 · QR 147** |

## G2 · How the size was chosen

Measured requirement **943 MB**. The 4 GiB machine gives **4.2× headroom**,
chosen deliberately over the 2 GiB option for performance margin and because
other factors will increase usage over time.

## G3 · Messaging

Email through the hotel's own mail — **QR 0**.

SMS remains on the table for members who prefer it. At Ooredoo's published rate
of QR 0.100 per message, the cost depends entirely on scope:

| Scope | Messages/month | Cost |
|---|---:|---:|
| Sign-in codes only | ~1,500 | QR 200 *(monthly minimum)* |
| All member messages | ~4,500 | QR 450 |

**Requires development** — the delivery channel currently accepts email only.

---

# What to verify before presenting

Three things I could not confirm without reading every handler:

1. **The exact wording and trigger of each lifecycle message** — Part F is
   assembled from the message-type definitions, not from tracing every call site
2. **Whether the outlet queue notification goes to an address or a screen** —
   the code supports an outlet notification address
3. **What the Offers screen does for a member whose membership is suspended**

None change the shape of the story. All are worth a five-minute check so nobody
is caught by a detail question.
