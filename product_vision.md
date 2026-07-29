# Product Definition

**Product:** Digital companion for the Steigenberger Doha Privilege Guest Program
**Version:** 2 — revised after client confirmation
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

---

# 1. What we are building

The Privilege Guest Program already exists. Members receive a printed letter, a physical numbered card, and a printed sheet of benefits. What does not exist is any digital surface — members cannot look up their benefits on a phone, and the hotel has no record of who used what.

**We are building two things:**

1. **A member app** — so a Privilege Guest can see their benefits, search them, and present their membership.
2. **An admin dashboard** — so the hotel can manage members and see exactly which benefits are being used, by whom, and when.

> **In one sentence:** the printed benefits sheet becomes an app, the plastic card becomes a scannable digital credential, and every use of a benefit becomes a record the hotel can see.

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
- Staff verification page for applying and logging a benefit

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
- **The digital card** — the scannable credential
- **Redemption history** — every benefit used, with date and outlet
- Contact details, editable
- Communication preferences
- Terms and privacy policy

Redemption history matters more than it appears. It is the member's own record of what they have used, and it answers "did I already use the spa discount this month" without a phone call.

---

# 5. The digital card

The physical card stays; the app carries a digital equivalent.

**What it shows:** member name, membership number, and a QR code.

**What the QR code is:** an opaque member identifier with a signed, rotating timestamp. It identifies the member. It does not, by itself, authorise a discount — staff confirm entitlement against the member record before applying anything.

**Why the rotation matters here more than usual.** These are high-value benefits — 40% off spa treatments, 30% off room rates. A static code that could be screenshotted and forwarded would be worth real money. The payload refreshes, so an old screenshot fails validation.

---

# 6. Redemption

## The flow

1. Member requests a benefit — at a restaurant, spa reception, or when booking
2. Staff open the **verification page** and scan the member's code, or type the membership number
3. The page confirms: valid member, name, and the benefits they are entitled to
4. Staff select the benefit applied and enter the party size
5. Staff confirm. The redemption is recorded
6. The discount is applied on the hotel's own till as it is today

**The system records the redemption. It does not process the discount** — that stays where it already works.

## The verification page

Deliberately a **web page, not a separate application.** Staff open a URL on any device already behind the counter, sign in with their own account, and use it. No installation, no device procurement, no app store.

It is part of the dashboard, not a fourth product.

## Party size

Two benefits carry hard limits — maximum 6 for F&B, maximum 2 for spa. Party size is therefore a required field at redemption, not an optional note. Without it the limits are unenforceable and the dashboard cannot report accurately on programme cost.

## Open question on the existing QR

The client mentions an existing QR code for the offer. Two possibilities, and they lead to different builds:

- **A code displayed at each outlet**, scanned by the member. Lighter — no staff page needed — but self-declared, and a 40% discount should not be self-declared.
- **A code identifying the member**, scanned by staff. Matches the flow above.

This needs confirming before development starts. The specification above assumes the second.

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

## Staff and roles

| Role | Access |
|---|---|
| **Administrator** | Everything: members, benefits, reports, staff accounts |
| **Manager** | Members and reports; no benefit or staff configuration |
| **Outlet staff** | Verification page only. Can look up the member in front of them. **No member list, no reports** |

Outlet staff cannot browse the membership. Given who these members are, that restriction is not a formality.

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

- Outlet staff can retrieve only the member currently in front of them, never a list
- Every lookup and export is individually logged and attributed
- Member names never appear in application logs
- Exports are restricted to administrators and audited
- Analytics default to counts rather than named individuals

---

# 10. Phasing

**Phase 1 — Core**
Member app with all four sections. Digital card. Claim flow. Verification page. Member management. Redemption capture and history. Basic reporting. Benefit editing.

**Phase 2 — Refinement**
Tap-to-call reservations. Push notifications for benefit changes and event invitations. Fuller reporting. Optional wallet pass.

**Phase 3 — If wanted**
In-app reservation requests. Member-event invitations and RSVPs. Integration with the hotel's property management system.

---

# 11. Open questions

1. **What does the existing QR code do?** Determines the redemption build.
2. **Should the app cover priority reservations and event invitations?** Both are promised in the letter but absent from the benefits sheet.
3. **Should staff record the bill amount at redemption?** The only route to knowing what the programme costs.
4. **How many members are there today, and what is the expected growth?** The reference card is number three.
5. **Does membership expire or renew?**
6. **Who issues invitations, and is there an approval step?**
7. **What is the relationship to H Rewards,** the chain-wide programme whose mark appears on the letterhead?
8. **iOS and Android both, or one first?**
9. **Arabic and English?** Assumed both.
10. **What are the three numbers you would check every month?** Fastest way to confirm the reporting scope.