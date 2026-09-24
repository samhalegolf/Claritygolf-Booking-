/**
 * Clarity resources: the bays, rooms or nets a location has, and which one a
 * lesson holds.
 *
 * A location is either physical or online. An online location has no resources
 * and no limit. A physical one may list its resources and say who holds their
 * availability: Clarity itself, or an external system that Clarity does not
 * ask before offering a time. Only when Clarity holds it does a booking need a
 * free resource, so a location with no resources, or held elsewhere, books
 * exactly as it did before resources existed.
 *
 * A lesson type opts in with needsResource, and may narrow itself to some of
 * the location's resources (a fitting that only runs in Room A). Handedness
 * narrows it again: a left-hander needs a resource set up for lefties or for
 * both; a right-hander must not take a lefties-only one.
 *
 * Pure: no database, no provider. Callers pass in the lessons already holding
 * resources at that location, and write back whatever this picks.
 */

export type LocationKind = "physical" | "online";
export type ResourceSource = "clarity" | "external";
export type ResourceHandedness = "any" | "left" | "right";

export type LocationResource = {
  id: string;
  name: string;
  handedness: ResourceHandedness;
  active: boolean;
};

export type ResourceLocation = {
  id?: string;
  kind?: LocationKind;
  resourceSource?: ResourceSource;
  resources?: LocationResource[];
};

export type ResourceService = {
  id?: string;
  needsResource?: boolean;
  resourceIds?: string[];
};

export type ResourceSlot = { week: number; day: number; start: number; duration: number };

/** A lesson already at the location that holds, or is owed, a resource. */
export type ResourceHolder = ResourceSlot & { id: string; resourceId?: string };

const MAX_RESOURCES = 60;

function slug(value: unknown, fallback: string) {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function cleanLocationKind(value: unknown): LocationKind {
  return value === "online" ? "online" : "physical";
}

export function cleanResourceSource(value: unknown): ResourceSource {
  return value === "external" ? "external" : "clarity";
}

export function cleanResourceHandedness(value: unknown): ResourceHandedness {
  return value === "left" || value === "right" ? value : "any";
}

export function cleanLocationResources(raw: unknown): LocationResource[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const resources: LocationResource[] = [];
  raw.slice(0, MAX_RESOURCES).forEach((entry, index) => {
    const name = String(entry?.name ?? "").trim().slice(0, 60) || `Resource ${index + 1}`;
    let id = slug(entry?.id, slug(name, `resource-${index + 1}`));
    let suffix = 2;
    const base = id;
    while (seen.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    resources.push({
      id,
      name,
      handedness: cleanResourceHandedness(entry?.handedness),
      active: entry?.active !== false,
    });
  });
  return resources;
}

export function cleanServiceResourceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => slug(id, "")).filter(Boolean))].slice(0, MAX_RESOURCES);
}

/**
 * True when a booking of this service at this location must hold one of
 * Clarity's own resources. Everything else books without one.
 */
export function clarityResourcesApply(
  location: ResourceLocation | null | undefined,
  service: ResourceService | null | undefined,
) {
  if (!location || !service?.needsResource) return false;
  if (cleanLocationKind(location.kind) === "online") return false;
  if (cleanResourceSource(location.resourceSource) !== "clarity") return false;
  return (location.resources || []).some((resource) => resource.active !== false);
}

/**
 * The resources this booking may take, best first. Lefties-only resources go
 * last for anyone who is not a left-hander, so they stay free for those who
 * need them; for a left-hander they go first.
 */
export function eligibleResources(
  location: ResourceLocation,
  service: ResourceService,
  handedness: "left" | "right" | null = null,
): LocationResource[] {
  const allowed = new Set(service.resourceIds || []);
  const candidates = (location.resources || []).filter(
    (resource) => resource.active !== false && (!allowed.size || allowed.has(resource.id)),
  );
  const rank = (resource: LocationResource) => {
    const hand = cleanResourceHandedness(resource.handedness);
    if (handedness === "left") return hand === "left" ? 0 : hand === "any" ? 1 : 9;
    if (handedness === "right") return hand === "right" ? 0 : hand === "any" ? 1 : 9;
    return hand === "left" ? 2 : hand === "right" ? 0 : 1;
  };
  return candidates
    .map((resource, index) => ({ resource, index, rank: rank(resource) }))
    .filter((entry) => entry.rank < 9)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.resource);
}

function overlaps(a: ResourceSlot, b: ResourceSlot) {
  return (
    Number(a.week) === Number(b.week) &&
    Number(a.day) === Number(b.day) &&
    a.start < b.start + b.duration &&
    a.start + a.duration > b.start
  );
}

/**
 * The resource this booking would get, or null when every one it may take is
 * held for some of that time.
 *
 * A holder with no resource recorded (booked before this location had
 * resources, or while none was free) still occupies one, so it is counted
 * against whatever is left rather than ignored.
 */
export function pickFreeResource({
  location,
  service,
  slot,
  holders,
  handedness = null,
  ignoreId = "",
  preferResourceId = "",
}: {
  location: ResourceLocation;
  service: ResourceService;
  slot: ResourceSlot;
  holders: ResourceHolder[];
  handedness?: "left" | "right" | null;
  ignoreId?: string;
  preferResourceId?: string;
}): LocationResource | null {
  const eligible = eligibleResources(location, service, handedness);
  if (!eligible.length) return null;
  const known = new Set((location.resources || []).map((resource) => resource.id));
  const overlapping = holders.filter((holder) => holder.id !== ignoreId && overlaps(holder, slot));
  const taken = new Set(
    overlapping.map((holder) => holder.resourceId || "").filter((resourceId) => known.has(resourceId)),
  );
  const unplaced = overlapping.filter((holder) => !holder.resourceId || !known.has(holder.resourceId)).length;
  const free = eligible.filter((resource) => !taken.has(resource.id));
  if (free.length <= unplaced) return null;
  // Staying put beats the "best" resource: a lesson that moves ten minutes
  // should not swap bays when its own is still free.
  return free.find((resource) => resource.id === preferResourceId) || free[0];
}
