# Product Definition

**Product:** Digital companion for the Steigenberger Doha Privilege Guest Program
**Version:** 3 — administrator-only hotel access confirmed
**Status:** Draft for review

---

# 0. What changed from version 1

Version 1 assumed a multi-brand coalition with a points currency. The client has confirmed a much narrower product. Recorded here so the reduction is deliberate and visible rather than silent.

| Removed | Reason |
|---|---|
| Coalition across independent brands | All outlets are the hotel's own. No settlement between parties. |
| Points, ledger, balances | Benefits are a fixed discount schedule. Nothing is earned. |
| Tiers and earn multipliers | One membership level. |
| Points liability and expiry | No currency exists to be owed. |
| Segment engine, personalized targeting | Every member sees the same benefits. |
| Competitive tenant isolation | Single owner throughout. |
| POS integration | Discounts are applied by staff at the point of service. |
| WhatsApp campaign layer | Not requested. Existing programme notifies by email and SMS. |

**What remains is a small, sharply defined product**, and the timeline shortens accordingly.

Version 3 narrows the product again after direct client confirmation. There are
exactly two user-facing applications: the member guest app and the administrator
panel. Manager, support and outlet-staff accounts are not part of the product.
Only named administrators can sign in to the hotel panel. Historical database
role values may remain solely to preserve attribution on old records; they grant
no access and are not shown in the product.

---

# 1. What we are building

The Privilege Guest Program already exists. Members receive a printed letter, a physical numbered card, and a printed sheet of benefits. What does not exist is any digital surface — members cannot look up their benefits on a phone, and the hotel has no record of who used what.

**We are building two things:**

1. **A member app** — so a Privilege Guest can see their benefits, search them, and present their membership.
2. **An admin dashboard** — so the hotel can manage members and see exactly which benefits are being used, by whom, and when.

> **In one sentence:** the printed benefits sheet becomes a member app, and the
> administrator panel gives the hotel one secure place to manage membership,
> approve benefit requests and record each use.

## The problem it solves

**For the member:** the benefits live on a sheet of paper that will be lost. There is no way to check what you are entitled to while standing in a restaurant, and reservations require finding the right phone number on a printed table.

**For the hotel:** there is currently no data at all. Nobody can answer how many members used the spa discount last month, which benefit is most popular, whether the programme is worth its cost, or which members have never used anything. The programme runs blind.

---

# 2. The existing programme

Captured from the member letter and benefits sheet so the build matches reality.

**Nature:** invitation-only, extended personally by the Cluster General Manager. Members receive a numbered card — the reference example is PG-0003 — printed with the member's name.

**Benefits:**

| Category | Benefit | Constraints |
|---|---|---|
| **F&B Outlets** | 25% discount · 50% for children 6–12 · free for children 0–6 | Maximum 6 people per cardholder. Reservations: 4020 1720 |
| **Rooms & Suites** | 30% off published bar rates, Hotel & Residence | Subject to availability. Reservations: 4020 1666 |
| **Spa** | 40% off all treatments · 25% off retail products | Maximum 2 people. Reservations: 4020 1625 |
| **Meetings & Events** | 25% off events · 20% off outside catering | Events minimum 20 people |
| **Lifestyle & SPG Memberships** | 30% off memberships · 25% off pool day pass · free valet parking · free wifi | — |

Additionally stated in the invitation letter, though absent from the benefits table:

- Personalized assistance from a dedicated team during a stay
- Priority reservations at the hotel's restaurants
- Invitations to member-only events and gatherings

**Note:** benefits are described as subject to change without notice, with members notified by their preferred channel. This confirms that **benefit content must be editable by hotel staff without a code change** — the single most important configuration requirement.

---

# 3. Scope

## In scope

- Member app: explore, browse benefits, search, profile, digital card
- Membership claim by invitation
- Redemption capture and history
- Admin dashboard: member management, redemption records, benefit editing

## Out of scope

- Points, tiers, balances or any earned currency
- Personalized or targeted offers
- POS integration
- Payment processing
- Multi-property or multi-brand support
- Public self-service signup

## Deliberately proposed, pending approval

- **Tap-to-call reservations.** Three benefits require phoning a different number. Making those tappable is close to free and removes real friction.
- **Wallet pass.** A digital card in Apple or Google Wallet, alongside the app. Useful because it works without opening anything, but not requested — treat as optional.

---

# 4. The member app

Four sections, as specified by the client.

## Explore

The landing screen. Orients the member and surfaces what is available now.

- Personal welcome and membership number
- Benefit categories as visual cards
- Anything time-limited: an upcoming member event, a seasonal offer
- Quick access to the digital card

## Offers

The complete benefit list — every category, every discount, all terms.

Each entry shows: the discount, who it applies to, any limit on party size, availability conditions, and how to reserve. Nothing is hidden behind another tap, because the printed sheet it replaces showed everything at once.

## Search

Straightforward text search across benefit names, categories and outlets. With five categories this is a convenience rather than a necessity, but it was specified and it costs little.

## Profile

- Member name and number
- **The digital card** — the member's name and membership number
- **Redemption history** — every benefit used, with date and outlet
- Contact details, editable
- Communication preferences
- Terms and privacy policy

Redemption history matters more than it appears. It is the member's own record of what they have used, and it answers "did I already use the spa discount this month" without a phone call.

---

# 5. The digital card

The physical card stays; the app carries a digital equivalent.

**What it shows:** member name and membership number. There is no QR or
staff-verification application. A member requests a benefit in the guest app;
an administrator reviews and records it in the administrator panel.

---

# 6. Redemption

## The flow

1. The member requests a benefit in the guest app.
2. An administrator reviews the request in the administrator panel and approves
   or declines it.
3. The outlet applies the approved discount using its normal operating process.
4. An administrator marks the request as used, selects the outlet and records
   the redemption details.

**The system records the redemption. It does not process the discount** — that stays where it already works.

## Party size

Two benefits carry hard limits — maximum 6 for F&B, maximum 2 for spa. Party size is therefore a required field at redemption, not an optional note. Without it the limits are unenforceable and the dashboard cannot report accurately on programme cost.

---

# 7. The admin dashboard

## Members

- Full member list: name, membership number, date joined, contact details, status
- **Create a member and issue an invitation** — the programme is invitation-only, so this replaces public signup
- Member detail: profile, complete redemption history, total benefits used
- Suspend or reinstate a membership
- Search and filter

## Redemptions

- Every redemption: member, benefit, outlet, party size, date, and the staff member who recorded it
- Filter by date, benefit, outlet, member
- Export

## Reporting

The programme currently produces no data at all, so even simple counts are a significant improvement:

- Redemptions per month, by benefit category
- Most and least used benefits
- Active versus dormant members — who has never redeemed anything
- Redemptions by outlet
- Average party size per benefit
- Estimated discount value given, if staff enter bill amounts

That last one is optional but valuable: it is the only way to answer whether the programme is worth its cost.

## Benefit management

Because benefits are explicitly subject to change:

- Edit discount percentages, descriptions and terms
- Add or remove benefit categories
- Change reservation numbers
- Publish and unpublish
- Every change versioned and attributed

**Test of success:** changing the F&B discount from 25% to 20% is a form field, not a code change.

## Administrators

The hotel-facing product has one account type: **Administrator**. Named
administrators can manage members, requests, redemptions, benefits, reports and
other administrator accounts. There are no manager, support or outlet-staff
logins, and there is no reduced staff panel.

---

# 8. Onboarding a member

Invitation-only, so the flow runs in the opposite direction from a normal app.

1. Administrator creates the member record and issues the physical card
2. System generates a **single-use claim code**, printed on the invitation letter or sent directly
3. Member downloads the app and enters the code with their phone number
4. Phone verified by one-time passcode
5. Consent captured, per channel
6. Membership is claimed and the digital card appears

**A claim code can be used once.** The physical card and the letter both carry a membership number, and a code that could be reused would let anyone holding a discarded letter join.

---

# 9. Confidentiality

This deserves its own section because of who the members are.

The reference card in the programme materials is issued to a member of the Qatari ruling family. A membership list of this kind is a record of named, prominent individuals and their movements — when they dined, when they visited the spa, how often they stay.

**That is not ordinary customer data.** A leak would be a serious matter for the hotel independent of any regulatory penalty.

Practical consequences, carried through into the security specification:

- Only named administrators can access hotel/member administration data
- Every lookup and export is individually logged and attributed
- Member names never appear in application logs
- Exports are restricted to administrators and audited
- Analytics default to counts rather than named individuals

---

# 10. Phasing

**Phase 1 — Core**
Member app with all four sections. Digital card. Claim flow. Administrator
panel. Member and benefit-request management. Redemption capture and history.
Basic reporting. Benefit editing.

**Phase 2 — Refinement**
Tap-to-call reservations. Push notifications for benefit changes and event invitations. Fuller reporting. Optional wallet pass.

**Phase 3 — If wanted**
In-app reservation requests. Member-event invitations and RSVPs. Integration with the hotel's property management system.

---

# 11. Open questions

1. **Resolved:** there is no QR-based redemption flow; members request benefits
   and administrators process them in the panel.
2. **Should the app cover priority reservations and event invitations?** Both are promised in the letter but absent from the benefits sheet.
3. **Should staff record the bill amount at redemption?** The only route to knowing what the programme costs.
4. **How many members are there today, and what is the expected growth?** The reference card is number three.
5. **Does membership expire or renew?**
6. **Who issues invitations, and is there an approval step?**
7. **What is the relationship to H Rewards,** the chain-wide programme whose mark appears on the letterhead?
8. **iOS and Android both, or one first?**
9. **Arabic and English?** Assumed both.
10. **What are the three numbers you would check every month?** Fastest way to confirm the reporting scope.
