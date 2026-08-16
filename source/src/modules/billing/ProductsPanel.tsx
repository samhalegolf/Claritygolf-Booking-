// Products tab - the shop side of Billing, and the first screen Billing opens.
//
// Presentational, like BillingReportsPanel: App.tsx owns the list and every
// request. What lives here is form state, which is UI and nothing else.
//
// Two kinds of thing appear in the list and they come from different places:
//
//   Products  - rows in billing_products_services, added and edited here.
//   Services  - the coach's lesson types, read-only (readOnly on the item).
//   Packages    A lesson price is changed on the lesson type, under Settings,
//               so it can never disagree with what the booking screen charges.
//
// The panel is built around adding something fast: one row of fields at the
// top, Enter saves, focus returns to the name. The full set of fields only
// appears once you ask for it, or when you click an existing product to edit.

import { Fragment, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Lock, Package, Plus, Search, X } from "lucide-react";
import type { BillingCatalogItem, BillingCatalogKind, StockMovement } from "./types";
import { isLowStock } from "./stockMath";

export type ProductFormValues = {
  id: string;
  // Carried, not chosen: editing a retired product must not restore it. Retire
  // and Restore are the buttons in the list.
  active: boolean;
  name: string;
  supplier: string;
  sku: string;
  description: string;
  price: number;
  costPrice: number;
  taxRate: number;
  trackStock: boolean;
  lowStockThreshold: number;
  // Selling this issues a gift voucher rather than just taking money.
  isVoucher: boolean;
  // Only sent when creating - stock on an existing product moves through an
  // adjustment so a save can't undo a sale made while the form was open.
  openingStock: number;
};

export type StockAdjustInput = { mode: "delta" | "setTo"; value: number; note: string };

// The form holds its numbers as strings. Parsing on every keystroke turns
// "29." into 29 and eats the decimal point as you type it, which makes entering
// a price like 29.95 genuinely hard. They are converted once, on save.
type ProductFormDraft = Omit<ProductFormValues, "price" | "costPrice" | "taxRate" | "lowStockThreshold" | "openingStock"> & {
  price: string;
  costPrice: string;
  taxRate: string;
  lowStockThreshold: string;
  openingStock: string;
};

function toNumber(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type ProductsPanelProps = {
  products: BillingCatalogItem[];
  loadState: "idle" | "loading" | "loaded" | "error";
  currency: string;
  defaultTaxRate: number;
  formatMoney: (amount: number, currency?: string) => string;
  onReload: () => void;
  onSave: (values: ProductFormValues) => Promise<boolean>;
  onSetActive: (product: BillingCatalogItem, active: boolean) => Promise<void>;
  onAdjustStock: (product: BillingCatalogItem, input: StockAdjustInput) => Promise<boolean>;
  onLoadMovements: (productId: string) => Promise<StockMovement[]>;
  // Takes the coach to where lesson types are edited. Services in this list
  // are only shown here; they belong to that screen.
  onEditLessonTypes: () => void;
};

const KIND_PLURALS: Record<BillingCatalogKind, string> = {
  product: "Products",
  service: "Services",
  package: "Packages",
};

// Products first: they are the only group you can edit here, and the only one
// with stock to watch.
const KIND_ORDER: BillingCatalogKind[] = ["product", "package", "service"];

const MOVEMENT_LABELS: Record<StockMovement["kind"], string> = {
  adjustment: "Adjusted",
  stocktake: "Stocktake",
  receipt: "Received",
  sale: "Sold",
  sale_reversal: "Returned",
};

function emptyForm(taxRate: number): ProductFormDraft {
  return {
    id: "",
    active: true,
    name: "",
    supplier: "",
    sku: "",
    description: "",
    price: "",
    costPrice: "",
    taxRate: String(taxRate),
    trackStock: true,
    lowStockThreshold: "",
    openingStock: "",
    isVoucher: false,
  };
}

function toForm(product: BillingCatalogItem, fallbackTaxRate: number): ProductFormDraft {
  return {
    id: product.id,
    active: product.active !== false,
    name: product.name,
    supplier: product.supplier || "",
    sku: product.sku || "",
    description: product.description || "",
    price: String(product.price ?? 0),
    costPrice: String(product.costPrice || 0),
    taxRate: String(product.taxRate ?? fallbackTaxRate),
    trackStock: product.trackStock !== false,
    lowStockThreshold: String(product.lowStockThreshold || 0),
    openingStock: "",
    isVoucher: product.isVoucher === true,
  };
}

// Margin is only meaningful once both prices are set; a product with no cost
// recorded shows nothing rather than a misleading 100%.
function marginLabel(product: BillingCatalogItem) {
  const cost = Number(product.costPrice) || 0;
  const price = Number(product.price) || 0;
  if (cost <= 0 || price <= 0) return "";
  return `${Math.round(((price - cost) / price) * 100)}% margin`;
}

export function ProductsPanel({
  products,
  loadState,
  currency,
  defaultTaxRate,
  formatMoney,
  onReload,
  onSave,
  onSetActive,
  onAdjustStock,
  onLoadMovements,
  onEditLessonTypes,
}: ProductsPanelProps) {
  const [form, setForm] = useState<ProductFormDraft>(() => emptyForm(defaultTaxRate));
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  // The quick row is four fields. Everything else - cost, tax, SKU, supplier,
  // voucher, notes - is behind "More", because on the run you are adding a name
  // and a price and nothing else. Editing an existing product opens it.
  const [showDetail, setShowDetail] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<BillingCatalogKind, boolean>>>({});

  // Which product's stock drawer is open, plus that drawer's form.
  const [stockFor, setStockFor] = useState("");
  const [stockMode, setStockMode] = useState<"delta" | "setTo">("delta");
  const [stockValue, setStockValue] = useState("");
  const [stockNote, setStockNote] = useState("");
  const [stockBusy, setStockBusy] = useState(false);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  // Opening B's drawer while A's history is still in flight used to let A's
  // late response land under B's name, with no sign anything was wrong. Every
  // load carries the product it was for, and a stale one is dropped.
  const movementsForRef = useRef("");

  const searching = search.trim().length > 0;
  const editing = Boolean(form.id);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products.filter((product) => {
      if (!showInactive && product.active === false) return false;
      if (!needle) return true;
      return [product.name, product.sku, product.supplier, product.description]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [products, search, showInactive]);

  // One section per kind, in KIND_ORDER, skipping kinds with nothing in them.
  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({ kind, items: visible.filter((product) => product.kind === kind) })).filter(
        (group) => group.items.length > 0,
      ),
    [visible],
  );

  const lowStockCount = useMemo(
    () => products.filter((product) => product.active !== false && isLowStock(product)).length,
    [products],
  );

  const stockValueTotal = useMemo(
    () =>
      products
        .filter((product) => product.active !== false && product.trackStock)
        .reduce((total, product) => total + (Number(product.stockLevel) || 0) * (Number(product.costPrice) || 0), 0),
    [products],
  );

  function updateForm<K extends keyof ProductFormDraft>(key: K, value: ProductFormDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function resetForm() {
    setForm(emptyForm(defaultTaxRate));
    setShowDetail(false);
  }

  async function submit() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const values: ProductFormValues = {
        ...form,
        name: form.name.trim(),
        price: toNumber(form.price),
        costPrice: toNumber(form.costPrice),
        taxRate: toNumber(form.taxRate, defaultTaxRate),
        lowStockThreshold: toNumber(form.lowStockThreshold),
        openingStock: toNumber(form.openingStock),
      };
      if (await onSave(values)) {
        resetForm();
        // Straight back to the name box: adding one thing usually means adding
        // the next thing off the same delivery docket.
        nameRef.current?.focus();
      }
    } finally {
      setSaving(false);
    }
  }

  // Enter anywhere in the quick row saves. A textarea is deliberately excluded -
  // Enter there is a new line.
  function onQuickKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter") return;
    if ((event.target as HTMLElement)?.tagName === "TEXTAREA") return;
    event.preventDefault();
    void submit();
  }

  function startEdit(product: BillingCatalogItem) {
    setForm(toForm(product, defaultTaxRate));
    setShowDetail(true);
    nameRef.current?.focus();
  }

  async function loadMovementsFor(productId: string) {
    movementsForRef.current = productId;
    setMovementsLoading(true);
    try {
      const loaded = await onLoadMovements(productId);
      if (movementsForRef.current !== productId) return;
      setMovements(loaded);
    } finally {
      if (movementsForRef.current === productId) setMovementsLoading(false);
    }
  }

  async function openStockDrawer(product: BillingCatalogItem) {
    if (stockFor === product.id) {
      setStockFor("");
      movementsForRef.current = "";
      return;
    }
    setStockFor(product.id);
    setStockMode("delta");
    setStockValue("");
    setStockNote("");
    setMovements([]);
    await loadMovementsFor(product.id);
  }

  async function submitStock(product: BillingCatalogItem) {
    const value = Number(stockValue);
    if (!Number.isFinite(value) || (stockMode === "delta" && !value)) return;
    setStockBusy(true);
    try {
      if (await onAdjustStock(product, { mode: stockMode, value, note: stockNote.trim() })) {
        setStockValue("");
        setStockNote("");
        await loadMovementsFor(product.id);
      }
    } finally {
      setStockBusy(false);
    }
  }

  return (
    <div className="billing-dashboard billing-products">
      {/* Add first, list second. This is the screen Billing opens on, and the
          most common reason to be here is putting something new in. */}
      <article className="data-card wide product-quick-card">
        <div className="data-card-header">
          <div>
            <span>{editing ? "Editing product" : "Add a product"}</span>
            <h2>{editing ? form.name || "Product" : "What are you selling?"}</h2>
          </div>
          <Plus size={24} />
        </div>
        <div className="product-quick-row" onKeyDown={onQuickKeyDown}>
          <label className="settings-field product-quick-name">
            <span>Name</span>
            <input
              ref={nameRef}
              value={form.name}
              onChange={(event) => updateForm("name", event.target.value)}
              placeholder="e.g. Titleist Players glove"
            />
          </label>
          <label className="settings-field">
            <span>Sell price ({currency})</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.price}
              onChange={(event) => updateForm("price", event.target.value)}
            />
          </label>
          {form.trackStock && !editing && (
            <label className="settings-field product-quick-stock">
              <span>In stock</span>
              <input
                type="number"
                step="1"
                value={form.openingStock}
                onChange={(event) => updateForm("openingStock", event.target.value)}
                placeholder="0"
              />
            </label>
          )}
          <button
            className="primary-button product-quick-save"
            disabled={saving || !form.name.trim()}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? "Saving..." : editing ? "Save" : "Add"}
          </button>
          <button className="outline-button" onClick={() => setShowDetail((open) => !open)} type="button">
            {showDetail ? "Less" : "More"}
          </button>
          {editing && (
            <button className="text-link-button" onClick={resetForm} type="button">
              Cancel
            </button>
          )}
        </div>

        {showDetail && (
          <div className="billing-catalog-editor product-editor" onKeyDown={onQuickKeyDown}>
            <label className="settings-field">
              <span>Supplier</span>
              <input
                value={form.supplier}
                onChange={(event) => updateForm("supplier", event.target.value)}
                placeholder="Who you buy it from"
              />
            </label>
            <label className="settings-field">
              <span>SKU</span>
              <input
                value={form.sku}
                onChange={(event) => updateForm("sku", event.target.value)}
                placeholder="Optional - must be unique"
              />
            </label>
            <label className="settings-field">
              <span>Cost price ({currency})</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.costPrice}
                onChange={(event) => updateForm("costPrice", event.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>Tax rate %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={form.taxRate}
                onChange={(event) => updateForm("taxRate", event.target.value)}
              />
            </label>
            <label className="settings-field pos-settles-toggle">
              <input
                checked={form.trackStock}
                onChange={(event) => updateForm("trackStock", event.target.checked)}
                type="checkbox"
              />
              <span>Count stock for this item</span>
            </label>
            {form.trackStock && (
              <label className="settings-field">
                <span>Warn me at</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.lowStockThreshold}
                  onChange={(event) => updateForm("lowStockThreshold", event.target.value)}
                />
              </label>
            )}
            <label className="settings-field pos-settles-toggle">
              <input
                checked={form.isVoucher}
                onChange={(event) => updateForm("isVoucher", event.target.checked)}
                type="checkbox"
              />
              <span>This is a gift voucher</span>
            </label>
            <label className="settings-field product-notes-field">
              <span>Notes</span>
              <textarea
                value={form.description}
                onChange={(event) => updateForm("description", event.target.value)}
                rows={2}
                placeholder="Optional - shows on the invoice line"
              />
            </label>
          </div>
        )}

        {form.isVoucher && (
          <p className="field-help">
            Selling this issues a coupon with a code for the amount paid, and it turns up under Billing &gt; Coupons.
            Tick it on the products people buy on Squarespace so those purchases can be imported too.
          </p>
        )}
        {showDetail && !form.trackStock && (
          <p className="field-help">
            Not counted - use this for something like a fitting fee that you sell but never have on a shelf.
          </p>
        )}
        {editing && !form.active && (
          <p className="field-help">
            This one is retired. Saving leaves it retired - use Restore in the list to bring it back.
          </p>
        )}
        {editing && <p className="field-help">Stock is changed from the list below, not here, so a save can't undo a sale.</p>}
        {!editing && !showDetail && (
          <p className="field-help">
            Name and price is enough to start selling it. Press Enter to save. Lessons don't belong here - they come
            from your lesson types.
          </p>
        )}
      </article>

      <article className="data-card wide recent-invoices-card">
        <div className="data-card-header">
          <div>
            <span>Catalog</span>
            <h2>
              {visible.length} shown
              {lowStockCount > 0 && <span className="unpaid-count-badge">{lowStockCount} low</span>}
            </h2>
          </div>
          <Package size={24} />
        </div>
        <div className="settings-field-row product-search-row">
          <div className="settings-field product-search-field">
            <label htmlFor="product-search">Search</label>
            <div className="product-search-input">
              <Search size={15} />
              <input
                id="product-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, SKU or supplier"
              />
              {Boolean(search) && (
                <button className="icon-button small" onClick={() => setSearch("")} type="button" aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          <label className="settings-field pos-settles-toggle">
            <input checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} type="checkbox" />
            <span>Show retired items</span>
          </label>
          <button className="outline-button" onClick={onReload} type="button">
            Refresh
          </button>
        </div>
        {stockValueTotal > 0 && (
          <p className="field-help">Stock on hand is worth about {formatMoney(stockValueTotal, currency)} at cost.</p>
        )}

        {loadState === "loading" && <p>Loading catalog...</p>}
        {loadState === "error" && (
          <p>
            Could not load the catalog.{" "}
            <button className="link-button" onClick={onReload} type="button">
              Retry
            </button>
          </p>
        )}
        {loadState !== "loading" && !visible.length && (
          <p>{products.length ? "Nothing matches that search." : "Nothing here yet - add your first product above."}</p>
        )}
        {groups.map((group) => {
          const stocked = group.kind === "product";
          // A search that matched something inside a closed section would look
          // like a search that found nothing, so searching opens everything.
          const open = Boolean(searching || !collapsed[group.kind]);
          const groupLow = group.items.filter((product) => isLowStock(product)).length;
          const lessons = group.kind !== "product";
          return (
            <section className="product-group" key={group.kind}>
              <button
                className="product-group-header"
                onClick={() => setCollapsed((current) => ({ ...current, [group.kind]: !current[group.kind] }))}
                aria-expanded={open}
                type="button"
              >
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <strong>{KIND_PLURALS[group.kind]}</strong>
                <em>{group.items.length}</em>
                {groupLow > 0 && <span className="unpaid-count-badge">{groupLow} low</span>}
                {lessons && <Lock className="product-group-lock" size={13} />}
              </button>
              {open && lessons && (
                <p className="field-help product-group-note">
                  Your lesson types, priced where they are booked.{" "}
                  <button className="link-button" onClick={onEditLessonTypes} type="button">
                    Edit lesson types
                  </button>
                </p>
              )}
              {open && (
                <table className="recent-invoices-table product-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      {stocked && <th>SKU</th>}
                      {stocked && <th>Supplier</th>}
                      {stocked && <th>Stock</th>}
                      <th>Price</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((product) => {
                      const low = isLowStock(product);
                      const drawerOpen = stockFor === product.id;
                      const readOnly = product.readOnly === true;
                      return (
                        <Fragment key={product.id}>
                          <tr className={product.active === false ? "product-row-inactive" : ""}>
                            <td>
                              {readOnly ? (
                                <span className="product-row-name">{product.name}</span>
                              ) : (
                                <button className="link-button" onClick={() => startEdit(product)} type="button">
                                  {product.name}
                                </button>
                              )}
                              {(product.active === false ||
                                product.isVoucher ||
                                marginLabel(product) ||
                                product.description) && (
                                <em className="product-row-meta">
                                  {[
                                    product.active === false ? "Retired" : "",
                                    product.isVoucher ? "Gift voucher" : "",
                                    marginLabel(product),
                                    stocked ? "" : product.description,
                                  ]
                                    .filter(Boolean)
                                    .join(" - ")}
                                </em>
                              )}
                            </td>
                            {stocked && <td>{product.sku || "-"}</td>}
                            {stocked && <td>{product.supplier || "-"}</td>}
                            {stocked && (
                              <td>
                                {product.trackStock ? (
                                  <span className={`product-stock${low ? " low" : ""}`}>
                                    {low && <AlertTriangle size={13} />}
                                    {product.stockLevel ?? 0}
                                  </span>
                                ) : (
                                  <span className="product-stock untracked">not counted</span>
                                )}
                              </td>
                            )}
                            <td>{formatMoney(product.price, currency)}</td>
                            <td className="product-row-actions">
                              {product.trackStock && (
                                <button className="link-button" onClick={() => void openStockDrawer(product)} type="button">
                                  {drawerOpen ? "Close" : "Stock"}
                                </button>
                              )}
                              {!readOnly && (
                                <button
                                  className="text-link-button"
                                  onClick={() => void onSetActive(product, product.active === false)}
                                  type="button"
                                >
                                  {product.active === false ? "Restore" : "Retire"}
                                </button>
                              )}
                            </td>
                          </tr>
                          {drawerOpen && (
                            <tr className="product-stock-row">
                              <td colSpan={stocked ? 6 : 3}>
                                <div className="product-stock-drawer">
                                  <div className="settings-field-row">
                                    <label className="settings-field">
                                      <span>Change</span>
                                      <select
                                        value={stockMode}
                                        onChange={(event) => setStockMode(event.target.value as "delta" | "setTo")}
                                      >
                                        <option value="delta">Add / remove</option>
                                        <option value="setTo">Counted on the shelf</option>
                                      </select>
                                    </label>
                                    <label className="settings-field">
                                      <span>{stockMode === "delta" ? "Quantity (use -2 to remove)" : "Actual count"}</span>
                                      <input
                                        type="number"
                                        step="1"
                                        value={stockValue}
                                        onChange={(event) => setStockValue(event.target.value)}
                                      />
                                    </label>
                                    <label className="settings-field">
                                      <span>Reason</span>
                                      <input
                                        value={stockNote}
                                        onChange={(event) => setStockNote(event.target.value)}
                                        placeholder="Optional - e.g. delivery, damaged"
                                      />
                                    </label>
                                    <button
                                      className="outline-button"
                                      disabled={stockBusy || stockValue === ""}
                                      onClick={() => void submitStock(product)}
                                      type="button"
                                    >
                                      {stockBusy ? "Saving..." : "Apply"}
                                    </button>
                                  </div>
                                  <div className="product-movement-list">
                                    {movementsLoading && <p className="field-help">Loading history...</p>}
                                    {!movementsLoading && !movements.length && (
                                      <p className="field-help">No stock movements recorded yet.</p>
                                    )}
                                    {!movementsLoading &&
                                      movements.map((movement) => (
                                        <div key={movement.id} className="product-movement">
                                          <strong className={movement.delta < 0 ? "negative" : "positive"}>
                                            {movement.delta > 0 ? `+${movement.delta}` : movement.delta}
                                          </strong>
                                          <span>
                                            {MOVEMENT_LABELS[movement.kind] || movement.kind}
                                            {movement.note ? ` - ${movement.note}` : ""}
                                          </span>
                                          <em>
                                            {movement.createdAt ? new Date(movement.createdAt).toLocaleString() : ""}
                                            {movement.resultingLevel === null ? "" : ` - left ${movement.resultingLevel}`}
                                          </em>
                                        </div>
                                      ))}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </article>
    </div>
  );
}
