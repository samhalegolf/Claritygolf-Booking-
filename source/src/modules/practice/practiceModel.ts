/* Practice blocks: the shapes, and the pure edits on the category library.
 *
 * Shared by the coach's feeder and the player's Practice section, so the two
 * ends cannot drift on what a block is or how its title is built.
 */

export type PracticeSubcategory = {
  id: string;
  name: string;
};

export type PracticeCategory = {
  id: string;
  name: string;
  subcategories: PracticeSubcategory[];
};

export type PracticeBlock = {
  id: string;
  playerId: string;
  playerName: string;
  categoryId: string;
  categoryName: string;
  subcategoryId: string;
  subcategoryName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

/** What the player sees as the block's heading, and what the coach previews. */
export function practiceBlockTitle(block: Pick<PracticeBlock, "categoryName" | "subcategoryName">) {
  return [block.categoryName, block.subcategoryName].filter(Boolean).join(" · ");
}

/**
 * Ids are generated here rather than server-side so a newly added category can
 * be selected in the same breath it is typed, without waiting on a round trip.
 * The server accepts the id it is given and only mints one when it is missing.
 */
function newId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `practice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Case-insensitive, because "At home" and "at home" are the same heading. */
function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createPracticeCategory(categories: PracticeCategory[], name: string) {
  const clean = name.trim();
  const existing = categories.find((category) => sameName(category.name, clean));
  if (existing) return { categories, created: existing };
  const created: PracticeCategory = { id: newId(), name: clean, subcategories: [] };
  return { categories: [...categories, created], created };
}

export function createPracticeSubcategory(
  categories: PracticeCategory[],
  categoryId: string,
  name: string,
) {
  const clean = name.trim();
  const parent = categories.find((category) => category.id === categoryId);
  const existing = parent?.subcategories.find((sub) => sameName(sub.name, clean));
  if (existing) return { categories, created: existing };
  const created: PracticeSubcategory = { id: newId(), name: clean };
  return {
    categories: categories.map((category) =>
      category.id === categoryId
        ? { ...category, subcategories: [...category.subcategories, created] }
        : category,
    ),
    created,
  };
}

export function removePracticeCategory(categories: PracticeCategory[], categoryId: string) {
  return categories.filter((category) => category.id !== categoryId);
}

export function removePracticeSubcategory(
  categories: PracticeCategory[],
  categoryId: string,
  subcategoryId: string,
) {
  return categories.map((category) =>
    category.id === categoryId
      ? {
          ...category,
          subcategories: category.subcategories.filter((sub) => sub.id !== subcategoryId),
        }
      : category,
  );
}
