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
 * A lesson type opts in one of two ways. "Required": it can only be booked
 * while a resource is free. "Usable": it takes a free one when there is one,
 * and is still booked when there is not. Either way it may narrow itself to
 * whole types of resource (every "Hitting bay") or to single resources (a
 * fitting that only runs in Room A). Handedness narrows it again: a
 * left-hander needs a resource set up for lefties or for both; a right-hander
 * must not take a lefties-only one.
 *
 * Pure: no database, no provider. Callers pass in the lessons already holding
 * resources at that location, and write back whatever this picks.
 */

export type LocationKind = "physical" | "online";
export type ResourceSource = "clarity" | "external";
export type ResourceHandedness = "any" | "left" | "right";
export type ResourceMode = "none" | "usable" | "required";

export type LocationResource = {
  id: string;
  name: string;
  /** What kind of resource it is ("Hitting bay"). Lesson types can take a whole type. */
  type?: string;
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
  resourceMode?: ResourceMode;
  /** Before resourceMode: true meant "required". Read, never written. */
  needsResource?: boolean;
  /** Whole types it may take, by name. */
  resourceTypes?: string[];
  /** Single resources it may take, as "locationId/resourceId". */
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

export function cleanResourceMode(value: unknown): ResourceMode {
  return value === "usable" || value === "required" ? value : "none";
}

/** How a lesson type uses resources, reading the older needsResource flag too. */
export function serviceResourceMode(service: ResourceService | null | undefined): ResourceMode {
  if (service?.resourceMode) return cleanResourceMode(service.resourceMode);
  return service?.needsResource === true ? "required" : "none";
}

export function cleanResourceType(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Types match whatever their case, so "hitting bay" and "Hitting Bay" are one type. */
export function resourceTypeKey(value: unknown): string {
  return cleanResourceType(value).toLowerCase();
}

/** How a lesson type names one resource at one location. */
export function resourceSelectionId(locationId: string, resourceId: string) {
  return `${locationId}/${resourceId}`;
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
    const type = cleanResourceType(entry?.type);
    resources.push({
      id,
      name,
      ...(type ? { type } : {}),
      handedness: cleanResourceHandedness(entry?.handedness),
      active: entry?.active !== false,
    });
  });
  return resources;
}

/**
 * "locationId/resourceId" entries. An entry with no location is from before a
 * lesson type could run at more than one place; it is qualified with the
 * location it ran at when that is known.
 */
export function cleanServiceResourceIds(raw: unknown, legacyLocationId = ""): string[] {
  if (!Array.isArray(raw)) return [];
  const legacyLocation = slug(legacyLocationId, "");
  const ids = raw
    .map((entry) => {
      const [first, second] = String(entry ?? "").split("/");
      if (second !== undefined) {
        const locationId = slug(first, "");
        const resourceId = slug(second, "");
        return locationId && resourceId ? resourceSelectionId(locationId, resourceId) : "";
      }
      const resourceId = slug(first, "");
      if (!resourceId) return "";
      return legacyLocation ? resourceSelectionId(legacyLocation, resourceId) : resourceId;
    })
    .filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_RESOURCES);
}

export function cleanServiceResourceTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const types: string[] = [];
  for (const entry of raw) {
    const type = cleanResourceType(entry);
    const key = type.toLowerCase();
    if (!type || seen.has(key)) continue;
    seen.add(key);
    types.push(type);
  }
  return types.slice(0, MAX_RESOURCES);
}

/**
 * True when a booking of this service at this location takes one of
 * Clarity's own resources, whether it must have one or only uses one when
 * free. Everything else books without one.
 */
export function clarityResourcesApply(
  location: ResourceLocation | null | undefined,
  service: ResourceService | null | undefined,
) {
  if (!location || serviceResourceMode(service) === "none") return false;
  if (cleanLocationKind(location.kind) === "online") return false;
  if (cleanResourceSource(location.resourceSource) !== "clarity") return false;
  return (location.resources || []).some((resource) => resource.active !== false);
}

/**
 * The resources this booking may take, in the order the location lists them:
 * that order is the business's own choice of which to fill first. Handedness
 * only rules resources out -- a left-hander never gets a righties-only one and
 * a right-hander never a lefties-only one -- it never reorders them.
 */
export function eligibleResources(
  location: ResourceLocation,
  service: ResourceService,
  handedness: "left" | "right" | null = null,
): LocationResource[] {
  // Nothing chosen means any of them. A chosen type covers every resource of
  // that type, including ones added later; a chosen resource covers only
  // itself. An entry with no location (see cleanServiceResourceIds) matches
  // that resource id wherever it is.
  const types = new Set((service.resourceTypes || []).map(resourceTypeKey).filter(Boolean));
  const ids = new Set(service.resourceIds || []);
  const anything = !types.size && !ids.size;
  const chosen = (resource: LocationResource) =>
    anything ||
    types.has(resourceTypeKey(resource.type)) ||
    ids.has(resourceSelectionId(location.id || "", resource.id)) ||
    ids.has(resource.id);
  const fitsHand = (resource: LocationResource) => {
    const hand = cleanResourceHandedness(resource.handedness);
    if (handedness === "left") return hand !== "right";
    if (handedness === "right") return hand !== "left";
    return true;
  };
  return (location.resources || []).filter(
    (resource) => resource.active !== false && chosen(resource) && fitsHand(resource),
  );
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
