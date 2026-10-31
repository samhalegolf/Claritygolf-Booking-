/**
 * The pages a business can start from.
 *
 * A template is a whole document -- theme, header, footer and blocks -- with
 * the business's own name, coach and booking address already in it. The
 * coach then changes anything, adds and removes blocks, and the template is
 * forgotten: it is a starting point, not a mode the page stays in.
 *
 * Every template goes through cleanSiteDocument before it is used, so a
 * template can never contain something the cleaner would refuse.
 */

import { cleanSiteDocument, siteId, themeFromPreset, type SiteBlock, type SiteDocument } from "./document.mts";

export type SiteTemplateInput = {
  businessName: string;
  coachName: string;
  /** The business's public booking page, used for every "Book" button. */
  bookingHref: string;
  email: string;
  phone: string;
  venueName: string;
};

export type SiteTemplate = {
  id: string;
  label: string;
  /** One line on the chooser card. */
  summary: string;
  /** The theme preset the chooser card is coloured with. */
  preset: string;
  build: (input: SiteTemplateInput) => SiteDocument;
};

const book = (label: string, href: string, style: "primary" | "secondary" = "primary") => ({ label, href, style });

function footer(text: string) {
  return {
    text,
    links: [],
    social: [],
    showCredit: true,
  };
}

function header(input: SiteTemplateInput, links: Array<{ label: string; href: string }>, buttonLabel = "Book now") {
  return {
    showLogo: true,
    showName: true,
    links,
    button: book(buttonLabel, input.bookingHref),
    sticky: true,
  };
}

function contactBlock(input: SiteTemplateInput): SiteBlock {
  return {
    id: "contact",
    type: "contact",
    heading: "Find us",
    text: input.venueName ? `Lessons are at ${input.venueName}.` : "",
    email: input.email,
    phone: input.phone,
    address: "",
    hours: "",
    showMap: false,
  };
}

function bookingBlock(heading = "Book a lesson", text = ""): SiteBlock {
  return { id: "book", type: "booking", heading, text, screen: "main", mode: "embed", buttonLabel: "Book now", height: 760 };
}

export const SITE_TEMPLATES: readonly SiteTemplate[] = [
  {
    id: "academy",
    label: "Academy",
    summary: "A full page: hero, what you get, lessons and prices, reviews, questions and booking.",
    preset: "fairway",
    build: (input) =>
      cleanSiteDocument({
        template: "academy",
        title: input.businessName,
        description: `Golf coaching with ${input.coachName || input.businessName}. Book a lesson online.`,
        theme: themeFromPreset("fairway"),
        header: header(input, [
          { label: "Lessons", href: "#lessons" },
          { label: "Reviews", href: "#reviews" },
          { label: "Contact", href: "#contact" },
        ]),
        footer: footer(`© ${input.businessName}`),
        blocks: [
          {
            id: "hero",
            type: "hero",
            eyebrow: input.venueName || "Golf coaching",
            heading: `Play the golf you know you have in you`,
            text: `Lessons with ${input.coachName || input.businessName}: a clear plan, video of every swing, and a coach who follows up between sessions.`,
            image: null,
            layout: "centre",
            height: "tall",
            buttons: [book("Book a lesson", input.bookingHref), book("See lessons", "#lessons", "secondary")],
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
              { id: siteId("item"), name: "Private lesson", price: "", detail: "One-to-one", features: "Video analysis\nA practice plan to take away\nFollow-up notes", button: book("Book", input.bookingHref), highlighted: false },
              { id: siteId("item"), name: "Lesson package", price: "", detail: "Best value", features: "A series of lessons\nPriority booking\nProgress tracked between sessions", button: book("Book", input.bookingHref), highlighted: true },
              { id: siteId("item"), name: "Group session", price: "", detail: "Small groups", features: "Learn with friends\nShort-game and course sessions", button: book("Book", input.bookingHref), highlighted: false },
            ],
          },
          {
            id: "reviews",
            type: "testimonials",
            heading: "What players say",
            items: [
              { id: siteId("item"), quote: "Add a quote from a player here.", name: "A player", role: "" },
              { id: siteId("item"), quote: "And another one here.", name: "Another player", role: "" },
            ],
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
          bookingBlock(),
          contactBlock(input),
        ],
      }),
  },
  {
    id: "studio",
    label: "Studio",
    summary: "Clean and modern: a split hero, a short story, a video, and a bold call to book.",
    preset: "slate",
    build: (input) =>
      cleanSiteDocument({
        template: "studio",
        title: input.businessName,
        description: `${input.businessName}: modern golf coaching, booked online.`,
        theme: themeFromPreset("slate"),
        header: header(input, [
          { label: "About", href: "#about" },
          { label: "Contact", href: "#contact" },
        ]),
        footer: footer(`© ${input.businessName}`),
        blocks: [
          {
            id: "hero",
            type: "hero",
            eyebrow: "",
            heading: input.businessName,
            text: "Coaching built around how you actually play. Book a lesson and we will start with your game, not a textbook swing.",
            image: null,
            layout: "split",
            height: "regular",
            buttons: [book("Book a lesson", input.bookingHref)],
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
          { id: "cta", type: "cta", heading: "Ready when you are", text: "Pick a time that suits you. It takes a minute.", button: book("Book now", input.bookingHref), tone: "primary" },
          contactBlock(input),
        ],
      }),
  },
  {
    id: "performance",
    label: "Performance",
    summary: "Dark and direct, for coaches who work with serious players.",
    preset: "midnight",
    build: (input) =>
      cleanSiteDocument({
        template: "performance",
        title: input.businessName,
        description: `${input.businessName}: performance coaching for golfers who want to score lower.`,
        theme: themeFromPreset("midnight"),
        header: header(input, [
          { label: "Programmes", href: "#programmes" },
          { label: "Results", href: "#results" },
          { label: "Book", href: "#book" },
        ]),
        footer: footer(`© ${input.businessName}`),
        blocks: [
          {
            id: "hero",
            type: "hero",
            eyebrow: "Performance coaching",
            heading: "Lower scores. Measured.",
            text: `${input.coachName || input.businessName} works with players who want their practice to show up on the course.`,
            image: null,
            layout: "left",
            height: "tall",
            buttons: [book("Start here", input.bookingHref), book("Programmes", "#programmes", "secondary")],
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
            items: [{ id: siteId("item"), quote: "Add a player's result or quote here.", name: "A player", role: "Handicap 12 to 6" }],
          },
          bookingBlock("Book an assessment", "The first session is an assessment: an hour on the range and the putting green with your numbers."),
          contactBlock(input),
        ],
      }),
  },
  {
    id: "simple",
    label: "Simple",
    summary: "One screen: who you are, a photo, and a button. Add more later.",
    preset: "ivory",
    build: (input) =>
      cleanSiteDocument({
        template: "simple",
        title: input.businessName,
        description: `${input.businessName}. Book a golf lesson online.`,
        theme: themeFromPreset("ivory"),
        header: { showLogo: true, showName: true, links: [], button: book("Book", input.bookingHref), sticky: false },
        footer: footer(`© ${input.businessName}`),
        blocks: [
          {
            id: "hero",
            type: "hero",
            eyebrow: input.venueName,
            heading: input.coachName || input.businessName,
            text: "Golf lessons for every level. Book online below.",
            image: null,
            layout: "centre",
            height: "regular",
            buttons: [book("Book a lesson", input.bookingHref)],
          },
          { id: "divider", type: "divider", style: "line", size: "regular" },
          contactBlock(input),
        ],
      }),
  },
];

export function siteTemplate(id: string): SiteTemplate | null {
  return SITE_TEMPLATES.find((template) => template.id === id) || null;
}
