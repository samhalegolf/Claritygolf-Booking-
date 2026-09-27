// The part of a business's account that anyone on the internet may read.
//
// The public booking endpoints used to send the whole coach account, invoice
// settings and all: bank account, tax number, business address, contact email
// and invoice wording, to every visitor of the booking page. None of it was
// shown, but all of it could be read from the page's network traffic.
//
// This is an allow-list on purpose. A field added to the account later stays
// private until someone decides the booking page needs it.

import { terminologyFor } from "./business-terminology.mts";

type AccountLike = {
  id?: unknown;
  coachName?: unknown;
  businessName?: unknown;
  venueName?: unknown;
  venueShortName?: unknown;
  timezone?: unknown;
  country?: unknown;
  bookingUrl?: unknown;
  calendarSlug?: unknown;
  caddyWorkspaceUrl?: unknown;
  terminology?: unknown;
  invoiceSettings?: {
    currency?: unknown;
    taxName?: unknown;
    taxRate?: unknown;
    taxInclusive?: unknown;
  } | null;
};

export function publicCoachAccount(account: AccountLike | null | undefined) {
  const invoice = account?.invoiceSettings ?? {};
  return {
    id: account?.id,
    coachName: account?.coachName,
    businessName: account?.businessName,
    venueName: account?.venueName,
    venueShortName: account?.venueShortName,
    timezone: account?.timezone,
    country: account?.country,
    bookingUrl: account?.bookingUrl,
    calendarSlug: account?.calendarSlug,
    caddyWorkspaceUrl: account?.caddyWorkspaceUrl,
    terminology: terminologyFor(account),
    // Only what a price needs: its currency, and the tax to name beside it.
    invoiceSettings: {
      currency: invoice.currency,
      taxName: invoice.taxName,
      taxRate: invoice.taxRate,
      taxInclusive: invoice.taxInclusive,
    },
  };
}
