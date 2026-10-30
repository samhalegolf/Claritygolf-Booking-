// Who pays for a custom group lesson, and the link each friend is sent.
//
// The booker decides before confirming whether they are paying for everyone
// ("booker") or splitting it evenly ("split"). That decides what every invite
// says: a split invite carries the friend's share and a way to pay it; a
// covered one only asks them to say they're coming.
//
// A booking made before the choice existed has no `groupPayment`. Those were
// all split -- the invite email always carried each person's share -- so a
// missing value reads as "split".

export type GroupPayment = "booker" | "split";

export function cleanGroupPayment(value: unknown): GroupPayment {
  return value === "booker" ? "booker" : "split";
}

/** How a friend was sent their invite: the booker's own message, or our email. */
export type InviteMethod = "email" | "link";

export function cleanInviteMethod(value: unknown): InviteMethod | undefined {
  return value === "email" || value === "link" ? value : undefined;
}

type GroupLike = {
  customGroup?: boolean;
  groupPayment?: unknown;
  attendees?: unknown[];
  calculatedPrice?: unknown;
};

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Everyone on the booking, the booker included. */
export function groupSize(appt: GroupLike) {
  return appt.customGroup && Array.isArray(appt.attendees) ? appt.attendees.length : 0;
}

/** One person's even share of the lesson; 0 when there is nothing to share. */
export function evenShare(appt: GroupLike) {
  const size = groupSize(appt);
  const total = Number(appt.calculatedPrice) || 0;
  return size && total > 0 ? round2(total / size) : 0;
}

/**
 * What one invited friend is asked to pay. Nothing when the booker is covering
 * the group: their invite has no share and no pay link.
 */
export function friendShareAmount(appt: GroupLike) {
  return cleanGroupPayment(appt.groupPayment) === "booker" ? 0 : evenShare(appt);
}

/**
 * What the booker pays if they pay online: their own share when it is split,
 * the whole lesson when they are covering it.
 */
export function bookerGroupAmount(appt: GroupLike) {
  const total = round2(Number(appt.calculatedPrice) || 0);
  return cleanGroupPayment(appt.groupPayment) === "booker" ? total : evenShare(appt);
}

/**
 * The page a friend opens from their invite, by email or a shared message. It
 * names the business, so it still finds the booking once there is more than
 * one business on the platform.
 */
export function customGroupInviteUrl(base: string, accountId: string, token: string) {
  if (!token) return "";
  try {
    const url = new URL("/api/custom-group-confirm", base || "https://claritygolf.app");
    if (accountId) url.searchParams.set("business", accountId);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return "";
  }
}
