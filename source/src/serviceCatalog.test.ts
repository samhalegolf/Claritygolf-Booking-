import assert from "node:assert/strict";
import test from "node:test";

import { isManagedService } from "./serviceCatalog";

test("the integration-only External Booking bucket is not a manageable lesson type", () => {
  assert.equal(isManagedService({ id: "external-booking" }), false);
  assert.equal(isManagedService({ id: "private-lesson" }), true);
});
