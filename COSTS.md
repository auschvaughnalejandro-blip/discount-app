# Costs — publishing and running the Privilege Guest Program

What it costs in money to put this in front of members and keep it there.

Companion to `DEPLOYMENT.md` (the procedure) and `ROADMAP.md` §7 and §9 (where to
host, and how the stores work). This file prices what those two describe.

## How to read the sourcing

Every figure below is one of two kinds, and they are labelled differently:

- **Quoted** — taken straight from a vendor. The figure links directly to the page
  or API response it came from. Click it and you should see that number.
- **Derived** — computed from quoted figures. The arithmetic is shown in full, and
  each input links to its own source.

Where a figure rests on an assumption rather than a vendor price, the assumption
is stated next to it. Nothing here is a figure I could not link.

Azure prices come from the [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices),
which is public and needs no key — the links open raw JSON for that exact SKU in
`qatarcentral`. Hourly-to-monthly uses **× 730 hours**, the convention Azure's own
calculator uses.

All figures USD at list price, no negotiated discount. QAR at the 3.64 peg
([Qatar Central Bank](https://www.qcb.gov.qa/en/exchange-rates)).
Pulled 2026-08-12 — cloud list prices change, so re-check before committing spend.

---

# 0. The four things worth knowing before the tables

**1. Staying in Qatar is free.** The instinct is that in-region hosting carries a
premium worth trading away. It does not. A 2 vCPU / 4 GB Linux VM costs **$31.32/mo
in Azure Qatar Central** ([$0.0429/hr × 730](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20armSkuName%20eq%20'Standard_B2als_v2'%20and%20priceType%20eq%20'Consumption'))
against **$29.78/mo for the AWS equivalent in UAE**
([ec2.shop, me-central-1](https://ec2.shop?region=me-central-1&filter=t4g.medium)).
That is a $1.54 difference, and §9 of the product definition spends two paragraphs
on why the membership list should not leave the country. Do not move to AWS to save
money — there is no money to save. Use AWS only if there is an existing account,
existing credits, or existing operational familiarity to trade on.

**2. SMS is the real bill, not hosting.** Twilio charges
**[$0.2634 per message segment](https://www.twilio.com/en-us/sms/pricing/qa)** to
Qatari numbers. Past roughly 120 members, one-time passcodes cost more per month
than the entire server. At 1,000 members it is eight times the server. This is the
only line in the budget that scales steeply, and it is the one nobody budgets for.

**3. The stores cost $124. The stores are not the expense.** Google Play is
**[$25 once](https://support.google.com/googleplay/android-developer/answer/6112435)**,
Apple is **[$99 a year](https://developer.apple.com/support/compare-memberships/)**.
What actually costs is engineering time (Capacitor, weeks) and calendar time
(D-U-N-S issuance, organisation verification, Apple review). Budget the schedule,
not the invoice.

**4. Do not reflexively buy managed Postgres.** It adds
**[$16.06/mo](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20serviceName%20eq%20'Azure%20Database%20for%20PostgreSQL'%20and%20meterName%20eq%20'B1MS')**
minimum, and per `DEPLOYMENT.md` §3 it silently destroys the R7
redemption-immutability guarantee unless the `pgp_app` / `pgp_owner` roles are
created by hand. Paying money to break a security property is a bad trade. The
container on the same VM is $0.

---

# 1. One-time and annual fixed costs

| Item | Cost | Kind | Source |
|---|---:|---|---|
| Google Play developer account | **$25** one-time | quoted | [Play Console Help — "US$25 one-time registration fee"](https://support.google.com/googleplay/android-developer/answer/6112435) |
| Apple Developer Program | **$99/year** | quoted | [Apple — Compare Memberships, "99 USD per membership year"](https://developer.apple.com/support/compare-memberships/) |
| D-U-N-S number | **$0** | quoted | [Apple — D-U-N-S, free of charge for enrolment](https://developer.apple.com/support/D-U-N-S/) |
| Domain | **$0** | assumption | Subdomains of the hotel's existing domain. Otherwise $12–40/yr at any registrar. |
| TLS certificates | **$0** | quoted | [Let's Encrypt — free](https://letsencrypt.org/), automated by Caddy |
| Apple Wallet pass type certificate | **$0** | quoted | Included in the $99 membership — [Apple Wallet developer docs](https://developer.apple.com/wallet/) |
| APNs / FCM push delivery | **$0** | quoted | [Firebase pricing — Cloud Messaging is "no-cost"](https://firebase.google.com/pricing) |
| App store commission | **$0** | reasoning | 15–30% applies to digital goods sold in-app ([Apple](https://developer.apple.com/app-store/small-business-program/), [Play](https://support.google.com/googleplay/android-developer/answer/112622)). Nothing is sold in-app — benefits are redeemed in person. |

**Year-one store total: $124** — derived, `$25 + $99`. Year two onward: **$99**.

## Two account decisions that cost nothing and save weeks

**Register both accounts to the hotel's legal entity, not to a developer.**
A loyalty programme for a named hotel published under an individual's name is a
transfer problem later and a credibility problem immediately.

**Check whether the hotel group already holds a D-U-N-S number and an Apple
organisation account.** A chain of this size very likely does. If so, this stage
collapses from weeks to a day — it becomes a request to an existing account admin
rather than a fresh verification.
Source: [Apple's D-U-N-S page](https://developer.apple.com/support/D-U-N-S/) —
use their lookup tool to check before applying for a new one.

**Take the organisation account on Google Play, not personal.**
[Google's own requirements page](https://support.google.com/googleplay/android-developer/answer/14151465)
states the rule as: *"at least 12 testers must be opted-in to your closed test"*
who *"must have been opted-in for the last 14 days continuously"*, and scopes it to
*"developers with personal accounts created after November 13, 2023"*.

**Read that scoping carefully.** Google's page does not say organisation accounts
are exempt — it simply does not mention them. The exemption is widely reported and
follows from the scoping, but it is an inference, not a published guarantee.
**Confirm with Play support before you plan a launch date around it.** If it holds,
it is two weeks of calendar bought for $0; if it does not, you need 12 testers
lined up two weeks before you want production access.

---

# 2. Hosting — the shape `DEPLOYMENT.md` already prescribes

One VM, Docker Compose, Caddy in front, Postgres in a container on the same box.
The three clients are static bundles after `vite build`, so nothing but the
Fastify process and the database actually runs.

## Azure Qatar Central — recommended

| Component | Spec | Monthly | Kind | Source |
|---|---|---:|---|---|
| Virtual machine | `Standard_B2als_v2`, 2 vCPU / 4 GiB, Linux | **$31.32** | derived: `$0.0429/hr × 730` | [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20armSkuName%20eq%20'Standard_B2als_v2'%20and%20priceType%20eq%20'Consumption') |
| OS + data disk | Standard SSD E6, 64 GiB | **$5.76** | quoted, already monthly | [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20meterName%20eq%20'E6%20LRS%20Disk') · [human-readable](https://azure.microsoft.com/en-us/pricing/details/managed-disks/) |
| Egress bandwidth | First 100 GB/mo free, then $0.08/GB | **~$0** | assumption | [Azure bandwidth pricing](https://azure.microsoft.com/en-us/pricing/details/bandwidth/) — see note below |
| Backup blob storage | 10–20 GB of dumps | **~$2** | assumption | [Azure Blob Storage pricing](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) |
| TLS, DNS, Postgres | Caddy, hotel DNS, container | **$0** | — | No vendor involved |
| | **On-demand total** | **~$39** | derived: `31.32 + 5.76 + 0 + 2` | |
| | **With 1-yr reserved instance** | **~$27** | estimate | [Azure Reserved VM Instances](https://azure.microsoft.com/en-us/pricing/reserved-vm-instances/) — confirm the Qatar Central rate in the portal |

**On the egress assumption:** the member app is a static bundle of roughly 1.5 MB,
served to hundreds of members a few times a day. That is single-digit GB a month,
under Azure's 100 GB free allowance. If a marketing push or an uncached asset
changes that, the meter is $0.08/GB and it would take 500 GB of traffic to add
$40. Worth watching, not worth modelling now.

**On the reserved-instance figure:** this is the one number in the table I could
not pull from the API — reservation pricing is not exposed on the public retail
endpoint the way on-demand is. The ~30% saving is Azure's published typical range,
so treat $27 as an estimate and confirm the actual Qatar Central rate in the
portal before committing to a year.

The VM matches `DEPLOYMENT.md` §2's "2 vCPU, 4 GB RAM, 40 GB disk" exactly. It is
generous for hundreds of members — the load is a few hundred API calls a day and
a QR payload that rotates every 60 seconds.

Premium SSD instead of Standard SSD costs
[**$11.14/mo** for P6, 64 GiB](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20meterName%20eq%20'P6%20LRS%20Disk')
and buys IOPS this workload will not use. Take it only if a restore drill shows
disk is the bottleneck.

## AWS — if there is a reason

| Region | Instance | On-demand | 1-yr reserved | Source |
|---|---|---:|---:|---|
| `me-central-1` (UAE) | `t4g.medium`, 2 vCPU / 4 GiB | $29.78 | $18.76 | [ec2.shop](https://ec2.shop?region=me-central-1&filter=t4g.medium) |
| `me-central-1` (UAE) | `t3.medium`, 2 vCPU / 4 GiB | $36.65 | $23.07 | [ec2.shop](https://ec2.shop?region=me-central-1&filter=t3.medium) |
| `me-south-1` (Bahrain) | `t4g.medium`, 2 vCPU / 4 GiB | $29.35 | $18.47 | [ec2.shop](https://ec2.shop?region=me-south-1&filter=t4g.medium) |

ec2.shop is a third-party mirror of AWS's public price list, chosen because it is
directly linkable and AWS's own calculator is not. **Confirm against
[AWS's own on-demand pricing page](https://aws.amazon.com/ec2/pricing/on-demand/)
or the [AWS Pricing Calculator](https://calculator.aws/) before committing** —
those are authoritative, ec2.shop is convenient.

Add ~$4/mo for 40 GB gp3 and egress at ~$0.11/GB
([AWS EC2 on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/)).
**Call it $35–45/mo on-demand, $25–30 reserved** — derived from the table plus
storage and transfer.

AWS operates no Qatar region; the nearest are UAE and Bahrain
([AWS global infrastructure](https://aws.amazon.com/about-aws/global-infrastructure/regions_az/)),
so this option costs the same and gives up the in-country argument. Reserved
pricing is the one genuine AWS advantage here — `$18.76` against Azure's estimated
`$27` is about **$8/month**, and it is real if the programme is definitely running
for a year. It is $8.

## What managed infrastructure would cost instead

| Option | Monthly | Kind | Source |
|---|---:|---|---|
| Azure Postgres Flexible Server B1MS | +$16.06 compute, storage extra | derived: `$0.022/hr × 730` | [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20serviceName%20eq%20'Azure%20Database%20for%20PostgreSQL'%20and%20meterName%20eq%20'B1MS') |
| Azure Postgres Flexible Server B2S | +$64.24 compute, storage extra | derived: `$0.088/hr × 730` | [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20'qatarcentral'%20and%20serviceName%20eq%20'Azure%20Database%20for%20PostgreSQL'%20and%20meterName%20eq%20'B2S') |
| Managed containers + managed Postgres | $80–150 | estimate | [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/) — depends on scale-to-zero behaviour, so a range not a figure |

Both Postgres rows break R7 unless the roles are created by hand. `ROADMAP.md` §7
already reaches this conclusion: everything is containerised, so moving up is easy
later and costs nothing to defer.

---

# 3. SMS — the line that scales

`OTP_DELIVERY_CHANNEL` decides this, and the decision is worth more than every
other cost choice in this document combined.

**[Twilio to Qatar: $0.2634 per outbound segment.](https://www.twilio.com/en-us/sms/pricing/qa)**
Number lease from
[$1.15/mo](https://www.twilio.com/en-us/sms/pricing/qa) if you use a long code
rather than a registered alphanumeric sender ID.

**Every figure in the table below is derived, not quoted.** The formula is:

```
segments/mo = members × 1 passcode/month × 1.25 retry factor
cost/mo     = segments × $0.2634
```

The three assumptions in that formula, stated so you can disagree with them:

1. **One passcode per member per month.** Members hold a 30-day sliding refresh
   token (`REFRESH_TOKEN_TTL_MEMBER_SECONDS=2592000` in `.env.example`), so an
   active member who opens the app monthly never re-authenticates. This is the
   floor, not the average.
2. **A 25% retry factor** for resends and failed deliveries. A guess, bounded by
   `RATE_LIMIT_OTP_REQUEST_PER_IDENTIFIER_MAX=3`.
3. **One segment per message.** True only for short Latin-script bodies — see
   below.

| Members | Segments/mo | SMS cost/mo | Arithmetic |
|---:|---:|---:|---|
| 10 (pilot) | 13 | **$3** | `10 × 1.25 × $0.2634` |
| 100 | 125 | **$33** | `100 × 1.25 × $0.2634` |
| 300 | 375 | **$99** | `300 × 1.25 × $0.2634` |
| 1,000 | 1,250 | **$329** | `1000 × 1.25 × $0.2634` |

Four weeks of pilot delivery logs will replace assumption 1 with a real number,
and that is the main reason to run the pilot before choosing a channel.

## Three things that quietly double this

- **Arabic bodies.** UCS-2 encoding cuts the segment budget from 160 characters to
  70 ([Twilio — message segmentation](https://www.twilio.com/docs/glossary/what-sms-character-limit)).
  A bilingual passcode message is two segments, not one, and the bill doubles with
  no visible change. Keep the passcode SMS to one short Latin-script segment.
- **Onboarding sends.** Each new member's claim-code activation is an extra send.
  One-off per member, but it lands in the month you recruit.
- **Retry loops.** A member who does not receive the first code requests a second.
  `RATE_LIMIT_OTP_REQUEST_PER_IDENTIFIER_MAX=3` caps this per window, which is a
  cost ceiling as well as a security control.

## What to do about it

**Email passcodes cost approximately nothing and the code already supports them.**
`OTP_DELIVERY_CHANNEL=smtp` is implemented and shipping. Transactional email is
free below 3,000 messages a month on
[Resend](https://resend.com/pricing), and
[Amazon SES](https://aws.amazon.com/ses/pricing/) charges $0.10 per 1,000 emails —
so 375 passcodes a month is **under $0.04** against **$99** by SMS.

The options, cheapest first:

1. **Email-first, SMS only for members with no email on file.** Cuts the line by
   perhaps 80%. Costs one conditional in the sender.
2. **Let the member choose at activation.** More product work, better experience,
   similar saving.
3. **Price a regional provider.** [Unifonic](https://www.unifonic.com/), or bulk
   SMS direct from Ooredoo or Vodafone Qatar, will beat $0.2634 substantially at
   volume — none publish list pricing, so this needs a quote. `ROADMAP.md` §4
   already says to build behind a single `SmsSender` interface for exactly this
   reason: switching provider is meant to be one file.
4. **Twilio for everything.** Simplest, most expensive. Fine for the pilot at $3.

Note that staff MFA is **TOTP via `otplib`**, not SMS (`ROADMAP.md` §5). Staff
authentication adds $0 regardless of headcount. That was a security decision, but
it is also a cost decision worth knowing you already made.

---

# 4. Getting into the stores

## Google Play — cheap and quick

A Trusted Web Activity wraps the existing PWA. Play accepts it; the app is
genuinely the site, verified by a digital asset link, with no browser chrome.

- **[$25 one-time](https://support.google.com/googleplay/android-developer/answer/6112435)**,
  plus **days** of engineering (estimate, not sourced — it is our own build time)
- [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) generates the
  project; no Mac required
- Organisation account may skip the 12-tester requirement — see §1 for why that
  is an inference rather than a guarantee

## Apple — the expensive one, and not because of the fee

Apple does not accept PWAs, and
[guideline 4.2, Minimum Functionality](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality)
rejects apps that are a repackaged website. The app must do something a browser
cannot.

**[Capacitor](https://capacitorjs.com/)** wraps the existing React member app and
adds push notifications, biometric unlock on the digital card, Wallet pass and
native camera — which is both what makes it pass review and what makes it worth
shipping. One codebase; the member app keeps working as a website.

| Item | Cost | Kind | Source |
|---|---:|---|---|
| Apple Developer Program | $99/year | quoted | [Apple — Compare Memberships](https://developer.apple.com/support/compare-memberships/) |
| Capacitor integration + native features | **weeks of engineering** | estimate | Our own build time — no vendor to link |
| A Mac to build on, if there is not one | $0, or from $599 | quoted | [Apple — Mac mini](https://www.apple.com/mac-mini/) |
| Cloud Mac CI instead of hardware | $0–40/mo | quoted | [Codemagic](https://codemagic.io/pricing/) and [Expo EAS](https://expo.dev/pricing) both have free tiers that cover this volume |
| Store assets — screenshots, icons | $0 in-house, $100–500 outsourced | estimate | Market rate, not a quoted price |

**React Native is the alternative and it is months, plus a second codebase to keep
in step with the API.** `ROADMAP.md` §9 recommends against it unless Q4's in-app
reservations turn the member app into something much larger. Nothing in this cost
analysis changes that.

## What does not go to a store

Only the member app ships. The admin dashboard and the verify page are internal
surfaces restricted by source address at the reverse proxy — they have no store
presence, no store fees, and no store review.

## Wallet passes deserve their own decision

The pass is $0 in fees — the certificate comes with the $99 membership. The cost
is that **this card's QR rotates**, so the pass must be updated remotely via APNs,
which means implementing
[Apple's pass update web service](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes).
Issuing a longer-lived credential instead is cheaper and weakens exactly the
property §5 of the product definition says matters most. `ROADMAP.md` §9 is right:
decide this deliberately, do not drift into it.

---

# 5. Everything else

| Item | Monthly | Kind | Source |
|---|---:|---|---|
| Transactional email | $0–15 | quoted | [Resend](https://resend.com/pricing) free to 3,000/mo · [Amazon SES](https://aws.amazon.com/ses/pricing/) $0.10/1,000 |
| Google Sheets API (Stage 26 mirror) | $0 | quoted | [Sheets API is free within quota](https://developers.google.com/sheets/api/limits) |
| Uptime monitoring | $0 | quoted | [UptimeRobot free tier](https://uptimerobot.com/pricing/) |
| Error tracking | $0 | quoted | [Sentry Developer plan, free](https://sentry.io/pricing/) |
| Backup storage | ~$2 | assumption | Counted in §2, not double-counted here |

## Unpriced, and it blocks launch

**The DPIA and the privacy policy.** `SECURITY-REVIEW.md` §10 records the DPIA as
required before launch and explicitly not an engineering task. The member profile
screen already links to a privacy policy and terms whose content does not exist,
and both stores require a privacy policy at a public URL before they will accept a
submission — [Apple](https://developer.apple.com/app-store/app-privacy-details/),
[Google Play](https://support.google.com/googleplay/android-developer/answer/10787469).

This needs someone competent in
[Qatar's Personal Data Privacy Protection Law, Law No. 13 of 2016](https://assurance.ncsa.gov.qa/en/privacy/law),
published by the NCSA — which is the supervisory authority you would actually be
answerable to. Given §9's confidentiality analysis it is real rather than a
formality.

**I have deliberately put no number on this.** Legal fees in this region are not
published anywhere I could link, and inventing a figure would be the one unsourced
number in the document. It is likely the largest single one-off line in the budget.
Get two or three quotes, and start early — it gates the store submissions, not
just the launch.

---

# 6. Three budgets

Every total here is **derived**. The components link to their sources above.

## Phase 1 — Pilot: one outlet, ten members, four weeks

| Line | Monthly | Where it comes from |
|---|---:|---|
| Azure Qatar Central VM + disk + backup | $39 | §2 — `$31.32 + $5.76 + ~$2` |
| SMS passcodes (10 members) | $3 | §3 — `10 × 1.25 × $0.2634` |
| Domain, TLS, email, Sheets, monitoring | $0 | §1 and §5 |
| **Total** | **~$42/mo** · QAR 153 | `$39 + $3`, QAR at [3.64](https://www.qcb.gov.qa/en/exchange-rates) |

No store fees. No commitment. `ROADMAP.md` §10 argues for exactly this shape —
one outlet, ten members, four weeks — and at $42 a month it is cheap enough that
there is no financial argument against running it properly before launching.

## Phase 2 — Public launch, PWA only, ~300 members

| Line | Monthly | Where it comes from |
|---|---:|---|
| Hosting (on-demand $39 / reserved $27) | $27–39 | §2 |
| SMS passcodes, all-SMS | $99 | §3 — `300 × 1.25 × $0.2634` |
| *— or email-first, ~80% diverted* | *$20* | §3 — `$99 × 0.2`, assumption |
| Transactional email | $0–15 | §5 |
| **Total, all-SMS** | **~$140–155/mo** · QAR 510–564 | |
| **Total, email-first** | **~$50–75/mo** · QAR 182–273 | |

The passcode channel decision is worth ~$80/month here. It is worth more than the
hosting decision, the region decision and the reserved-instance decision put
together.

## Phase 3 — Both stores, ~300 members

| Line | Amount | Where it comes from |
|---|---:|---|
| Phase 2 recurring | $140–155/mo | above |
| Apple Developer Program | $99/yr = $8/mo | §1, `$99 ÷ 12` |
| **Recurring total** | **~$150–165/mo** · QAR 546–601 | |
| Google Play, one-time | $25 | §1 |
| Apple, year one | $99 | §1 |
| Mac hardware, if needed | $0–599 | §4 |
| Store assets | $0–500 | §4, estimate |
| **One-time total** | **$124–1,223** | `$25 + $99 + $0–599 + $0–500` |

**Year one, all in, excluding legal and engineering time: roughly $1,900–3,200**
(QAR 6,900–11,650) — derived as `12 × $150–165 + $124–1,223`. The spread is almost
entirely Mac hardware and outsourced store assets, both avoidable.

---

# 7. Sequence, and what each step gates

The order matters because the slow items are administrative, not technical.

**Start now, because they have lead times and cost nothing:**

1. Confirm whether the hotel group already holds a D-U-N-S number
   ([Apple's lookup](https://developer.apple.com/support/D-U-N-S/)) — collapses
   weeks into a day if it does
2. Open the [Google Play organisation account, $25](https://support.google.com/googleplay/android-developer/answer/6112435) —
   verification runs in the background, and **ask Play support in writing whether
   the closed-testing requirement applies to you** (§1)
3. Commission the DPIA and the privacy policy — the longest pole, and it gates
   both store submissions

**Then, in order:**

4. Provision the Qatar VM and run the pilot at ~$42/mo (`DEPLOYMENT.md`)
5. Decide the passcode channel on four weeks of real pilot delivery data — this
   is the ~$80/month decision, and the pilot is what replaces the assumption
6. Ship the Play TWA — days of work, $0 beyond the $25 already spent
7. Enrol in the [Apple Developer Program, $99](https://developer.apple.com/support/compare-memberships/),
   only when Capacitor work is genuinely scheduled — the year starts at enrolment,
   so do not start it early
8. Build the Capacitor shell with push, biometrics and camera, then submit
9. Take the 1-year reserved instance once the programme has committed to a year —
   and confirm the real Qatar Central reservation rate in the portal first, since
   that is the one figure in §2 I could not pull from the API

**Do not do yet:** managed Postgres, managed containers, Wallet passes, React
Native. Each costs money now and solves a problem this programme does not have.

---

# 8. The three figures I could not fully source

Stated plainly so they are not mistaken for quoted prices:

1. **Azure 1-year reserved instance, ~$27/mo.** Reservation pricing is not on the
   public retail API. Confirm in the Azure portal.
2. **Legal and DPIA.** No published rates exist to link. Get quotes.
3. **Engineering time** (Capacitor weeks, TWA days, store assets). Our own
   estimates, not vendor prices.

Everything else in this document links to the page or API response it came from.
