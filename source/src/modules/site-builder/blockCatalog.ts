// The blocks a coach can add, in the order the menu offers them.
import {
  Award,
  CalendarCheck,
  CircleHelp,
  Code,
  Image,
  Images,
  LayoutGrid,
  LayoutTemplate,
  ListChecks,
  Mail,
  Map,
  MapPin,
  Megaphone,
  MessageSquareQuote,
  Minus,
  Newspaper,
  Play,
  ShoppingBag,
  Tag,
  Type,
} from "lucide-react";

import type { SiteBlockType } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";

export type BlockCatalogEntry = { type: SiteBlockType; label: string; hint: string; Icon: typeof Type };

export const BLOCK_CATALOG: readonly BlockCatalogEntry[] = [
  { type: "hero", label: t("Hero"), hint: t("A big heading, a line and a button."), Icon: LayoutTemplate },
  { type: "text", label: t("Text"), hint: t("A heading and some paragraphs."), Icon: Type },
  { type: "image", label: t("Image"), hint: t("One picture, with a caption."), Icon: Image },
  { type: "gallery", label: t("Gallery"), hint: t("A grid of pictures."), Icon: Images },
  { type: "features", label: t("Features"), hint: t("Three or more points with icons."), Icon: ListChecks },
  { type: "cards", label: t("Cards"), hint: t("A picture, a heading, a line and a button, side by side."), Icon: LayoutGrid },
  { type: "logos", label: t("Logos"), hint: t("Small pictures in a row with a caption each."), Icon: Award },
  { type: "pricing", label: t("Pricing"), hint: t("Lessons and packages, side by side."), Icon: Tag },
  { type: "testimonials", label: t("Testimonials"), hint: t("What players say."), Icon: MessageSquareQuote },
  { type: "faq", label: t("Questions"), hint: t("Questions that open to show their answers."), Icon: CircleHelp },
  { type: "cta", label: t("Call to action"), hint: t("A band with one button."), Icon: Megaphone },
  { type: "video", label: t("Video"), hint: t("A YouTube video."), Icon: Play },
  { type: "embed", label: t("Embed"), hint: t("Another website's form, map or player, framed."), Icon: Code },
  { type: "booking", label: t("Booking"), hint: t("Your Clarity booking page, on the page."), Icon: CalendarCheck },
  { type: "venues", label: t("Venues"), hint: t("Each place you coach: map, hours and booking, side by side."), Icon: Map },
  { type: "form", label: t("Contact form"), hint: t("A message to you, emailed and kept."), Icon: Mail },
  { type: "shop", label: t("Shop"), hint: t("Your packages and gift vouchers, bought on the page."), Icon: ShoppingBag },
  { type: "articles", label: t("Articles"), hint: t("Your article pages, newest first."), Icon: Newspaper },
  { type: "contact", label: t("Contact"), hint: t("Email, phone, address and a map."), Icon: MapPin },
  { type: "divider", label: t("Divider"), hint: t("A line or a gap between blocks."), Icon: Minus },
];

export function blockCatalogEntry(type: SiteBlockType): BlockCatalogEntry {
  return BLOCK_CATALOG.find((entry) => entry.type === type) || BLOCK_CATALOG[0];
}
