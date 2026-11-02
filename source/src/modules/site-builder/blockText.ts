// Words typed over on the page, written back into their section.
//
// The renderer names each editable field with a path (SiteRenderer's
// EditableText): "heading" for a field of the section itself, or
// "items.<item id>.title" for a field of one item in its list. Only a field
// that is already text can be written, so a path can never turn a list, a
// picture or a setting into words.

import type { SiteBlock } from "../../../netlify/functions/_shared/site/document.mts";

export function setBlockField(block: SiteBlock, path: string, value: string): SiteBlock {
  const parts = path.split(".");
  const fields = block as unknown as Record<string, unknown>;
  if (parts.length === 1) {
    return typeof fields[parts[0]] === "string" ? ({ ...block, [parts[0]]: value } as SiteBlock) : block;
  }
  if (parts.length === 3 && parts[0] === "items" && Array.isArray(fields.items)) {
    const [, itemId, field] = parts;
    let changed = false;
    const items = (fields.items as Array<Record<string, unknown>>).map((item) => {
      if (item.id !== itemId || typeof item[field] !== "string") return item;
      changed = true;
      return { ...item, [field]: value };
    });
    return changed ? ({ ...block, items } as SiteBlock) : block;
  }
  return block;
}
