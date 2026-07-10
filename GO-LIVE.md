# Go-Live Checklist — from zero to paying customers

Everything is already built and dormant-safe. When you're ready to market,
work through this list top to bottom. Total time: ~20 minutes.

## 1. Stripe (the only missing piece)

1. Create a Stripe account → https://dashboard.stripe.com
2. Copy the **secret key** (Developers → API keys → `sk_live_...`).
3. Create the webhook: Developers → Webhooks → Add endpoint →
   URL: `https://<your-domain>/api/billing/webhook`
   Events: `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
   Copy the **signing secret** (`whsec_...`).
4. Set both in Vercel (Production) and `server/.env`:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
   Optional: `STRIPE_PRICE_ID=price_...` — if you skip it, the app
   auto-creates a product + monthly price from the landing page's beta price
   ($30) on the first checkout and remembers it.
5. Redeploy. That's it — Subscribe buttons, checkout, the billing portal and
   webhook-driven account status all go live with no code changes.

**Test first with test keys** (`sk_test_...` + test webhook): card
`4242 4242 4242 4242`, any future date, any CVC.

## 2. Tracking (owner dashboard → 🚀 Growth & tracking)

- **GA4**: create a GA4 property → paste the `G-XXXXXXXXXX` Measurement ID.
- **Meta Pixel**: paste your pixel ID.
- **Meta CAPI**: Events Manager → your pixel → Settings → Conversions API →
  Generate access token → paste it (stored encrypted, write-only).
- Events already wired: `sign_up`, `begin_trial`, `begin_checkout`,
  `purchase` (client GA4/pixel + server-side CAPI: StartTrial /
  CompleteRegistration / Subscribe with hashed emails).

## 3. Trials (owner dashboard → 🚀 Growth & tracking)

- Defaults: 7-day trial, max 5 concurrent, max 20 new/month.
- When either cap is hit, the free-trial pitch disappears from the landing
  page and signup automatically; new signups land as "Pending".

## 4. Offers (owner dashboard → 🎯 Offers)

- Three defaults ship (media buying small/large + GTM/CAPI setup), all
  pointing at auto1labs.com with UTM tags. Edit titles/prices/size targeting
  any time — customers see only offers matching their organization size.

## 5. Watch it work (owner dashboard → 📈 Customers)

- Every signup appears with trial status, size, trial end date and users.
- 💬 Feedback tab collects bug reports, feature ideas and auto-captured
  client errors.

## Already handled — nothing to do

- Public signup at `/signup` (company + admin user + trial in one step)
- Trial expiry → "Trial ended" state with Subscribe call-to-action
- Stripe Checkout collects cards (PCI handled by Stripe), portal manages them
- Webhooks flip accounts between active / past_due / canceled automatically
- Resend email, Google sign-in, role hierarchy, demo mode
