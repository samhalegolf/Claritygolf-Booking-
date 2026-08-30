import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanInvoiceCustomField,
  cleanInvoiceSettings,
  printableInvoiceCustomFields,
} from "./invoiceSettings.ts";
import type { InvoiceCustomField } from "./types.ts";

function field(partial: Partial<InvoiceCustomField> = {}): InvoiceCustomField {
  return { id: "field-1", label: "Bank Name", value: "Sam Hale Golf", placement: "footer", ...partial };
}

// Both of these run on the settings draft on every keystroke, so what they
// return is what the Billing Settings inputs render from.
test("a blank custom field survives normalisation so Add Field adds a visible row", () => {
  const settings = cleanInvoiceSettings({
    customFields: [{ id: "field-9", label: "", value: "", placement: "footer" }],
  });
  assert.equal(settings.customFields.length, 1);
  assert.deepEqual(settings.customFields[0], { id: "field-9", label: "", value: "", placement: "footer" });
});

test("a custom field label keeps the space that is being typed", () => {
  const typed = cleanInvoiceCustomField(field({ label: "Bank ", value: "12-3456-" }));
  assert.equal(typed?.label, "Bank ");
  assert.equal(typed?.value, "12-3456-");
});

test("custom fields keep their id and placement, and fall back for the rest", () => {
  assert.deepEqual(cleanInvoiceCustomField({ placement: "nope" as never }, 3), {
    id: "field-4",
    label: "",
    value: "",
    placement: "header",
  });
  assert.equal(cleanInvoiceCustomField(undefined), null);
});

test("printing drops the rows the coach has not filled in and trims the rest", () => {
  const printed = printableInvoiceCustomFields([
    field({ id: "a", label: " Bank Name ", value: " 12-3456-7890123-00 " }),
    field({ id: "b", label: "  ", value: "   " }),
    field({ id: "c", label: "", value: "Value only" }),
  ]);
  assert.deepEqual(printed, [
    { id: "a", label: "Bank Name", value: "12-3456-7890123-00", placement: "footer" },
    { id: "c", label: "Custom field", value: "Value only", placement: "footer" },
  ]);
});
