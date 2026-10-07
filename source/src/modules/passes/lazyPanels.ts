import { lazy } from "react";

// The Passes tab on a client profile. Loaded on demand like the rest: most
// visits to a profile are about a booking or a note, not an entitlement.
export const PassInboxPanel = lazy(() =>
  import("./PassInboxPanel").then((module) => ({ default: module.PassInboxPanel })),
);
export const PassesPanel = lazy(() =>
  import("./PassesPanel").then((module) => ({ default: module.PassesPanel })),
);
export const MembershipsPanel = lazy(() =>
  import("../memberships/MembershipsPanel").then((module) => ({ default: module.MembershipsPanel })),
);
export const PersonMemberships = lazy(() =>
  import("../memberships/PersonMemberships").then((module) => ({ default: module.PersonMemberships })),
);
export const IssuedPassesPanel = lazy(() =>
  import("./IssuedPassesPanel").then((module) => ({ default: module.IssuedPassesPanel })),
);
export const PassClientPicker = lazy(() =>
  import("./PassClientPicker").then((module) => ({ default: module.PassClientPicker })),
);
export const PassTypesList = lazy(() =>
  import("./PassTypesList").then((module) => ({ default: module.PassTypesList })),
);
export const RewardsPanel = lazy(() =>
  import("../rewards/RewardsPanel").then((module) => ({ default: module.RewardsPanel })),
);
export const PersonRewards = lazy(() =>
  import("../rewards/PersonRewards").then((module) => ({ default: module.PersonRewards })),
);
