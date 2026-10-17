# Bloom: business model and requirements

Status: draft. Prices and fees below come from memory as of 2026 and are **not verified** against current Apple, Google, Cloudflare, Stripe or RevenueCat pricing pages. Check them before launch.

## Principles

- Ethical freemium. No ads, no product placement, no dark patterns.
- **Your data is always yours.** No paywall or lockout ever blocks reading, exporting or deleting data the user created.
- Privacy promises in the app must be literally true. If a third party is used, it is disclosed.

## Free preview

- Every feature is available for the first **3 completed brews** (filter or espresso), counted per account. Before sign-in, the count is kept per device.
- After that, **logging new brews** needs Pro. These always stay free:
  - viewing history, charts and the shelf
  - exporting all data (JSON and CSV)
  - deleting your account and data
  - sync of existing data
- The lock is graceful: one calm screen explaining why, the price options, and a "not now" that goes back to read-only.
- No card is required for the preview, and there are no automatic charges after it.

**Requirement:** the counter and entitlement check live in `packages/shared-sync-core`, so web and mobile behave the same. They are covered by tests: brew 3 completes, brew 4 is gated, and export still works while locked.

## Tiers

| Tier | Price (USD) | Notes |
|---|---|---|
| Monthly | $2.49 | Auto-renewing subscription. Cancel anytime. |
| Annual | $19.99 | Auto-renewing, about 33% less than 12 months of monthly. |
| Lifetime | $39.99 | One-time purchase, non-renewing. |

- Monthly and annual are auto-renewing by the store's definition. They must be presented as such, with the renewal date, the price and how to cancel shown before purchase.
- Use the stores' price tiers for each currency (GBP, EUR, AUD, NZD, CAD, SGD, JPY, CNY) and check that they round sensibly.

## Payments and entitlements

- **Stores:** App Store IAP (StoreKit 2) and Google Play Billing.
- **Web:** Stripe Checkout.
- **Entitlement is account metadata.** It is stored in plaintext server-side, separate from the end-to-end encrypted data, because the server must enforce it. It records the tier, source (apple, google or stripe), expiry and the original transaction id. Nothing about brews or coffee is needed.
- A purchase on any platform unlocks Pro on all platforms at the next sync.
- **Verification without depending on store uptime:**
  - StoreKit 2 transactions are JWS signed by Apple and can be verified offline against Apple's certificate chain.
  - Google Play purchases carry an RSA signature that can be verified with the app's public key.
  - The Worker verifies signatures locally and calls the store APIs only to check for refunds or revocations, retrying with backoff.
  - The Worker issues a signed entitlement ticket (Ed25519, about 7 days, renewed at each sync) that the app checks offline.
  - The gate **fails open**: if verification can't complete because of a store outage, a timeout or no network, the user brews.
  - A determined person on a jailbroken device could bypass the gate. At these prices that is accepted, so don't build DRM.
- **Third-party decision (open):**
  - **Option A, RevenueCat:** faster to build. It is a third party that receives an app user id and purchase data. If chosen, add it to the privacy policy and to `tooling/allowed-hosts.json` with a written justification. Free up to about $2.5k MTR (verify).
  - **Option B, direct (preferred):** the Worker validates App Store Server API and Play Developer API receipts, and handles server notifications (App Store Server Notifications v2, Play RTDN) and Stripe webhooks. More work, but no third party sees users.

## Fees

| Channel | Fee | Notes |
|---|---|---|
| Apple | 15% | Enrol in the Small Business Program before the first sale. |
| Google | 15% on subscriptions, and on the first $1M a year | Verify current terms. |
| Stripe | about 2.9% + $0.30 per charge | About 15% on $2.49, so no better than the stores for monthly. It wins on annual (about 4.4%) and lifetime (about 3.7%). |

- Steering is allowed on the website, in email and in community posts. Linking to web purchase from inside the iOS app is allowed on the US storefront. Elsewhere it is restricted or charged (for example the EU DMA terms). Check per region before shipping any in-app link.

## Costs

- **Year 1 fixed:** Apple Developer $99 a year plus Google Play $25 once, $124 in total. After that, $99 a year.
- **Infrastructure:**
  - **Workers Free:** about 100k requests a day.
  - **Sync polling:** about 4 requests a minute while the app is open (15 s polling). A user with the app open for 30 minutes a day makes about 120 requests, so the free tier covers roughly 800 daily active users.
  - **Workers Paid:** about $5 a month, including 10M requests a month, and then about $0.30 per extra million. That is still negligible at thousands of users.
  - **D1:** the free tier has 5 GB of storage. Encrypted shot files are about 5–10 KB each.
  - **Budget:** $5 a month from launch for headroom.
- **Ways to reduce cost:**
  - Poll only while a listener is active and the app is in the foreground.
  - Back off when idle.
  - Later, use one long-lived WebSocket or Server-Sent Events connection through a Durable Object instead of polling.
- **Other costs:** a domain (about $12 a year), email for recovery and receipts (a privacy-respecting provider), and optionally an accountant or merchant-of-record. Stripe makes you the merchant of record for web sales, so VAT and GST collection is on you.

## Break-even (illustrative)

- At 3% conversion of preview users, with the 15% store fee:
  - **Lifetime:** $34 net per sale, so 4 sales cover $124, which is about 134 previews.
  - **Annual:** $17 net per sale, so 8 sales, about 243 previews.
  - **Monthly:** about $2.12 net a month per subscriber, so 5 subscribers retained for 12 months cover it.
- These numbers ignore refunds, taxes, churn, payment processing on web sales, and your time.

## Legal and compliance to do before launch

- **Privacy policy and store privacy labels:** Apple's nutrition label and Google's Data safety form. These must match the privacy gate.
- **Terms of sale and refund policy.**
- **Account deletion:** in the app, and for a forgotten password, an emailed link with a 7-day cooling-off period (see PLAN.md). Proving ownership of the email is enough, because deleting ciphertext reveals nothing to an attacker. The worst an attacker can do is destroy data, which the cooling-off period and cancellation guard against.
- **GDPR and UK GDPR:** a lawful basis, export and deletion (already planned), a data processing agreement with Cloudflare, and the EU/UK data location question.
- **Encryption export compliance:**
  - Do **not** set `ITSAppUsesNonExemptEncryption = false` by default. Bloom encrypts user data itself (end-to-end), not only through the OS's HTTPS, so "false" may be an incorrect declaration.
  - The likely position is mass-market standard cryptography (AES-GCM, PBKDF2, HKDF), where the app's primary function is not information security. That usually means no CCATS, but possibly an annual self-classification report to BIS and a separate declaration for distribution in France.
  - Confirm with Apple's current export compliance documentation and a lawyer before first submission, then set the plist key to match the answer.
- **Tax:** VAT and GST on web sales, and sales tax. The stores handle tax on their own sales.
- **Trademark search for "Bloom"** before spending on branding, because the name is crowded in coffee.
- **Third-party licences:** GaggiMate is CC BY-NC-SA. Bloom is clean-room and must stay that way. Fonts are OFL. Keep `docs/LICENSES.md` up to date.
