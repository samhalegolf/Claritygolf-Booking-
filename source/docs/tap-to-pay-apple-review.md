# Tap to Pay on iPhone: getting through Apple review

What Apple looks for when it reviews a Tap to Pay app, where Clarity Booking
stands on each, and what to send the reviewer. Setup (entitlement, signing,
Stripe) is in [stripe-terminal-ios-setup.md](stripe-terminal-ios-setup.md).

Apple's rules live in two places; read both before submitting, as they change:

- Human Interface Guidelines › Technologies › Tap to Pay on iPhone
- developer.apple.com/tap-to-pay/marketing-guidelines

## Checklist

| Apple wants | Where Clarity is |
| --- | --- |
| **The right name.** The checkout button says "Tap to Pay on iPhone", not a home-made name like "Tap card". | Done. The checkout and Sell screen buttons say **Tap to Pay on iPhone**. |
| **"How to Tap" education** before the first payment, using Apple's own guide (`ProximityReaderDiscovery`, iOS 18+), with a fallback on older iOS. | Done. **How to tap** on the tap screen and in Settings shows Apple's guide; before iOS 18 it shows a one-line instruction instead. It also opens on its own straight after **Set up this iPhone**. |
| **Terms accepted before the first sale**, not with a customer waiting. | Done. Settings › Billing › **Tap to Pay on iPhone › Set up this iPhone** connects the phone, which is when Apple shows its terms and does its one-off setup. |
| **Easy to find** for merchants: in settings, not only in checkout. | Done. The Settings card shows only inside the iPhone app, for a Clarity Pay business, on an iPhone that can do it. |
| **Hidden where it can't work** (older iPhone, no entitlement, business not on Clarity Pay). | Done. Every Tap to Pay control is hidden unless the phone and the server both say yes. |
| **Clear outcome for every tap**: success, declined, cancelled, still checking. | Done. The tap screen never says "failed" once a card may have been charged; it says **Checking payment… Do not charge again yet**. |
| **Location permission explained.** | Done. `NSLocationWhenInUseUsageDescription` in `Info.plist`. |
| **Short waits.** Connect in the background when the app opens and reconnect when it comes back to the foreground. | Done. Once a phone has been set up, it connects quietly when a coach opens the app and again whenever the app comes back to the front. A phone never set up is left alone, so Apple's terms only appear when the coach asks for them. |
| **Apple's icon** for Tap to Pay on the checkout button. | **Check.** The app uses a generic contactless icon. Apple's guidelines point to its own symbol; if the reviewer asks, the native shell would need to supply it, since the web page can't use Apple's system symbols. |
| **Localised name.** | **Check.** The button name is translated using the names Apple uses in each country (for example "Tap to Pay auf dem iPhone"). Compare them with Apple's marketing guidelines before launching in a new language. |

## Before you submit

1. Apple has granted the **distribution** Tap to Pay entitlement for
   `app.claritygolf.booking`, and the build is signed with it.
2. **Test mode is set up on Clarity's Stripe platform** (the test webhook and
   the three test keys in Netlify, see `STRIPE_BILLING_SYNC_HANDOVER.md`). The
   reviewer must be able to take a payment without real money moving.
3. A **demo business** in test mode, on Clarity Pay. Set up 2026-10-03:
   - login `appreview@claritygolf.app` (password in App Store Connect only),
     owner of **Clarity Demo Golf** (`clarity-demo-golf`), a live business that
     takes no payments itself;
   - its sandbox, **Demo Golf (Sandbox)** (`clarity-demo-golf-sandbox`), is
     where the reviewer works. Stripe runs in test mode there;
   - the sandbox's Demo Range has a full street address, and it has three
     products (range bucket, glove, balls);
   - still to do: **Set up Clarity Pay** inside the sandbox (Stripe's test
     signup) so Tap to Pay shows.
4. Build and run on a real iPhone: **Set up this iPhone** → **How to tap** →
   a sale → **Tap to Pay on iPhone** → a Stripe test card → receipt →
   **Refund** in Billing › Transactions.
5. Screenshots or a short screen recording of that flow. Apple often asks for
   one with Tap to Pay apps.

## Notes for the reviewer (App Store Connect › App Review Information)

Fill in the login and paste this. Keep it short; reviewers follow steps.

> Clarity Booking is the staff app for golf coaches. Coaches use Tap to Pay on
> iPhone to take a card payment for a lesson or product at the counter.
>
> The demo account below is a test-mode business: no real money moves, and any
> contactless card or wallet can be used.
>
> 1. Sign in with the demo account. If the bar at the top doesn't say
>    "Sandbox", go to Settings › Sandbox and tap "Enter sandbox".
> 2. Go to Billing › Settings. Under "Tap to Pay on iPhone", tap "Set up this
>    iPhone". Accept Apple's Tap to Pay terms when asked. Apple's "How to Tap"
>    guide then opens; it is also under "How to tap".
> 3. Go to Sell. Add any product, choose Clarity Pay and tap "Complete sale".
>    The Tap to Pay on iPhone screen opens.
> 4. Hold a contactless card or phone near the top of the iPhone. The receipt
>    shows when the payment clears.
> 5. To refund it: Billing › Transactions › Refund.
>
> Tap to Pay needs an iPhone XS or later. Location permission is needed because
> card payments in person require it.
