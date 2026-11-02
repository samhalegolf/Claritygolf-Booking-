/**
 * The starting content of Clarity's own websites (house sites, see house.mts).
 *
 * Each is an ordinary template, built from ordinary blocks and cleaned like
 * any other, so the page it makes is a page the builder can edit and nothing
 * more. Studio offers it as the first choice when a house site is empty;
 * once chosen it is forgotten, like every template.
 *
 *   house-caddy     what was the clarity-golf-landing site (home and How it
 *                   works) plus the privacy, terms, support and account
 *                   deletion pages Caddy served at caddy.claritygolf.app.
 *   house-booking   what Clarity Booking drew by hand at the root of
 *                   claritygolf.app: home, privacy, terms and support.
 *
 * Pictures point at where they are hosted today. A picture pasted by address
 * is used as given, so replacing one with an upload in the editor is the way
 * to move it into the site's own bucket.
 */

import {
  HOME_PAGE_SLUG,
  cleanSitePageContent,
  cleanSiteSettings,
  pageHref,
  siteId,
  themeFromPreset,
  type SiteBlockInput,
  type SiteFeatureIcon,
  type SitePage,
  type SiteSettings,
} from "./document.mts";
import type { SiteTemplate, SiteTemplateSite } from "./templates.mts";

type Page = SiteTemplateSite["pages"][number];

const CADDY_APP = "https://caddy.claritygolf.app";
const CADDY_ASSETS = `${CADDY_APP}/assets/landing`;
const CADDY_EMAIL = "sam@claritygolf.app";
const CADDY_UPDATED = "Last updated: 19 October 2026";
const CADDY_OPERATOR = "Clarity Golf Systems Limited, Auckland, New Zealand";

const BOOKING_APP = "https://claritygolf.app";
const BOOKING_EMAIL = "support@claritygolf.app";
const BOOKING_UPDATED = "Last updated 30 September 2026";

const button = (label: string, href: string, style: "primary" | "secondary" = "primary") => ({ label, href, style });

function page(slug: string, title: string, blocks: SiteBlockInput[], description: string, inNav = true): Page {
  return { slug, title, kind: "page", inNav, content: cleanSitePageContent({ description, blocks }) } as Omit<SitePage, "id" | "sortOrder">;
}

/** A heading and its paragraphs. Blank lines part paragraphs; a line starting "• " reads as a list item. */
function section(id: string, heading: string, body: string): SiteBlockInput {
  return { id, type: "text", heading, body: body.trim(), align: "left", columns: 1 };
}

/** The top of a legal or help page: its title, the date it last changed, and the opening words. */
function legalHead(eyebrow: string, heading: string, updated: string, intro: string): SiteBlockInput {
  return { id: "top", type: "hero", eyebrow, heading, text: `${updated}\n\n${intro}`.trim(), image: null, shape: "square", layout: "left", height: "regular", buttons: [] };
}

const feature = (icon: SiteFeatureIcon, title: string, text: string) => ({ id: siteId("item"), icon, title, text });

// --- Clarity Caddy ---------------------------------------------------------------

function caddySettings(): SiteSettings {
  const base = themeFromPreset("midnight");
  return cleanSiteSettings({
    theme: {
      ...base,
      headingFont: "inter",
      bodyFont: "inter",
      colors: { background: "#07130d", surface: "#0e2017", text: "#f4fbf6", muted: "#c6d8cc", primary: "#35d27f", onPrimary: "#04170d", accent: "#35d27f", heading: "#f4fbf6" },
      corners: "round",
      buttons: "pill",
    },
    header: {
      showLogo: true,
      showName: true,
      links: [],
      button: button("Open Clarity Caddy", CADDY_APP),
      sticky: true,
      transparent: false,
      social: [],
      shopPage: "",
    },
    footer: {
      text: "Clarity Caddy is operated by Clarity Golf Systems Limited in Auckland, New Zealand. © 2026 Clarity Golf Systems Limited.",
      links: [
        { label: "How it works", href: pageHref("how-it-works") },
        { label: "Privacy Policy", href: pageHref("privacy") },
        { label: "Terms of Service", href: pageHref("terms") },
        { label: "Contact / Support", href: pageHref("support") },
        { label: "Delete your account", href: pageHref("delete-account") },
      ],
      social: [],
      showCredit: false,
    },
  });
}

function caddyHome(): Page {
  return page(
    HOME_PAGE_SLUG,
    "Home",
    [
      {
        id: "hero",
        type: "hero",
        eyebrow: "Clarity Golf",
        heading: "Bring the best of your practice to the golf course",
        text: "Clarity Caddy is a golf GPS and coaching-support app that helps players make clearer on-course decisions.",
        image: { url: `${CADDY_ASSETS}/hero-scene-fitted-right-zone-clean-ball-placed.png`, alt: "Golf ball with dotted shot arc towards a green and translucent custom shot bubble" },
        shape: "square",
        layout: "split",
        height: "tall",
        buttons: [button("Open Clarity Caddy →", CADDY_APP), button("Create account", `${CADDY_APP}/signup`, "secondary")],
      },
      {
        id: "loop",
        type: "cards",
        heading: "Practice leads. The player adopts. The course reports back.",
        intro: "The Clarity Loop: a continuous loop, and you decide when to go back around.",
        columns: 4,
        items: [
          { id: siteId("item"), image: { url: `${CADDY_ASSETS}/shot-practice-data.png`, alt: "Practice Data screen" }, title: "Practice Shot Data", text: "Get honest shot data in, straight from your launch monitor.", button: null },
          { id: siteId("item"), image: { url: `${CADDY_ASSETS}/shot-comparison.png`, alt: "Practice Bubble" }, title: "Practice Bubble", text: "Clarity finds your repeatable outcome zone.", button: null },
          { id: siteId("item"), image: { url: `${CADDY_ASSETS}/shot-gps-play.png`, alt: "GPS Play screen" }, title: "GPS Play", text: "Your adopted Bubble, live on the course.", button: null },
          { id: siteId("item"), image: { url: `${CADDY_ASSETS}/shot-course-data.png`, alt: "Course Data screen" }, title: "Course Data", text: "All three Bubbles, side by side.", button: null },
        ],
      },
      { id: "method", type: "cta", heading: "See the full method", text: "How Clarity turns your practice data into a Bubble, and how the course reports back.", button: button("How it works →", pageHref("how-it-works")), tone: "surface" },
      {
        id: "features",
        type: "features",
        heading: "Clearer decisions before, during, and after the shot.",
        intro: "Golf GPS and coaching support: GPS-based course guidance, golf bag distance setup, player profile tools, practice-data features, and coaching-related decision support.",
        columns: 3,
        items: [
          feature("map-pin", "GPS play tools", "Use course guidance and on-course tools to choose smarter targets and make clearer playing decisions."),
          feature("target", "Golf bag setup", "Set up club distances so the app can support practical decisions around club choice and shot planning."),
          feature("line-chart", "Practice-data tools", "Use practice information to support coaching conversations and connect practice patterns to golf-course decisions."),
        ],
      },
      section(
        "access",
        "Short-term passes and memberships.",
        "Players may purchase short-term access passes or memberships for selected app features, including GPS play tools, practice-data tools, saved player data, and coaching-support features.",
      ),
      { id: "support", type: "cta", heading: "Need help with Clarity Caddy?", text: `Email ${CADDY_EMAIL} and we will get back to you.`, button: button("Contact support", pageHref("support")), tone: "primary" },
    ],
    "Clarity Caddy is a golf GPS and coaching-support app that helps players make clearer on-course decisions.",
  );
}

function caddyHowItWorks(): Page {
  return page(
    "how-it-works",
    "How it works",
    [
      {
        id: "top",
        type: "hero",
        eyebrow: "How it works",
        heading: "Practice data, your Bubble, and the Clarity Loop.",
        text: "The full explanation of how Clarity turns your practice data into a Bubble, how you take that model onto the course, and how Clarity tells the difference between a swing that isn't transferring and a swing that just isn't being managed well.",
        image: null,
        shape: "square",
        layout: "left",
        height: "regular",
        buttons: [],
      },
      section(
        "looking-for",
        "What Clarity is looking for",
        `Clarity is not simply measuring your average shot shape or drawing a conventional dispersion pattern around your existing results. It looks deeper within naturally produced shot data for the key markers that support a viable outcome prediction.

That prediction becomes your Bubble: the area where the ball is likely to finish a statistically significant amount of the time when your swing is operating within the window Clarity has identified as most viable. It will not necessarily follow generic assumptions about shot pattern, average direction or dispersion.

The purpose is not to make a poor swing pattern fit. It is to identify where your swing has the best opportunity to thrive, then give you a practical outcome model that you can build your game around.`,
      ),
      section(
        "collecting",
        "Collecting practice data",
        `A Bubble may not be generated immediately. This does not mean the system has failed or that there is something wrong with your swing. It means Clarity has not yet found enough reliable evidence to produce a prediction it considers viable.

Continued data collection gives the system more opportunities to identify the required markers, and with enough relevant data a Bubble may eventually emerge even when early sessions are inconclusive. However, simply collecting more shots is not always the fastest route to a useful result: the quality and intention of the data matter. Following this protocol gives Clarity the best chance of producing a Bubble sooner and with greater confidence.`,
      ),
      {
        id: "protocol",
        type: "faq",
        heading: "The protocol",
        intro: "",
        items: [
          { id: siteId("item"), question: "Align square to the launch monitor", answer: "Set yourself up with your body aligned straight and square to the launch monitor. This creates a stable reference for the data. The goal is not to perfectly aim every shot at a target; it's to give Clarity a consistent frame of reference from which it can interpret the movement and outcome data. Small changes in how you aim can make otherwise similar swings appear very different." },
          { id: siteId("item"), question: "Do not try to hit the ball straight", answer: "Do not deliberately try to produce straight shots for the test. Trying to straighten the ball can introduce steering, manipulation and compensations that are not representative of the swing you normally produce. Clarity does not need perfect shots; it needs honest shots. Make your normal swing and allow the ball to finish where it finishes." },
          { id: siteId("item"), question: "Avoid correcting the previous shot", answer: "One of the most important parts of the protocol is resisting the urge to react to the previous result. After a poor shot, golfers will often make a conscious correction on the next swing: aim farther in the opposite direction, change the clubface, steer the ball, hold off the release, swing harder or softer, or try to manufacture a different shape. This creates a sequence of reactive swings rather than a useful sample of naturally produced data. Each shot should be treated as independently as possible. Do not chase the previous result. Make your normal swing again." },
          { id: siteId("item"), question: "Reduce target bias", answer: "Visible ball flight can cause a golfer to continuously adjust. A useful way to reduce that target bias is to angle the simulator display down an open section of the virtual driving range rather than aiming directly at a flag, target line or centre marker. An even stronger version of the test is to turn the projector or simulator display off and hit approximately 20 shots without seeing the ball flight. Without immediate visual feedback, the golfer is less likely to steer, compensate or correct the next swing. The purpose is not to hide the result forever; it's to briefly remove the golfer's reaction to the result so the data can show what is being produced without constant intervention." },
          { id: siteId("item"), question: "Use one club at a time", answer: "Collect a meaningful group of shots with one club before changing clubs. Frequent club changes make it harder to identify a stable set of markers. A useful session might include 20 to 40 shots with a 7 Iron, 20 to 40 shots with a longer iron, and 20 to 40 shots with Driver. The exact number is less important than collecting enough honest shots for the system to examine." },
          { id: siteId("item"), question: "Remove only obvious non-shots", answer: "Do not remove every imperfect shot: average shots and normal misses are important parts of the data. However, obvious non-representative shots should be excluded, including complete tops, severe chunks, shanks, practice swings recorded as shots, a ball striking another ball, obvious launch-monitor misreads, and shots interrupted by an external distraction. The intention is not to create a highlight reel; it's to remove events that do not meaningfully represent the swing being tested." },
          { id: siteId("item"), question: "Do not keep only the best shots", answer: "Clarity needs to understand the full useful range of outcomes produced by your swing. Keeping only the shots you liked would create an unrealistic picture. Good shots, average shots and normal misses all contribute useful evidence. The Bubble should be based on what can be reliably produced, not on a collection of isolated perfect strikes." },
          { id: siteId("item"), question: "Collect data across multiple sessions", answer: "A large number of shots from one session can be useful, but data collected over several sessions is often more valuable. Multiple sessions allow Clarity to see whether the relevant markers continue to appear across different days, energy levels and practice environments, helping distinguish a temporary run of shots from something that is genuinely repeatable. The goal is not simply more data. The goal is stronger evidence." },
        ],
      },
      section(
        "practice-bubble",
        "Practice Bubble",
        `The Practice Bubble is created from controlled practice data. Clarity examines the data for the markers that indicate where your swing has the strongest opportunity to produce a viable and repeatable outcome.

• It is not simply an outline around all your shots.
• It is not necessarily centred on the average result.
• It is not designed to preserve a poor pattern just because that pattern appeared frequently.

The Practice Bubble represents the outcome window Clarity believes gives your swing the best chance to thrive.`,
      ),
      section(
        "my-bubble",
        "My Bubble",
        `When you intentionally adopt a Practice Bubble, it becomes My Bubble: the model you choose to take onto the golf course. It represents:

• The orientation you intend to trust
• The outcome window you intend to play around
• The relationship between your alignment and expected result
• The strongest usable prediction found in practice

My Bubble is not automatically rewritten every time you play. That is deliberate. Clarity is built around taking practice to the course, not allowing unpredictable course results to continually redefine what was found in practice.

Practice establishes the model. You adopt that model intentionally. The course then shows how well you are implementing it.`,
      ),
      section(
        "course-data",
        "Course Data",
        `Course Data records what actually happened during real golf. Its role is not to directly create, improve or replace My Bubble. It provides feedback on how successfully you are transferring My Bubble into real play.

This is a critical distinction. Clarity does not use random on-course outcomes to pull your practice model in different directions. Instead, Course Data helps show whether the same underlying markers found in practice are still present when you play. You are still the same golfer who produced the shots used to generate the Practice Bubble. The course introduces new variables, but it does not turn you into a different person.

Normalising Course Data

Raw on-course results rarely tell the full story. A shot hit with a short iron in calm conditions is not directly comparable with a longer club hit into wind from a sloping lie. Where the required data is available, Clarity adjusts and normalises results across clubs and measurable playing variables, including club selection, wind, slope, distance, playing conditions and other relevant environmental influences.

The purpose is not to pretend those variables did not exist; it's to separate their effect from the underlying swing as clearly as possible. This helps Clarity answer a much more useful question than simply whether the shot missed: is the swing itself holding the player back, or is the difficulty coming from how the player is adapting that swing to real course variables? Those are different problems and require different solutions.`,
      ),
      {
        id: "course-bubble",
        type: "features",
        heading: "Understanding the Course Bubble",
        intro: "Course Data can produce a Course Bubble for comparison with My Bubble. This comparison can lead to three main outcomes.",
        columns: 3,
        items: [
          feature("award", "1. Larger, but with the same orientation", "Often a positive result. Wind, slopes, lies, pressure and normal variation widen the outcome area on the course, but a similar orientation shows the markers found in practice are still present. This is the ideal Clarity outcome: practice found a viable window, the player trusted it, and the same orientation appears in real golf."),
          feature("target", "2. A reasonable size, but a different orientation", "The player may be producing a consistent outcome on the course, but not the one identified in practice: different alignment habits, steering, not fully trusting My Bubble, or reacting to wind or slope incorrectly. Not proof the swing is poor; the transfer from practice to play has changed, which is worth investigating with a coach."),
          feature("shield", "3. Random or statistically unusable", "Sometimes Course Data is too scattered to produce a meaningful Course Bubble, and Clarity treats the result as null rather than force a conclusion. More data may be needed, or alignment and intentions are changing shot to shot. A null Course Bubble does not replace or rewrite My Bubble."),
        ],
      },
      section(
        "swing-or-adaptation",
        "Swing or adaptation?",
        `The normalised comparison between My Bubble and Course Data creates one of Clarity's most valuable insights: it helps separate two very different limitations.

The swing is not transferring. The underlying orientation or markers found in practice are no longer visible on the course. This may point towards alignment changes, loss of trust, steering, a different swing intention, pressure-related changes, or a need for coaching investigation.

The swing is transferring, but adaptation is poor. The underlying model remains present, but the player is not managing course variables effectively. This may point towards poor wind or slope adjustment, club-selection errors, misjudged distance, poor target selection, misunderstanding how the Bubble should be positioned, or course-management decisions that expose too much risk.

The distinction matters. A player should not rebuild a functioning swing to solve a wind, alignment or decision-making problem. Likewise, better course management cannot fully compensate for a swing model that is not transferring at all. Clarity helps show where the limitation is actually coming from.`,
      ),
      section(
        "the-loop",
        "The Clarity Loop",
        `Practice Data → Practice Bubble → My Bubble → Course Data → Transfer Feedback

Practice Data: you collect honest, naturally produced shot data with as little steering, correction and target bias as possible.

Practice Bubble: Clarity identifies the markers that indicate where your swing has the strongest opportunity to thrive.

My Bubble: you intentionally adopt that model and take it onto the golf course.

Course Data: Clarity records what happened in real play and normalises the results where possible across clubs and measurable conditions.

Transfer Feedback: the Course Bubble shows whether you are successfully implementing My Bubble, whether your orientation has changed, or whether the on-course data is too random to be useful.

Practice leads. The player adopts. The course reports back.

The course does not redefine the swing. It shows how well the golfer is bringing the best evidence found in practice into real golf. That is the purpose of the Clarity Loop: it connects practice, trust, decision-making and on-course performance in a way that helps the player understand not just where the ball went, but why their best golf is, or is not, making it onto the course.`,
      ),
      { id: "start", type: "cta", heading: "Start your loop", text: "Bring your practice data into Clarity Caddy.", button: button("Open Clarity Caddy →", CADDY_APP), tone: "primary" },
    ],
    "How Clarity turns your practice data into a Bubble, how you take it onto the course, and how the course reports back.",
  );
}

function caddyPrivacy(): Page {
  return page(
    "privacy",
    "Privacy Policy",
    [
      legalHead(
        "Clarity Caddy",
        "Privacy Policy",
        CADDY_UPDATED,
        "Clarity Caddy is operated by Clarity Golf Systems Limited, based in Auckland, New Zealand. This policy explains what information the app collects, why, who processes it on our behalf, how long it is kept, and how to get it deleted.",
      ),
      section(
        "law",
        "",
        "We handle personal information in line with the New Zealand Privacy Act 2020. If you use the app from outside New Zealand, your information is stored and processed on servers that may be located overseas.",
      ),
      section(
        "collect",
        "What we collect",
        `• Email address and name: to create and manage your account and sign you in.
• Password, stored only as a salted hash and never in readable form: to secure your account.
• Player profile details and golf bag club distances: to scale distance suggestions to your own game.
• Practice records, including launch monitor readings you scan or import: to build your practice pattern and compare it with how you play.
• Round, score and shot records: to track your play and improve your playing model.
• Course maps and on-course captures you create: to let you map and play courses that are not yet in the library.
• Location while you are playing: to show distances to the green. See below.
• Paid access status and purchase records: to manage membership and passes. We never receive or store your full card number.
• Support messages you send us: to answer your question.
• Referral invitations and rewards, if you use them: to credit referrals correctly.
• Technical error reports: to find and fix crashes and faults.`,
      ),
      section(
        "location",
        "Location",
        `Clarity Caddy uses your device location only while the app is open and you are using it. It does not track your location in the background, and it does not collect location when the app is closed.

Location is used on your device to calculate distances as you play. Where you save a round, shot or course map to your account, the records you save may include course positions so that they can be shown back to you later.

Your location is never sold, never used for advertising, and never shared with other players.`,
      ),
      section(
        "camera",
        "Photos and camera",
        "The app can use your camera or photo library so you can add a profile photo and capture launch monitor readouts. Images are used to read the numbers from the readout and to store the profile photo you chose. The app does not scan or upload photos you have not selected for these purposes.",
      ),
      section(
        "processors",
        "Who processes your information",
        `We use the following providers to run the service. They process information on our behalf and are not permitted to use it for their own purposes.

• Supabase: database and account authentication
• Netlify: website and application hosting, server functions and file storage
• Stripe: payment processing for purchases made on the website
• RevenueCat: validating and managing purchases made inside the mobile apps
• Apple App Store and Google Play: processing in-app purchases you make on your phone
• Resend: sending account and support emails

Payment card details are handled by Stripe, Apple or Google directly. Clarity Caddy never receives your full card number.

While you are playing, your device also requests map imagery, course outlines, and weather or elevation data from third-party services, including Esri/ArcGIS, OpenStreetMap and the Overpass API, and Open-Meteo. These requests come from your device, so those services can see your device's network address and the general area you are requesting maps for. We do not send them your account details.

We do not sell your personal information, and we do not share it with advertisers.`,
      ),
      section(
        "retention",
        "How long we keep it",
        `We keep your account information and the golf data attached to it for as long as your account is open, because that history is what the app's playing model is built from.

If you delete your account in the app, your account and golf records are removed straight away. If you ask us by email instead, we remove them from our live systems within 30 days. Copies may remain in encrypted backups for up to 12 months, after which they are overwritten. We keep a minimal record of purchases for as long as tax and accounting law requires, even after an account is deleted.`,
      ),
      section(
        "rights",
        "Your rights",
        `You can ask us to:

• send you a copy of the personal information we hold about you;
• correct anything that is wrong;
• delete your account and the information attached to it;
• delete your golf data on its own, and keep your account.

You do not have to choose between keeping your history and keeping your account. Settings → Clear my golf data in the app permanently deletes your rounds, scores, shots, practice records, launch monitor imports and saved course captures, while your account, sign-in, player profile, bag setup and any paid membership carry on as normal.

To delete your account, see the Delete your account page, which also explains clearing your golf data. For anything else, email ${CADDY_EMAIL} and we will respond within 20 working days.`,
      ),
      section(
        "security",
        "Security",
        "Traffic between the app and our servers is encrypted using HTTPS. Passwords are stored only as salted hashes and cannot be read by us. Data held by our providers is encrypted at rest. No system is perfectly secure, but if a breach affects you we will notify you and the Office of the Privacy Commissioner as the Privacy Act requires.",
      ),
      section("children", "Children", "Clarity Caddy is not intended for children under 13, and we do not knowingly collect information from them. If you believe a child has created an account, email us and we will remove it."),
      section("changes", "Changes to this policy", "If we change this policy we will update the date at the top of this page. Significant changes will be notified in the app or by email."),
      section("contact", "Contact", `${CADDY_OPERATOR}\nEmail: ${CADDY_EMAIL}`),
    ],
    "What Clarity Caddy collects, why, who processes it, how long it is kept, and how to get it deleted.",
    false,
  );
}

function caddyTerms(): Page {
  return page(
    "terms",
    "Terms of Service",
    [
      legalHead(
        "Clarity Caddy",
        "Terms of Service",
        CADDY_UPDATED,
        "Clarity Caddy is a golf GPS and coaching-support app operated by Clarity Golf Systems Limited in Auckland, New Zealand. By creating an account or using the app you agree to these terms.",
      ),
      section(
        "what",
        "What the app does",
        `Players may use Clarity Caddy to support golf GPS play, golf bag distance setup, player profile tools, practice-data features, saved player data, and coaching-related decision support.

Clarity Caddy is designed to support golf decisions, but players remain responsible for their own choices, safety, course rules, device use, and compliance with local conditions. Distances, course maps and weather information are estimates and may be inaccurate or out of date. Do not rely on them where safety depends on it.`,
      ),
      section(
        "paid",
        "Paid access",
        `Some features require paid access. Two options are offered:

• Month Pass: 30 days from purchase. A one-off purchase that does not renew. Access ends when the 30 days are up.
• Monthly Membership: 1 month. Renews automatically each month until cancelled.

Prices are shown in the app before you confirm, in your local currency where the store supports it. Paid access gives you access to the app features selected for that option, for the relevant period.`,
      ),
      section(
        "renewal",
        "Automatic renewal",
        `This section applies to the Monthly Membership when purchased inside the iOS or Android app.

• Payment is charged to your Apple ID or Google Play account when you confirm the purchase.
• The subscription renews automatically for a further month unless you turn off automatic renewal at least 24 hours before the end of the current period.
• Your account is charged for the renewal within the 24 hours before the current period ends, at the price shown for the next period.
• You can view, manage and cancel the subscription at any time in your App Store account settings (iOS) or in Google Play subscriptions (Android). Deleting the app does not cancel a subscription.
• Cancelling stops future renewals. You keep access until the end of the period you have already paid for, and part-periods are not refunded.

Purchases made inside the app are handled by Apple or Google, and billing questions and refunds for those purchases are subject to their policies. Where you bought access somewhere other than inside the app, contact us and we will help with it directly.`,
      ),
      section(
        "referrals",
        "Referrals and free months",
        `Members may be able to invite other players and give them a free month of Membership, and may earn free months themselves when someone they invited becomes a paying member.

• A free month is granted by us as access to the app. It is not a subscription, nothing is charged for it, and it does not renew or turn into a paid membership by itself. If you want to continue afterwards you choose to buy access.
• Free months have no cash value, cannot be sold, exchanged or transferred, and are not refundable.
• Invitations are for real players you know. We may withhold, reverse or cancel rewards, and close the accounts involved, where invitations are used to create fake or duplicate accounts or otherwise game the scheme.
• Unused free months end when your account is closed.
• We may change or end the referral scheme. Free months already given to you will be honoured.`,
      ),
      section(
        "account",
        "Your account",
        `You are responsible for keeping your sign-in details secure and for activity on your account. Do not share your account with others. Tell us promptly if you think someone else has access to it.

You can delete your account at any time (see the Delete your account page). We may suspend or close an account that is being used to break these terms, to abuse the referral system, or in a way that harms the service or other players.`,
      ),
      section(
        "content",
        "Your content",
        "Rounds, scores, shots, practice records, course maps and captures you create stay yours. You give us permission to store and process them so the app can show them back to you and build your playing model. We do not sell them or use them for advertising.",
      ),
      section(
        "availability",
        "Availability",
        "We aim to keep the service running but do not guarantee it will be uninterrupted or error-free. Features may change, and third-party map, weather and elevation services the app depends on may change or become unavailable. We may update or discontinue features; where a change materially reduces what you have paid for, contact us.",
      ),
      section(
        "consumer",
        "Consumer rights",
        "Nothing in these terms limits your rights under the New Zealand Consumer Guarantees Act 1993 or the Fair Trading Act 1986, or under equivalent consumer law where you live, where those rights cannot lawfully be excluded. To the extent the law allows, our liability for any claim connected with the app is limited to the amount you paid us for it in the 12 months before the claim.",
      ),
      section("privacy", "Privacy", "How we handle your information is set out in the Privacy Policy, which forms part of these terms."),
      section(
        "changes",
        "Changes to these terms",
        "If we change these terms we will update the date at the top of this page. Significant changes will be notified in the app or by email. Continuing to use the app after a change means you accept the updated terms.",
      ),
      section("law", "Governing law", "These terms are governed by New Zealand law, and the New Zealand courts have non-exclusive jurisdiction over any dispute."),
      section("contact", "Contact", `${CADDY_OPERATOR}\nEmail: ${CADDY_EMAIL}`),
    ],
    "The terms for using Clarity Caddy: what it does, paid access, renewals, referrals and your account.",
    false,
  );
}

function caddySupport(): Page {
  return page(
    "support",
    "Contact / Support",
    [
      legalHead("Clarity Caddy", "Contact / Support", CADDY_UPDATED, "For Clarity Caddy support, contact Clarity Golf Systems Limited."),
      section(
        "details",
        "",
        `Email: ${CADDY_EMAIL}

Business: ${CADDY_OPERATOR}.

Please include the feature you were using, the device/browser, and a short description of the issue.`,
      ),
      { id: "email", type: "cta", heading: "Email support", text: "", button: button("Email support", `mailto:${CADDY_EMAIL}`), tone: "surface" },
    ],
    "How to get help with Clarity Caddy.",
    false,
  );
}

function caddyDeleteAccount(): Page {
  return page(
    "delete-account",
    "Delete your account",
    [
      legalHead(
        "Clarity Caddy",
        "Delete your account",
        CADDY_UPDATED,
        "You can ask us to delete your Clarity Caddy account and the data attached to it at any time. There is no charge, and you do not need a reason.",
      ),
      section("in-app", "In the app", "The fastest way is in the app itself: open Settings → Delete account, type DELETE to confirm, and your account and data are removed immediately. You do not need to contact us."),
      section(
        "clear",
        "Clearing your golf data without deleting your account",
        `If you want a clean slate rather than an exit, open Settings → Clear my golf data and type CLEAR to confirm. This permanently deletes your rounds, scores, shots, practice records, launch monitor imports and saved course captures.

Your account, sign-in, player profile, bag setup and any paid membership are kept, so you can carry on playing with an empty history. As with deleting your account, course maps you added to the shared library stay published so that other players can keep using them, and it cannot be undone.`,
      ),
      section(
        "email",
        "By email",
        `If you cannot get into the app, email us from the address your account is registered to, with the subject line "Delete my account".

We ask you to send it from your registered email address so that we can confirm the request is really from you. If you cannot use that address, email us anyway and we will find another way to verify it before deleting anything.`,
      ),
      {
        id: "request",
        type: "cta",
        heading: "Email a deletion request",
        text: "",
        button: button("Email a deletion request", `mailto:${CADDY_EMAIL}?subject=Delete%20my%20account&body=Please%20delete%20my%20Clarity%20Caddy%20account%20and%20the%20data%20associated%20with%20it.`),
        tone: "surface",
      },
      section(
        "next",
        "What happens next",
        `• If you delete in the app, your account and data are removed straight away.
• If you email us, we confirm by reply and remove your account and personal data from our live systems within 30 days.
• Either way, copies in encrypted backups are overwritten within 12 months.`,
      ),
      section(
        "what",
        "What gets deleted",
        `Deleted: your account, email address and name; your player profile and golf bag setup; your practice records and imported launch monitor data; your rounds, scores and shot records; your saved location and course play data; your support messages and referral records.

Kept: a minimal record of purchases, because tax and accounting law requires us to keep it.

Course maps that you contributed to the shared course library may be kept so that other players can continue to use those courses, but they are disconnected from your account and no longer identify you.`,
      ),
      section(
        "subscriptions",
        "Cancelling a paid membership",
        `Deleting your account does not by itself cancel a subscription that you bought through the App Store or Google Play, because those are managed by Apple and Google rather than by us. Cancel the subscription in your store account first:

• iPhone or iPad: Settings → your name → Subscriptions
• Android: Google Play → Menu → Payments and subscriptions → Subscriptions

If you subscribed on the website, tell us in your email and we will cancel it for you.`,
      ),
      section("questions", "Questions", `Email ${CADDY_EMAIL}. See our Privacy Policy for what we collect and how long we keep it.\n\n${CADDY_OPERATOR}`),
    ],
    "How to delete your Clarity Caddy account, or clear your golf data and keep your account.",
    false,
  );
}

// --- Clarity Golf Booking --------------------------------------------------------

function bookingSettings(): SiteSettings {
  return cleanSiteSettings({
    theme: themeFromPreset("slate"),
    header: {
      showLogo: true,
      showName: true,
      links: [],
      button: button("Sign in", `${BOOKING_APP}/login`),
      sticky: true,
      transparent: false,
      social: [],
      shopPage: "",
    },
    footer: {
      text: "Clarity Golf Booking",
      links: [
        { label: "Privacy Policy", href: pageHref("privacy") },
        { label: "Terms", href: pageHref("terms") },
        { label: "Support", href: pageHref("support") },
      ],
      social: [],
      showCredit: false,
    },
  });
}

function bookingHome(): Page {
  return page(
    HOME_PAGE_SLUG,
    "Home",
    [
      {
        id: "hero",
        type: "hero",
        eyebrow: "Clarity Golf Booking",
        heading: "Booking and player management built for golf coaching.",
        text: "Clarity helps golf coaches manage lessons, availability, players, practice, passes and swing reviews in one connected workspace.",
        image: { url: `${BOOKING_APP}/assets/clarity-golf-logo-with-name.webp`, alt: "Clarity Golf" },
        shape: "square",
        layout: "split",
        height: "tall",
        buttons: [button("Sign in", `${BOOKING_APP}/login`), button("Book a lesson", "https://book.claritygolf.app", "secondary")],
      },
      {
        id: "summary",
        type: "text",
        heading: "One place for the work around the lesson.",
        body: "For coaches and their players: scheduling, player history, coaching notes, practice, passes, video reviews and optional Google integrations.",
        align: "centre",
        columns: 1,
      },
      {
        id: "features",
        type: "features",
        heading: "Clarity Golf Booking features",
        intro: "",
        columns: 2,
        items: [
          feature("calendar", "Booking & scheduling", "Coaches can manage services, availability, bookings, rescheduling and public lesson booking."),
          feature("users", "Player management", "Keep player profiles, lesson history, notes, practice assignments, passes and swing reviews connected to the coaching relationship."),
          feature("clock", "Google Calendar", "A coach can choose to connect Google Calendar so Clarity can synchronise lesson bookings and relevant availability with the connected account."),
          feature("video", "Clarity Cloud", "When enabled by the coach, Clarity can use Google Drive to create and manage Clarity-owned lesson video files and folders for transfer between devices."),
        ],
      },
      {
        id: "google",
        type: "cta",
        heading: "You choose when Clarity connects to Google.",
        text: "Google integrations are optional. Google Calendar and Google Drive access is requested only when a coach enables the relevant integration. See the Privacy Policy for the exact Google data Clarity accesses and how it is used.",
        button: button("Privacy Policy", pageHref("privacy"), "secondary"),
        tone: "surface",
      },
    ],
    "Booking and player management built for golf coaching.",
  );
}

function bookingPrivacy(): Page {
  return page(
    "privacy",
    "Privacy Policy",
    [
      legalHead(
        "Clarity Golf Booking",
        "Privacy Policy",
        BOOKING_UPDATED,
        'This policy explains how Clarity Golf Booking ("Clarity", "we", "us") handles information when coaches, players and booking visitors use the service.',
      ),
      section(
        "collect",
        "Information we collect",
        "Depending on how Clarity is used, we may process account and profile information, contact details, booking and scheduling information, coaching notes, practice assignments, passes, transaction records, videos and other content that users choose to add to the service. We also process basic technical information needed to operate, secure and diagnose the service.",
      ),
      section(
        "use",
        "How we use information",
        "We use information to provide booking, player-management, coaching, communication, billing and video-transfer features; authenticate users; maintain the service; prevent misuse; troubleshoot problems; and comply with legal obligations.",
      ),
      section(
        "google",
        "Google account and Google API data",
        `Google integrations are optional and are connected by a coach. Clarity requests only the permissions needed for the features the coach enables.

Google Calendar. Clarity may request access to Google Calendar events and the connected account's calendar list. We use this access to show/select relevant calendars, synchronise coaching bookings and availability, and create, update or remove calendar events when corresponding records change in Clarity.

Google Drive / Clarity Cloud. If Clarity Cloud is enabled, Clarity uses Google's drive.file permission to create and manage files and folders that Clarity itself creates or that the user explicitly makes available to Clarity. This is used for lesson-video storage and transfer. Clarity does not request unrestricted access to every file in a user's Google Drive.

Google account identity. Clarity may access the email address associated with the connected Google account so the service can identify which account is connected and show that connection to the coach.

Google authorisation storage. To keep an integration working without asking the coach to reconnect for every sync, Clarity may retain a Google refresh token. Refresh tokens are encrypted and stored server-side. Google access and refresh tokens are not exposed to the normal browser application.`,
      ),
      section(
        "google-use",
        "Google API data use and sharing",
        `Information received from Google APIs is used only to provide and maintain the Google-connected features described above. We do not sell, rent or trade Google user data. We do not use it for advertising, and we do not use it to train artificial intelligence or machine-learning models.

We share, transfer or disclose Google user data only with the following parties:

• The coach's own golf business in Clarity. Busy times imported from Google Calendar, with their event titles unless the coach chooses to hide them, are shown to the coach and to people in the same golf business who can view that coach's diary. Players and people booking a lesson only see that a time is unavailable and never see Google Calendar event details.
• Our infrastructure providers, which process data only on our behalf and under our instructions to run Clarity: Netlify, which hosts the application and its server functions, and Supabase, which hosts the database where Google-derived data and encrypted Google refresh tokens are stored.
• Authorities or other parties where we are required to by law, such as to comply with a valid legal request, or where necessary to protect the rights, safety and security of our users or Clarity.
• A successor organisation if Clarity is involved in a merger, acquisition or sale of assets. Any successor must continue to protect Google user data under this policy and the Limited Use requirements, and we will notify affected users first.

We do not share Google user data with any other third party, including advertisers, data brokers and artificial intelligence providers.

Clarity Golf Booking's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy (https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.`,
      ),
      section(
        "sharing",
        "Sharing",
        "We share information only where needed to provide the service, where a user directs us to do so, with providers that help us operate the service, or where required by law. Coaches and players may also see information that is intentionally shared within their coaching relationship.",
      ),
      section(
        "retention",
        "Retention and deletion",
        "We retain information for as long as it is reasonably needed to provide the service, maintain legitimate business records, resolve disputes and meet legal obligations. Retention periods can differ by data type. Users can request deletion or help with their account through Support.",
      ),
      section(
        "disconnect",
        "Disconnecting Google",
        "A coach can disconnect a Google integration from Clarity. Disconnecting stops future authorised Google access through that connection. Existing calendar events or Drive files already created in the user's Google account are not automatically deleted unless the product explicitly offers that action.",
      ),
      section(
        "security",
        "Security",
        "We use technical and organisational safeguards designed to protect information, including access controls and encryption for stored Google refresh tokens. No system can guarantee absolute security.",
      ),
      section("contact", "Contact", `Privacy questions, account requests and deletion requests can be sent to ${BOOKING_EMAIL}.`),
    ],
    "How Clarity Golf Booking handles information, including Google API data.",
  );
}

function bookingTerms(): Page {
  return page(
    "terms",
    "Terms of Service",
    [
      legalHead(
        "Clarity Golf Booking",
        "Terms of Service",
        BOOKING_UPDATED,
        "These terms apply when you access or use Clarity Golf Booking. By using the service, you agree to use it lawfully and in accordance with these terms.",
      ),
      section(
        "service",
        "The service",
        "Clarity provides software for golf-coaching booking, scheduling, player management, practice, notes, passes, video reviews and related integrations. Individual coaches and businesses remain responsible for the coaching services, prices, cancellations and other arrangements they offer to players.",
      ),
      section("account", "Your account", "You are responsible for keeping your login credentials secure and for activity carried out through your account. Information you provide must be accurate enough for the service to operate correctly."),
      section(
        "connected",
        "Connected services",
        "Optional integrations, including Google Calendar and Google Drive, are also subject to the terms of those providers. You can disconnect optional integrations when you no longer want Clarity to access them.",
      ),
      section(
        "content",
        "Your content",
        "You retain ownership of content you provide to Clarity. You give Clarity permission to process that content only as needed to provide, secure and maintain the service and the features you choose to use.",
      ),
      section(
        "use",
        "Acceptable use",
        "You must not misuse the service, attempt unauthorised access, interfere with its operation, use it to infringe another person's rights, or upload unlawful or malicious material.",
      ),
      section(
        "changes",
        "Availability and changes",
        "We may maintain, improve or change the service over time. We aim to provide a reliable service but do not promise that every feature will be uninterrupted or error-free.",
      ),
      section("contact", "Contact", `Questions about these terms can be sent to ${BOOKING_EMAIL}.`),
    ],
    "The terms for using Clarity Golf Booking.",
  );
}

function bookingSupport(): Page {
  return page(
    "support",
    "Support",
    [
      legalHead(
        "Clarity Golf Booking",
        "Support",
        "",
        `For technical help with Clarity Golf Booking, account access, privacy requests or a problem with a connected service, email ${BOOKING_EMAIL}.`,
      ),
      section(
        "lessons",
        "Booking or lesson questions",
        "If your question is about a lesson time, cancellation, coaching service or payment arranged with a coach, contact the coach or golf business that provided your booking link. Those arrangements are managed by the individual business.",
      ),
      section(
        "google",
        "Google connection help",
        "Coaches can manage Google Calendar and Clarity Cloud connections from the integrations area after signing in. If a connection needs to be reset or removed and you cannot access the app, contact Support.",
      ),
      { id: "email", type: "cta", heading: "Email support", text: "", button: button("Email support", `mailto:${BOOKING_EMAIL}`), tone: "surface" },
    ],
    "How to get help with Clarity Golf Booking.",
  );
}

export const HOUSE_SITE_TEMPLATES: readonly SiteTemplate[] = [
  {
    id: "house-caddy",
    label: "Clarity Caddy",
    summary: "The Clarity Caddy site: home, How it works, and the privacy, terms, support and account deletion pages the app stores link to.",
    preset: "midnight",
    build: () => ({
      settings: caddySettings(),
      pages: [caddyHome(), caddyHowItWorks(), caddyPrivacy(), caddyTerms(), caddySupport(), caddyDeleteAccount()],
    }),
  },
  {
    id: "house-booking",
    label: "Clarity Golf Booking",
    summary: "The claritygolf.app home page, with its privacy, terms and support pages.",
    preset: "slate",
    build: () => ({
      settings: bookingSettings(),
      pages: [bookingHome(), bookingPrivacy(), bookingTerms(), bookingSupport()],
    }),
  },
];
