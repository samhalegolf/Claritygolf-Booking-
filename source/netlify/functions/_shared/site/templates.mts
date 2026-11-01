/**
 * The sites a business can start from.
 *
 * A template is a whole site -- settings and a first set of pages -- with the
 * business's own name, coach and booking address already in it. The coach
 * then changes anything, adds and removes pages and blocks, and the template
 * is forgotten: it is a starting point, not a mode the site stays in.
 *
 * Every template's pages go through cleanSitePageContent and its settings
 * through cleanSiteSettings, so a template can never contain something the
 * cleaner would refuse. Most of the pages come from the page presets
 * (document.mts), the same ones Add page offers.
 */

import {
  HOME_PAGE_SLUG,
  cleanSitePageContent,
  cleanSiteSettings,
  pageHref,
  siteId,
  sitePagePreset,
  themeFromPreset,
  type SiteBlockInput,
  type SitePage,
  type SitePagePresetInput,
  type SiteSettings,
} from "./document.mts";

export type SiteTemplateInput = SitePagePresetInput;

export type SiteTemplateSite = {
  settings: SiteSettings;
  /** In menu order. The first is always the home page. */
  pages: Array<Omit<SitePage, "id" | "sortOrder">>;
};

export type SiteTemplate = {
  id: string;
  label: string;
  /** One line on the chooser card. */
  summary: string;
  /** The theme preset the chooser card is coloured with. */
  preset: string;
  build: (input: SiteTemplateInput) => SiteTemplateSite;
};

const book = (label: string, href: string, style: "primary" | "secondary" = "primary") => ({ label, href, style });

function settings(preset: string, input: SiteTemplateInput, options: { sticky?: boolean; transparent?: boolean; buttonHref?: string; shopPage?: string } = {}): SiteSettings {
  return cleanSiteSettings({
    theme: themeFromPreset(preset),
    header: {
      showLogo: true,
      showName: true,
      links: [],
      button: book("Book now", options.buttonHref ?? pageHref("book")),
      sticky: options.sticky ?? true,
      transparent: options.transparent ?? false,
      social: [],
      shopPage: options.shopPage ?? "",
    },
    footer: { text: `© ${input.businessName}`, links: [], social: [], showCredit: true },
  });
}

function page(slug: string, title: string, blocks: Array<SiteBlockInput & { style?: unknown }>, description = ""): Omit<SitePage, "id" | "sortOrder"> {
  return { slug, title, kind: "page", inNav: true, content: cleanSitePageContent({ description, blocks }) };
}

/** The pages every template adds after the home page: the booking page, About and Find us. */
function standardPages(input: SiteTemplateInput) {
  return ["book", "about", "location"].map((id) => sitePagePreset(id)!.build(input));
}

export const SITE_TEMPLATES: readonly SiteTemplate[] = [
  {
    id: "academy",
    label: "Academy",
    summary: "A full home page: hero, what you get, lessons and prices, reviews and questions. Plus Book, About and Find us.",
    preset: "fairway",
    build: (input) => ({
      settings: settings("fairway", input),
      pages: [
        page(
          HOME_PAGE_SLUG,
          "Home",
          [
            {
              id: "hero",
              type: "hero",
              eyebrow: input.venueName || "Golf coaching",
              heading: "Play the golf you know you have in you",
              text: `Lessons with ${input.coachName || input.businessName}: a clear plan, video of every swing, and a coach who follows up between sessions.`,
              image: null,
              shape: "square",
              layout: "centre",
              height: "tall",
              buttons: [book("Book a lesson", pageHref("book")), book("See lessons", "#lessons", "secondary")],
            },
            {
              id: "why",
              type: "features",
              heading: "What a lesson looks like",
              intro: "",
              columns: 3,
              items: [
                { id: siteId("item"), icon: "target", title: "One clear change", text: "We find the one thing that will move your scores most and work on that, not five things at once." },
                { id: siteId("item"), icon: "video", title: "See it on video", text: "Every lesson is filmed and you keep the clips, with the coach's drawings and notes." },
                { id: siteId("item"), icon: "calendar", title: "Book in a minute", text: "Pick a time online, pay how you like, and get a reminder before you come." },
              ],
            },
            {
              id: "lessons",
              type: "pricing",
              heading: "Lessons",
              intro: "Prices are shown on the booking page.",
              items: [
                { id: siteId("item"), name: "Private lesson", price: "", detail: "One-to-one", features: "Video analysis\nA practice plan to take away\nFollow-up notes", button: book("Book", pageHref("book")), highlighted: false },
                { id: siteId("item"), name: "Lesson package", price: "", detail: "Best value", features: "A series of lessons\nPriority booking\nProgress tracked between sessions", button: book("Book", pageHref("book")), highlighted: true },
                { id: siteId("item"), name: "Group session", price: "", detail: "Small groups", features: "Learn with friends\nShort-game and course sessions", button: book("Book", pageHref("book")), highlighted: false },
              ],
            },
            {
              id: "reviews",
              type: "testimonials",
              heading: "What players say",
              intro: "",
              items: [
                { id: siteId("item"), quote: "Add a quote from a player here.", name: "A player", role: "", image: null },
                { id: siteId("item"), quote: "And another one here.", name: "Another player", role: "", image: null },
              ],
              button: null,
            },
            {
              id: "faq",
              type: "faq",
              heading: "Questions",
              intro: "",
              items: [
                { id: siteId("item"), question: "Do I need my own clubs?", answer: "Bring them if you have them. If not, say so when you book and we will sort something out." },
                { id: siteId("item"), question: "What if I am a complete beginner?", answer: "Perfect. The first lesson is about where you are now and what you want from the game." },
                { id: siteId("item"), question: "Can I cancel or move a lesson?", answer: "Yes. The confirmation email has a link to move or cancel your booking." },
              ],
            },
            { id: "cta", type: "cta", heading: "Ready to play better golf?", text: "Pick a time that suits you. It takes a minute.", button: book("Book a lesson", pageHref("book")), tone: "primary" },
          ],
          `Golf coaching with ${input.coachName || input.businessName}. Book a lesson online.`,
        ),
        ...standardPages(input),
      ],
    }),
  },
  {
    id: "studio",
    label: "Studio",
    summary: "Clean and modern: a split hero, a short story, a video, and a bold call to book.",
    preset: "slate",
    build: (input) => ({
      settings: settings("slate", input),
      pages: [
        page(
          HOME_PAGE_SLUG,
          "Home",
          [
            {
              id: "hero",
              type: "hero",
              eyebrow: "",
              heading: input.businessName,
              text: "Coaching built around how you actually play. Book a lesson and we will start with your game, not a textbook swing.",
              image: null,
              shape: "square",
              layout: "split",
              height: "regular",
              buttons: [book("Book a lesson", pageHref("book"))],
            },
            {
              id: "about",
              type: "text",
              heading: `About ${input.coachName || "the coach"}`,
              body: "Write a few paragraphs here about who you are, how you coach and who you work with.\n\nBlank lines start new paragraphs.",
              align: "left",
              columns: 1,
            },
            { id: "video", type: "video", heading: "See a lesson", youtubeId: "", caption: "" },
            { id: "cta", type: "cta", heading: "Ready when you are", text: "Pick a time that suits you. It takes a minute.", button: book("Book now", pageHref("book")), tone: "primary" },
          ],
          `${input.businessName}: modern golf coaching, booked online.`,
        ),
        ...standardPages(input),
      ],
    }),
  },
  {
    id: "performance",
    label: "Performance",
    summary: "Dark and direct, for coaches who work with serious players.",
    preset: "midnight",
    build: (input) => ({
      settings: settings("midnight", input),
      pages: [
        page(
          HOME_PAGE_SLUG,
          "Home",
          [
            {
              id: "hero",
              type: "hero",
              eyebrow: "Performance coaching",
              heading: "Lower scores. Measured.",
              text: `${input.coachName || input.businessName} works with players who want their practice to show up on the course.`,
              image: null,
              shape: "square",
              layout: "left",
              height: "tall",
              buttons: [book("Start here", pageHref("book")), book("Programmes", "#programmes", "secondary")],
            },
            {
              id: "programmes",
              type: "features",
              heading: "How we work",
              intro: "",
              columns: 3,
              items: [
                { id: siteId("item"), icon: "line-chart", title: "Assess", text: "Numbers first: where strokes are actually going." },
                { id: siteId("item"), icon: "target", title: "Train", text: "Practice that is built to transfer to the course." },
                { id: siteId("item"), icon: "trophy", title: "Compete", text: "Review every round and adjust the plan." },
              ],
            },
            {
              id: "results",
              type: "testimonials",
              heading: "Results",
              intro: "",
              items: [{ id: siteId("item"), quote: "Add a player's result or quote here.", name: "A player", role: "Handicap 12 to 6", image: null }],
              button: null,
            },
            { id: "cta", type: "cta", heading: "Book an assessment", text: "The first session is an assessment: an hour on the range and the putting green with your numbers.", button: book("Book now", pageHref("book")), tone: "primary" },
          ],
          `${input.businessName}: performance coaching for golfers who want to score lower.`,
        ),
        ...standardPages(input),
      ],
    }),
  },
  {
    id: "pro",
    label: "Pro",
    summary: "Modelled on a working coaching site: profile hero, what you offer as cards, reviews on a dark band, certifications, venues with maps and booking, group coaching, articles, a shop and a contact form.",
    preset: "ember",
    build: (input) => ({
      settings: settings("ember", input, { sticky: true, transparent: true, buttonHref: pageHref("book"), shopPage: "shop-page" }),
      pages: [
        page(
          HOME_PAGE_SLUG,
          "Home",
          [
            {
              id: "hero",
              type: "hero",
              eyebrow: "Certified PGA Professional",
              heading: input.coachName || input.businessName,
              text:
                `${input.coachName || input.businessName} coaches at ${input.venueName || "the range"}.\n\n` +
                "Golf is at its most enjoyable when you have clarity in your process for improvement. This starts with personalised coaching that targets your unique goals, learning style and physical capabilities.\n\n" +
                "The aim is to simplify your golfing experience by focusing your time and effort on the right areas, with coaching built on research, innovation and the latest technology.",
              image: null,
              shape: "square",
              layout: "split",
              height: "regular",
              buttons: [book("Book a lesson", pageHref("book")), book("Group classes", pageHref("group-coaching"), "secondary")],
              style: { theme: "default", background: null, video: "", overlay: 15, height: "small", width: "inherit", divider: "none" },
            },
            {
              id: "offer",
              type: "cards",
              heading: "",
              intro: "",
              columns: 4,
              items: [
                { id: siteId("item"), image: null, title: "Private Lessons", text: "Private lessons provide an ideal environment to improve your game with a truly customised approach.", button: book("Book Now", pageHref("book")) },
                { id: siteId("item"), image: null, title: "Group Classes", text: "Invite some friends to learn golf with you; suitable for all skill levels.", button: book("Click Here", pageHref("group-coaching")) },
                { id: siteId("item"), image: null, title: "Buy a Gift Voucher", text: "A lesson makes a great gift.", button: book("Check it out", pageHref("shop-page")) },
                { id: siteId("item"), image: null, title: "Club Fitting", text: "Book yourself a club fitting.", button: book("Click Here", "") },
              ],
              style: { theme: "light", background: null, video: "", overlay: 30, height: "auto", width: "inherit", divider: "none" },
            },
            {
              id: "reviews",
              type: "testimonials",
              heading: "Customer Feedback",
              intro: "",
              items: [
                { id: siteId("item"), quote: "Add a review here, or upload a screenshot of one.", name: "A player", role: "", image: null },
                { id: siteId("item"), quote: "Add another review here.", name: "Another player", role: "", image: null },
                { id: siteId("item"), quote: "And a third.", name: "A third player", role: "", image: null },
              ],
              button: book("Leave a Review", ""),
              style: { theme: "dark", background: null, video: "", overlay: 40, height: "medium", width: "inherit", divider: "none" },
            },
            {
              id: "certifications",
              type: "logos",
              heading: "Certifications",
              intro: "",
              size: "regular",
              items: [
                { id: siteId("item"), image: null, caption: "Certified PGA Professional", href: "" },
                { id: siteId("item"), image: null, caption: "TPI Certified Level 1 & 2", href: "" },
                { id: siteId("item"), image: null, caption: "Certified Personal Trainer", href: "" },
              ],
              style: { theme: "white", background: null, video: "", overlay: 30, height: "auto", width: "inherit", divider: "none" },
            },
            { id: "instagram", type: "instagram", heading: "Follow On Instagram", handle: "", items: [], columns: 4 },
          ],
          `Golf coaching with ${input.coachName || input.businessName}. Private lessons, group classes and gift vouchers. Book online.`,
        ),
        // The venues page is this site's booking page, under the shared "book" address.
        { ...sitePagePreset("venues")!.build(input), slug: "book" },
        page(
          "group-coaching",
          "Group Coaching",
          [
            {
              id: "hero",
              type: "hero",
              eyebrow: "",
              heading: "Group Coaching",
              text:
                `Group golf coaching at ${input.venueName || "the range"}, suitable for golfers of all levels.\n\n` +
                "The mission is to bring high-quality individualised coaching in a comfortable group environment.\n\n" +
                "Just round up some friends or family and add them to the invite list. You can send them an email invite, or your details and the number attending is enough to book.",
              image: null,
              shape: "square",
              layout: "left",
              height: "regular",
              buttons: [],
              style: { theme: "dark", background: null, video: "", overlay: 30, height: "auto", width: "inherit", divider: "none" },
            },
            { id: "book", type: "booking", heading: "", text: "", screen: "group-lessons", mode: "embed", buttonLabel: "Book now", height: 900 },
          ],
          "Group golf coaching, suitable for all levels. Book online.",
        ),
        sitePagePreset("articles")!.build(input),
        sitePagePreset("videos")!.build(input),
        sitePagePreset("shop")!.build(input),
        page(
          "contact",
          "Contact",
          [
            {
              id: "contact",
              type: "contact",
              heading: "Contact us.",
              text: "",
              email: input.email,
              phone: input.phone,
              address: "",
              hours: "",
              showMap: false,
            },
            { id: "message", type: "form", heading: "Send a message", text: "", askPhone: true, buttonLabel: "Send", thanks: "Thanks, your message is on its way. We will be in touch soon." },
            { id: "book", type: "booking", heading: "Or book straight away", text: "", screen: "main", mode: "embed", buttonLabel: "Book now", height: 760 },
          ],
          `Get in touch with ${input.businessName}.`,
        ),
      ],
    }),
  },
  {
    id: "simple",
    label: "Simple",
    summary: "One screen: who you are, a photo, and a button. Plus the booking page.",
    preset: "ivory",
    build: (input) => ({
      settings: settings("ivory", input, { sticky: false }),
      pages: [
        page(
          HOME_PAGE_SLUG,
          "Home",
          [
            {
              id: "hero",
              type: "hero",
              eyebrow: input.venueName,
              heading: input.coachName || input.businessName,
              text: "Golf lessons for every level. Book online.",
              image: null,
              shape: "square",
              layout: "centre",
              height: "regular",
              buttons: [book("Book a lesson", pageHref("book"))],
            },
            { id: "divider", type: "divider", line: "line", size: "regular" },
            {
              id: "contact",
              type: "contact",
              heading: "Find us",
              text: input.venueName ? `Lessons are at ${input.venueName}.` : "",
              email: input.email,
              phone: input.phone,
              address: "",
              hours: "",
              showMap: false,
            },
          ],
          `${input.businessName}. Book a golf lesson online.`,
        ),
        sitePagePreset("book")!.build(input),
      ],
    }),
  },
];

export function siteTemplate(id: string): SiteTemplate | null {
  return SITE_TEMPLATES.find((template) => template.id === id) || null;
}
