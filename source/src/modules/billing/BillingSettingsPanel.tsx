// Billing › Settings: Clarity Pay, payment history re-read, defaults for new
// invoices, payment methods, discounts and expense categories. Drawn here;
// the editors and their save handlers still live in App.tsx and arrive as
// props. Loaded with the section, not with the shell.
import { t } from "../../lib/i18n";
import { EditableSettingsBlock, SettingsGroup, SettingsGroups } from "../settings/SettingsLayout";
import { Nfc, Percent, Plus, RefreshCw } from "lucide-react";
import { ClarityInvoices, ClarityPayments, ClaritySettings } from "../shared/ClarityIcons";
import { clarityPayFeeLabel, formatMoney, parseMoneyInput, parseQuantityInput } from "../../lib/money";
import { Suspense, lazy } from "react";
import { Loading } from "../shared/Loading";
import { tapToPayName } from "./terminal";
import { ClarityPayReturnBanner } from "./ClarityPayReturnBanner";
import type { ProfileTarget } from "../business-hub/BusinessHubPanel";
import type { EditableBlockStatus } from "../settings/SettingsLayout";
import type { View, WorkspaceOverlay } from "../shared/appView";
import type { CoachAccount } from "../workspace/workspaceModel";
import type { ClarityPayReturn } from "./ClarityPayReturnBanner";
import type { BillingDiscount, BillingDiscountType, BillingExpenseCategory, InvoiceSettings, PosPaymentMethod } from "./types";
import type { Dispatch, SetStateAction } from "react";
const TapToPaySetup = lazy(() =>
  import("./TapToPaySetup").then((module) => ({ default: module.TapToPaySetup })),
);


export type BillingSettingsPanelProps = {
  stripeStatus: { configured: boolean; account: string; testMode: boolean; route: "clarity_pay" | "own_stripe" | ""; fee: { percent: number; fixedCents: number; }; } | null;
  invoiceSettingsDraft: InvoiceSettings;
  billingSettingsIsLocked: boolean;
  updateBillingAccountDraft: <K extends keyof InvoiceSettings>(field: K, value: InvoiceSettings[K]) => void;
  discountEditor: { id: string; name: string; discountType: BillingDiscountType; value: number; couponCode: string; };
  setDiscountEditor: Dispatch<SetStateAction<{ id: string; name: string; discountType: BillingDiscountType; value: number; couponCode: string; }>>;
  stripeSaving: boolean;
  invoiceSettings: InvoiceSettings;
  stripeResyncing: boolean;
  posMethodEditor: { id: string; name: string; settlesImmediately: boolean; };
  setPosMethodEditor: Dispatch<SetStateAction<{ id: string; name: string; settlesImmediately: boolean; }>>;
  clarityPaySetup: "active" | "none" | "pending";
  stripeResyncProgress: { done: number; total: number; } | null;
  billingSettingsEditor: { savedValue: CoachAccount; draftValue: CoachAccount; status: EditableBlockStatus; dirty: boolean; errorMessage: string | null; edit: () => void; cancel: () => void; setDraftValue: (next: CoachAccount | ((current: CoachAccount) => CoachAccount)) => void; save: () => Promise<boolean>; };
  discountSaveState: "idle" | "saving";
  expenseCategoryEditor: { id: string; name: string; };
  setExpenseCategoryEditor: Dispatch<SetStateAction<{ id: string; name: string; }>>;
  expenseCategorySaveState: "idle" | "saving";
  clarityPayReturn: ClarityPayReturn | null;
  stripeResyncResult: string;
  posMethodSaveState: "idle" | "saving";
  posPaymentMethods: PosPaymentMethod[];
  discountPresets: BillingDiscount[];
  expenseCategories: BillingExpenseCategory[];
  activeView: View;
  workspaceOverlay: WorkspaceOverlay | null;
  setClarityPayReturn: Dispatch<SetStateAction<ClarityPayReturn | null>>;
  invoiceNumber: string;
  startEditableBlock: (id: string) => void;
  cancelEditableBlock: (id: string) => void;
  coachAccount: CoachAccount;
  openProfileTarget: (target: ProfileTarget, label?: string) => void;
  setUpClarityPay: () => Promise<void>;
  connectStripe: () => Promise<void>;
  disconnectStripe: () => Promise<void>;
  resyncStripeBilling: () => Promise<void>;
  saveEditableBlock: (id: string) => Promise<void>;
  savePosPaymentMethod: () => Promise<void>;
  setPosPaymentMethodActive: (method: PosPaymentMethod, active: boolean) => Promise<void>;
  addDiscountPreset: () => Promise<void>;
  toggleDiscountActive: (discount: BillingDiscount) => Promise<void>;
  addExpenseCategory: () => Promise<void>;
  toggleExpenseCategoryActive: (category: BillingExpenseCategory) => Promise<void>;
};

export function BillingSettingsPanel(props: BillingSettingsPanelProps) {
  const {
    stripeStatus,
    invoiceSettingsDraft,
    billingSettingsIsLocked,
    updateBillingAccountDraft,
    discountEditor,
    setDiscountEditor,
    stripeSaving,
    invoiceSettings,
    stripeResyncing,
    posMethodEditor,
    setPosMethodEditor,
    clarityPaySetup,
    stripeResyncProgress,
    billingSettingsEditor,
    discountSaveState,
    expenseCategoryEditor,
    setExpenseCategoryEditor,
    expenseCategorySaveState,
    clarityPayReturn,
    stripeResyncResult,
    posMethodSaveState,
    posPaymentMethods,
    discountPresets,
    expenseCategories,
    activeView,
    workspaceOverlay,
    setClarityPayReturn,
    invoiceNumber,
    startEditableBlock,
    cancelEditableBlock,
    coachAccount,
    openProfileTarget,
    setUpClarityPay,
    connectStripe,
    disconnectStripe,
    resyncStripeBilling,
    saveEditableBlock,
    savePosPaymentMethod,
    setPosPaymentMethodActive,
    addDiscountPreset,
    toggleDiscountActive,
    addExpenseCategory,
    toggleExpenseCategoryActive,
  } = props;
  return (
    <SettingsGroups>
    <div className="billing-dashboard">
      {clarityPayReturn && (activeView === "billing" || workspaceOverlay?.kind === "billing") && (
        <ClarityPayReturnBanner
          outcome={clarityPayReturn}
          busy={stripeSaving}
          onContinue={() => void setUpClarityPay()}
          onDismiss={() => setClarityPayReturn(null)}
        />
      )}
      <SettingsGroup id="billing-card-payments" section="billing" icon={ClarityPayments} title={`${t("Card payments")} · ${stripeStatus?.route === "clarity_pay" ? t("Clarity Pay is on") : stripeStatus?.route === "own_stripe" ? t("Your own Stripe account") : t("Not set up")}`}>
        <p className="field-help">
          {stripeStatus?.route === "clarity_pay" ? (
            <>{t("Card payments at the till, on invoices and in the player portal go straight to your account ({account}), and Stripe pays them out to your bank. Clarity Pay keeps {fee} of each payment; Stripe's own card fee is separate.", { account: stripeStatus.account, fee: clarityPayFeeLabel(stripeStatus.fee) })}</>
          ) : stripeStatus?.route === "own_stripe" ? (
            <>{t("Invoice payments go straight to your Stripe account ({account}), with no Clarity fee. The till and the player portal need Clarity Pay.", { account: stripeStatus.account })}{clarityPaySetup === "pending"
                ? t(" Your Clarity Pay setup isn't finished; you'll keep using your own Stripe until it is.")
                : ""}
            </>
          ) : (
            <>
              <strong>{t("Clarity Pay")}</strong>{" "}{t("is the easy way: we set up your payment account, Stripe checks your details, and you can take cards at the till, on invoices and in the player portal. Payouts go to your bank. Clarity Pay keeps")}{" "}{stripeStatus ? clarityPayFeeLabel(stripeStatus.fee) : "a small cut"}{" "}{t("of each payment.")}{clarityPaySetup === "pending" ? t(" Your setup isn't finished yet.") : ""}
              <br />{t("Already have Stripe? Connect it for invoice payments only, with no Clarity fee.")}</>
          )}
          {stripeStatus?.account && stripeStatus.testMode ? t(" This is a test-mode connection, so no real money moves.") : ""}
          {stripeStatus?.account && !stripeStatus.configured ? t(" Payments are paused while Clarity's Stripe platform is unavailable.") : ""}
        </p>
        <div className="settings-field-row">
          {stripeStatus?.route !== "clarity_pay" && (
            <button
              className="primary-button"
              type="button"
              disabled={stripeSaving}
              onClick={() => void setUpClarityPay()}
            >
              {stripeSaving
                ? t("Opening…")
                : clarityPaySetup === "pending"
                  ? t("Finish Clarity Pay setup")
                  : stripeStatus?.route === "own_stripe"
                    ? t("Switch to Clarity Pay")
                    : t("Set up Clarity Pay")}
            </button>
          )}
          {!stripeStatus?.route && (
            <button
              className="outline-button"
              type="button"
              disabled={stripeSaving}
              onClick={() => void connectStripe()}
            >{t("Connect my own Stripe")}</button>
          )}
          {stripeStatus?.route && (
            <button
              className="outline-button"
              type="button"
              disabled={stripeSaving}
              onClick={() => void disconnectStripe()}
            >
              {stripeStatus.route === "clarity_pay" ? t("Turn off Clarity Pay") : t("Disconnect")}
            </button>
          )}
        </div>
      </SettingsGroup>

      {stripeStatus?.route === "clarity_pay" && (
        <Suspense fallback={<Loading what={tapToPayName()} />}>
          <TapToPaySetup
            frame={(body) => (
              <SettingsGroup id="billing-tap-to-pay" section="billing" icon={Nfc} title={tapToPayName()}>
                {body}
              </SettingsGroup>
            )}
          />
        </Suspense>
      )}

      {/* Repair, not import. Everything here has already been
          pulled once; what this fixes is what was kept of it. */}
      <SettingsGroup id="billing-stripe-resync" section="billing" icon={RefreshCw} title={t("Re-read payment history")}>
        <p className="field-help">{t("Pulls every Stripe invoice and card payment again, from the beginning. Safe to run whenever — each one updates the record it already has rather than adding a second.")}</p>
        <p className="field-help">{t("Worth running once: card payments used to be filed under Stripe's own label for them,")}{" "}<code>Charge for &lt;email&gt;</code>{t(", so the invoice list and the lesson-matching on a client's profile saw an email address where the product name should have been. Payments now keep what was actually bought — read from the payment, or from the basket behind it. The ones already recorded keep the old label until they are read again.")}</p>
        <div className="panel-actions">
          <button
            className="outline-button"
            type="button"
            disabled={stripeResyncing}
            onClick={() => void resyncStripeBilling()}
          >
            {stripeResyncing ? t("Reading…") : t("Re-read everything from Stripe")}
          </button>
        </div>
        {stripeResyncing && (
          <p className="field-help">
            {stripeResyncProgress
              ? t("Reading period {value} of {total} — newest first.", { value: stripeResyncProgress.done + 1, total: stripeResyncProgress.total })
              : t("Starting…")}{" "}{t("This takes a minute or two on a few hundred payments. Leave the page open.")}</p>
        )}
        {stripeResyncResult && !stripeResyncing && (
          <p className="field-help">{stripeResyncResult}</p>
        )}
      </SettingsGroup>

      <SettingsGroup id="billing-invoice-defaults" section="billing" icon={ClaritySettings} title={t("Defaults for new invoices")}>
        <p className="field-help">{t("These defaults are used when creating a new invoice and are saved on your account record. Current next number: {invoiceNumber}", { invoiceNumber })}</p>
        <EditableSettingsBlock
          id="billing-settings-block"
          title={t("Billing Settings")}
          status={billingSettingsEditor.status}
          dirty={billingSettingsEditor.dirty}
          errorMessage={billingSettingsEditor.errorMessage}
          onEdit={() => startEditableBlock("billing-settings")}
          onCancel={() => cancelEditableBlock("billing-settings")}
          onSave={() => void saveEditableBlock("billing-settings")}
        >
        {/* Currency, time zone and tax belong to the business's
            country, and are set in one place: Settings > Account >
            Country & region. */}
        <p className="field-help">
          {invoiceSettings.currency} · {invoiceSettings.taxName} {invoiceSettings.taxRate}%{" "}
          {invoiceSettings.taxInclusive ? "included in prices" : "added on top"} · {coachAccount.timezone}.{" "}
          <button
            className="link-button"
            onClick={() => openProfileTarget({ kind: "settings", tab: "account", group: "region" }, t("Country & region"))}
            type="button"
          >{t("Change in Country & region")}</button>
        </p>
        <div className="service-form-row">
          <label className="settings-field">
            <span>{t("Invoice prefix")}</span>
            <input value={invoiceSettingsDraft.prefix} readOnly={billingSettingsIsLocked} onChange={(event) => updateBillingAccountDraft("prefix", event.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t("Start / next number")}</span>
            <input
              value={invoiceSettingsDraft.nextNumber || ""}
              inputMode="numeric"
              readOnly={billingSettingsIsLocked}
              onChange={(event) => updateBillingAccountDraft("nextNumber", parseQuantityInput(event.target.value))}
              type="text"
              placeholder="e.g. 1001"
            />
          </label>
          <label className="settings-field">
            <span>{t("Payment terms (days)")}</span>
            <input
              value={invoiceSettingsDraft.paymentTermsDays}
              inputMode="numeric"
              readOnly={billingSettingsIsLocked}
              onChange={(event) => updateBillingAccountDraft("paymentTermsDays", parseQuantityInput(event.target.value))}
              type="text"
            />
          </label>
        </div>
        <div className="service-form-row">
          <label className="settings-field">
            <span>{t("{taxName} number", { taxName: invoiceSettingsDraft.taxName })}</span>
            <input
              value={invoiceSettingsDraft.taxNumber}
              readOnly={billingSettingsIsLocked}
              onChange={(event) => updateBillingAccountDraft("taxNumber", event.target.value)}
              placeholder={`${invoiceSettingsDraft.taxName} number`}
            />
          </label>
        </div>
        <label className="settings-field">
          <span>{t("Unpaid invoice loudness")}</span>
          <select
            value={invoiceSettingsDraft.unpaidLoudness}
            disabled={billingSettingsIsLocked}
            onChange={(event) => updateBillingAccountDraft("unpaidLoudness", Number(event.target.value) as 1 | 2 | 3)}
          >
            <option value={1}>{t("Level 1 - Subtle (small count only)")}</option>
            <option value={2}>{t("Level 2 - Noticeable (dashboard banner)")}</option>
            <option value={3}>{t("Level 3 - Urgent (banner + highlighted rows)")}</option>
          </select>
          <span className="field-help">{t("Controls how strongly the Dashboard calls out overdue, unpaid invoices. Doesn't change invoice status or send anything - display only.")}</span>
        </label>
        <label className="settings-field">
          <span>{t("Default customer note")}</span>
          <textarea
            value={invoiceSettingsDraft.defaultCustomerNote}
            readOnly={billingSettingsIsLocked}
            onChange={(event) => updateBillingAccountDraft("defaultCustomerNote", event.target.value)}
            rows={2}
          />
        </label>
        <label className="settings-field">
          <span>{t("Payment instructions")}</span>
          <textarea
            value={invoiceSettingsDraft.paymentInstructions}
            readOnly={billingSettingsIsLocked}
            onChange={(event) => updateBillingAccountDraft("paymentInstructions", event.target.value)}
            rows={2}
          />
        </label>
        </EditableSettingsBlock>
      </SettingsGroup>

      <SettingsGroup id="billing-payment-methods" section="billing" icon={ClarityPayments} title={t("Payment Methods")}>
        <p className="field-help">{t("The buttons shown in the checkout modal. Clarity Pay is the Stripe-backed method and is always available; add your own for Cash, Eftpos, On account and anything else you take.")}</p>
        <div className="billing-catalog-editor">
          <label className="settings-field">
            <span>{t("Name")}</span>
            <input
              className="w-name"
              value={posMethodEditor.name}
              onChange={(event) => setPosMethodEditor((current) => ({ ...current, name: event.target.value }))}
              placeholder={t("e.g. Eftpos")}
            />
          </label>
          <label className="settings-field pos-settles-toggle">
            <input
              checked={posMethodEditor.settlesImmediately}
              onChange={(event) =>
                setPosMethodEditor((current) => ({ ...current, settlesImmediately: event.target.checked }))
              }
              type="checkbox"
            />
            <span>{t("Money is received straight away")}</span>
          </label>
          <p className="field-help">{t("Leave that unticked for methods like On account, where the sale is recorded as owed and marked paid later.")}</p>
          <button
            className="outline-button"
            disabled={posMethodSaveState === "saving"}
            onClick={() => void savePosPaymentMethod()}
            type="button"
          >
            <Plus size={16} />
            {posMethodSaveState === "saving"
              ? t("Saving...")
              : posMethodEditor.id
                ? t("Save Changes")
                : t("Add Payment Method")}
          </button>
          {Boolean(posMethodEditor.id) && (
            <button
              className="text-button"
              onClick={() => setPosMethodEditor({ id: "", name: "", settlesImmediately: true })}
              type="button"
            >{t("Cancel Edit")}</button>
          )}
        </div>
        <div className="billing-catalog-list">
          {posPaymentMethods.length ? (
            posPaymentMethods.map((method) => (
              <div key={method.id} className={`billing-catalog-list-item${method.active ? "" : " inactive"}`}>
                <button
                  onClick={() =>
                    setPosMethodEditor({
                      id: method.id,
                      name: method.name,
                      settlesImmediately: method.settlesImmediately,
                    })
                  }
                  type="button"
                >
                  <span>
                    <strong>{method.name}</strong>
                    <em>
                      {method.kind === "clarity_pay" ? t("Stripe - card, Apple Pay, Google Pay") : t("Manual")}
                      {method.settlesImmediately ? "" : t(" - recorded as owed")}
                      {method.active ? "" : t(" - inactive")}
                    </em>
                  </span>
                </button>
                <button
                  className="text-link-button"
                  onClick={() => void setPosPaymentMethodActive(method, !method.active)}
                  type="button"
                >
                  {method.active ? t("Deactivate") : t("Reactivate")}
                </button>
              </div>
            ))
          ) : (
            <Loading what={t("payment methods")} />
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup id="billing-discounts" section="billing" icon={Percent} title={t("Discount Settings")}>
        <p className="field-help">{t("Optional presets for discounts you use often (a percentage off, a flat amount, a named discount, or a coupon code). These are picked from the invoice's discount field when needed - creating an invoice never requires one.")}</p>
        <div className="billing-catalog-editor">
          <label className="settings-field">
            <span>{t("Name")}</span>
            <input
              className="w-name"
              value={discountEditor.name}
              onChange={(event) => setDiscountEditor((current) => ({ ...current, name: event.target.value }))}
              placeholder={t("e.g. Member discount")}
            />
          </label>
          <div className="service-form-row">
            <label className="settings-field">
              <span>{t("Type")}</span>
              <select
                value={discountEditor.discountType}
                onChange={(event) =>
                  setDiscountEditor((current) => ({
                    ...current,
                    discountType: event.target.value === "fixed" ? "fixed" : "percentage",
                  }))
                }
              >
                <option value="percentage">{t("Percentage")}</option>
                <option value="fixed">{t("Fixed amount")}</option>
              </select>
            </label>
            <label className="settings-field">
              <span>{discountEditor.discountType === "percentage" ? t("Percent off") : t("Amount off")}</span>
              <input
                className="w-price"
                value={discountEditor.value}
                inputMode="decimal"
                onChange={(event) =>
                  setDiscountEditor((current) => ({ ...current, value: parseMoneyInput(event.target.value) }))
                }
                type="text"
              />
            </label>
            <label className="settings-field">
              <span>{t("Coupon code (optional)")}</span>
              <input
                className="w-name"
                value={discountEditor.couponCode}
                onChange={(event) => setDiscountEditor((current) => ({ ...current, couponCode: event.target.value }))}
                placeholder={t("Optional")}
              />
            </label>
          </div>
          <button className="outline-button" disabled={discountSaveState === "saving"} onClick={addDiscountPreset} type="button">
            <Plus size={16} />
            {discountEditor.id ? (discountSaveState === "saving" ? t("Saving...") : t("Save Changes")) : discountSaveState === "saving" ? t("Saving...") : t("Add Discount")}
          </button>
          {Boolean(discountEditor.id) && (
            <button
              className="text-button"
              onClick={() => setDiscountEditor({ id: "", name: "", discountType: "percentage", value: 10, couponCode: "" })}
              type="button"
            >{t("Cancel Edit")}</button>
          )}
        </div>
        <div className="billing-catalog-list">
          {discountPresets.length ? (
            discountPresets.map((preset) => (
              <div key={preset.id} className={`billing-catalog-list-item${preset.active === false ? " inactive" : ""}`}>
                <button onClick={() => setDiscountEditor(preset)} type="button">
                  <span>
                    <strong>{preset.name}</strong>
                    <em>
                      {preset.discountType === "percentage" ? t("{value}% off", { value: preset.value }) : `${formatMoney(preset.value, invoiceSettings.currency)} off`}
                      {preset.couponCode ? t(" - Code: {couponCode}", { couponCode: preset.couponCode }) : ""}
                      {preset.active === false ? t(" - inactive") : ""}
                    </em>
                  </span>
                </button>
                <button className="text-link-button" onClick={() => toggleDiscountActive(preset)} type="button">
                  {preset.active === false ? t("Reactivate") : t("Deactivate")}
                </button>
              </div>
            ))
          ) : (
            <p>{t("No discount presets yet.")}</p>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup id="billing-expense-categories" section="billing" icon={ClarityInvoices} title={t("Expense Categories")}>
        <p className="field-help">{t("Optional categories for logging expenses (Range fees, Coaching supplies, Travel, Software, etc). Every expense can also be left Uncategorised.")}</p>
        <div className="billing-catalog-editor">
          <label className="settings-field">
            <span>{t("Name")}</span>
            <input
              className="w-name"
              value={expenseCategoryEditor.name}
              onChange={(event) => setExpenseCategoryEditor((current) => ({ ...current, name: event.target.value }))}
              placeholder={t("e.g. Range fees")}
            />
          </label>
          <button
            className="outline-button"
            disabled={expenseCategorySaveState === "saving"}
            onClick={addExpenseCategory}
            type="button"
          >
            <Plus size={16} />
            {expenseCategoryEditor.id
              ? expenseCategorySaveState === "saving"
                ? t("Saving...")
                : t("Save Changes")
              : expenseCategorySaveState === "saving"
                ? t("Saving...")
                : t("Add Category")}
          </button>
          {Boolean(expenseCategoryEditor.id) && (
            <button className="text-button" onClick={() => setExpenseCategoryEditor({ id: "", name: "" })} type="button">{t("Cancel Edit")}</button>
          )}
        </div>
        <div className="billing-catalog-list">
          {expenseCategories.length ? (
            expenseCategories.map((category) => (
              <div key={category.id} className={`billing-catalog-list-item${category.active === false ? " inactive" : ""}`}>
                <button onClick={() => setExpenseCategoryEditor(category)} type="button">
                  <span>
                    <strong>{category.name}</strong>
                    {category.active === false && <em>{t("Inactive")}</em>}
                  </span>
                </button>
                <button className="text-link-button" onClick={() => toggleExpenseCategoryActive(category)} type="button">
                  {category.active === false ? t("Reactivate") : t("Deactivate")}
                </button>
              </div>
            ))
          ) : (
            <p>{t("No expense categories yet.")}</p>
          )}
        </div>
      </SettingsGroup>
    </div>
    </SettingsGroups>
  );
}
