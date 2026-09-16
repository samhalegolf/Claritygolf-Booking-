// Which catalog tiles the till shows, given the selected tab and what has been
// typed.
//
// Its own file, beside couponMath and stockMath, because the rule it encodes is
// the sort that is easy to get wrong invisibly: a coach searching for something
// that exists and being shown an empty shelf.

export type CatalogTile = {
  id: string;
  name: string;
  kind: string;
  sku?: string;
  supplier?: string;
  active?: boolean;
};

export const CATALOG_TILE_LIMIT = 120;

/**
 * Typing a name is asking for that thing, wherever it lives.
 *
 * The tab and the search box used to compound: the tab narrowed to a category
 * and the search narrowed within it, so a coach sitting on Products who typed
 * "5 lesson package" saw nothing at all -- no result, and no hint that a
 * Packages tab existed. The tab was doing the searching, and losing.
 *
 * So a search reaches across every category, and the tab only decides what is
 * on the shelf when nothing has been typed.
 */
export function catalogTiles<T extends CatalogTile>(catalog: T[], tab: string, search: string): T[] {
  const needle = search.trim().toLowerCase();
  return catalog
    .filter((item) => item.active !== false)
    .filter((item) => (needle || tab === "all" ? true : item.kind === tab))
    .filter((item) =>
      needle
        ? [item.name, item.sku, item.supplier]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle))
        : true,
    )
    .slice(0, CATALOG_TILE_LIMIT);
}

/** How many of those tiles the selected tab would have hidden. */
export function offTabMatchCount<T extends CatalogTile>(tiles: T[], tab: string, search: string): number {
  if (!search.trim() || tab === "all") return 0;
  return tiles.filter((item) => item.kind !== tab).length;
}
