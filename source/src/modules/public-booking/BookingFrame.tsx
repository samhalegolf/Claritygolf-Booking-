// The booking page's outer frame and the bits of the business it is drawn
// with. Shared by the booking page and the shop, which are the same page to a
// customer: same brand header, same colours, same prices.
import type { CSSProperties, ReactNode } from "react";
import { currencyForAccountSettings, localeForCountry } from "../../../netlify/functions/_shared/locale.mts";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";

export type Brand = { logoPreview?: string; showLogo?: boolean; neutral?: string; primary?: string; secondary?: string; accent?: string; bookingTheme?: string };
export type Account = { businessName?: string; coachName?: string; venueShortName?: string; country?: string; terminology?: BusinessTerminology; market?: unknown; invoiceSettings?: { currency?: string; taxName?: string; taxRate?: number; taxInclusive?: boolean } };

/** An amount in the business's own currency. */
export function money(value: number, account: Account) {
  const currency = currencyForAccountSettings(account.invoiceSettings?.currency, account.country);
  try {
    return new Intl.NumberFormat(localeForCountry(account.country), {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

/** The frame the coach app's Booking page preview gives this same markup:
 *  .app-shell for the compatibility variables every booking rule reads
 *  (--coach-primary, --panel, --border ...), the business's brand colours from
 *  the catalogue, and the booking theme the coach chose. Without it the page
 *  rendered with those variables unset, so every colour-mix of them was
 *  dropped -- selected lessons, days and times showed no fill and the brand
 *  header lost its gradient. */
export function BookingFrame({ brand, children }: { brand: Brand; children: ReactNode }) {
  const style = Object.fromEntries(
    ([["--coach-neutral", brand.neutral], ["--coach-primary", brand.primary], ["--coach-secondary", brand.secondary], ["--coach-accent", brand.accent]] as const)
      .filter(([, value]) => typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value)),
  ) as CSSProperties;
  return <div className="app-shell embed-mode public-booking-frame" style={style}>{children}</div>;
}
