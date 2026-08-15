// Products tab - the shop side of Billing.
//
// Presentational, like BillingReportsPanel: App.tsx owns the product list and
// every request. What lives here is form state, which is UI and nothing else.
//
// The list it edits is billing_products_services - the same rows the invoice
// line picker reads. There is deliberately no separate "stock item": a glove is
// one product whether it is sold at the counter or added to an invoice.

import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Package, Plus, Search, X } from "lucide-react";
import type { BillingCatalogItem, BillingCatalogKind, StockMovement } from "./types";
import { isLowStock } from "./stockMath";

export type ProductFormValues = {
  id: string;
  kind: BillingCatalogKind;
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
};

const KIND_LABELS: Record<BillingCatalogKind, string> = {
  product: "Product",
  service: "Service",
  package: "Package",
  "lesson-type": "Lesson type",
};

const KIND_PLURALS: Record<BillingCatalogKind, string> = {
  product: "Products",
  service: "Services",
  package: "Packages",
  "lesson-type": "Lesson types",
};

// Products first: they are the only group with stock to watch, and the only one
// worth opening the tab for. The others are mostly imported lesson types, and on
// a real account there are a hundred of them.
const KIND_ORDER: BillingCatalogKind[] = ["product", "package", "service", "lesson-type"];

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
    kind: "product",
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
    kind: product.kind,
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
}: ProductsPanelProps) {
  const [form, setForm] = useState<ProductFormDraft>(() => emptyForm(defaultTaxRate));
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  // Everything except Products starts closed - a real account has ~100 imported
  // lesson types and services, and none of them have stock to look at.
  const [collapsed, setCollapsed] = useState<Partial<Record<BillingCatalogKind, boolean>>>({
    service: true,
    package: true,
    "lesson-type": true,
  });

  // Which product's stock drawer is open, plus that drawer's form.
  const [stockFor, setStockFor] = useState("");
  const [stockMode, setStockMode] = useState<"delta" | "setTo">("delta");
  const [stockValue, setStockValue] = useState("");
  const [stockNote, setStockNote] = useState("");
  const [stockBusy, setStockBusy] = useState(false);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  const searching = search.trim().length > 0;

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
      if (await onSave(values)) setForm(emptyForm(defaultTaxRate));
    } finally {
      setSaving(false);
    }
  }

  async function openStockDrawer(product: BillingCatalogItem) {
    if (stockFor === product.id) {
      setStockFor("");
      return;
    }
    setStockFor(product.id);
    setStockMode("delta");
    setStockValue("");
    setStockNote("");
    setMovements([]);
    setMovementsLoading(true);
    try {
      setMovements(await onLoadMovements(product.id));
    } finally {
      setMovementsLoading(false);
    }
  }

  async function submitStock(product: BillingCatalogItem) {
    const value = Number(stockValue);
    if (!Number.isFinite(value) || (stockMode === "delta" && !value)) return;
    setStockBusy(true);
    try {
      if (await onAdjustStock(product, { mode: stockMode, value, note: stockNote.trim() })) {
        setStockValue("");
        setStockNote("");
        setMovementsLoading(true);
        try {
          setMovements(await onLoadMovements(product.id));
        } finally {
          setMovementsLoading(false);
        }
      }
    } finally {
      setStockBusy(false);
    }
  }

  const isProduct = form.kind === "product";

  return (
    <div className="billing-dashboard billing-products">
      <article className="data-card">
        <div className="data-card-header">
          <div>
            <span>Shop</span>
            <h2>
              {products.filter((product) => product.active !== false).length} items
              {lowStockCount > 0 && (
                <span className="unpaid-count-badge">
                  {lowStockCount} low
                </span>
              )}
            </h2>
          </div>
          <Package size={24} />
        </div>
        <p className="field-help">
          Everything you sell, in one list - the same items the invoice line picker offers. Products can also carry a
          supplier, a SKU and a stock level that counts down as they sell at the counter.
        </p>
        {stockValueTotal > 0 && (
          <p className="field-help">
            Stock on hand is worth about {formatMoney(stockValueTotal, currency)} at cost.
          </p>
        )}
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
      </article>

      <article className="data-card wide">
        <div className="data-card-header">
          <div>
            <span>{form.id ? "Editing" : "Add"}</span>
            <h2>{form.id ? form.name || "Product" : "New item"}</h2>
          </div>
          <Plus size={24} />
        </div>
        <div className="billing-catalog-editor product-editor">
          <label className="settings-field">
            <span>Name</span>
            <input
              value={form.name}
              onChange={(event) => updateForm("name", event.target.value)}
              placeholder="e.g. Titleist Players glove"
            />
          </label>
          <label className="settings-field">
            <span>Type</span>
            <select
              value={form.kind}
              onChange={(event) => updateForm("kind", event.target.value as BillingCatalogKind)}
            >
              {(Object.keys(KIND_LABELS) as BillingCatalogKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
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
          {isProduct && (
            <label className="settings-field pos-settles-toggle">
              <input
                checked={form.trackStock}
                onChange={(event) => updateForm("trackStock", event.target.checked)}
                type="checkbox"
              />
              <span>Count stock for this item</span>
            </label>
          )}
          {isProduct && form.trackStock && (
            <>
              {!form.id && (
                <label className="settings-field">
                  <span>Opening stock</span>
                  <input
                    type="number"
                    step="1"
                    value={form.openingStock}
                    onChange={(event) => updateForm("openingStock", event.target.value)}
                  />
                </label>
              )}
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
            </>
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
        {form.isVoucher && (
          <p className="field-help">
            Selling this issues a coupon with a code for the amount paid, and it turns up under Billing &gt; Coupons.
            Tick it on the products people buy on Squarespace so those purchases can be imported too.
          </p>
        )}
        {isProduct && !form.trackStock && (
          <p className="field-help">
            Not counted - use this for things like a fitting fee that you sell but never have on a shelf.
          </p>
        )}
        {form.id && (
          <p className="field-help">Stock is changed from the list below, not here, so a save can't undo a sale.</p>
        )}
        <div className="panel-actions">
          {Boolean(form.id) && (
            <button className="outline-button" onClick={() => setForm(emptyForm(defaultTaxRate))} type="button">
              Cancel Edit
            </button>
          )}
          <button
            className="primary-button"
            disabled={saving || !form.name.trim()}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? "Saving..." : form.id ? "Save Changes" : "Add Item"}
          </button>
        </div>
      </article>

      <article className="data-card wide recent-invoices-card">
        <div className="data-card-header">
          <div>
            <span>Inventory</span>
            <h2>{visible.length} shown</h2>
          </div>
          <Package size={24} />
        </div>
        {loadState === "loading" && <p>Loading products...</p>}
        {loadState === "error" && (
          <p>
            Could not load products.{" "}
            <button className="link-button" onClick={onReload} type="button">
              Retry
            </button>
          </p>
        )}
        {loadState !== "loading" && !visible.length && (
          <p>{products.length ? "Nothing matches that search." : "No products yet - add your first one above."}</p>
        )}
        {groups.map((group) => {
          const stocked = group.kind === "product";
          // A search that matched something inside a closed section would look
          // like a search that found nothing, so searching opens everything.
          const open = Boolean(searching || !collapsed[group.kind]);
          const groupLow = group.items.filter((product) => isLowStock(product)).length;
          return (
            <section className="product-group" key={group.kind}>
              <button
                className="product-group-header"
                onClick={() =>
                  setCollapsed((current) => ({ ...current, [group.kind]: !current[group.kind] }))
                }
                aria-expanded={open}
                type="button"
              >
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <strong>{KIND_PLURALS[group.kind]}</strong>
                <em>{group.items.length}</em>
                {groupLow > 0 && <span className="unpaid-count-badge">{groupLow} low</span>}
              </button>
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
                      return (
                        <Fragment key={product.id}>
                          <tr className={product.active === false ? "product-row-inactive" : ""}>
                            <td>
                              <button
                                className="link-button"
                                onClick={() => setForm(toForm(product, defaultTaxRate))}
                                type="button"
                              >
                                {product.name}
                              </button>
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
                              <button
                                className="text-link-button"
                                onClick={() => void onSetActive(product, product.active === false)}
                                type="button"
                              >
                                {product.active === false ? "Restore" : "Retire"}
                              </button>
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
