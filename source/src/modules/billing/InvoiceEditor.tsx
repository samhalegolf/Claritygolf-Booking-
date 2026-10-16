// The invoice editor: the invoice as a sheet of paper on a mat, with the
// things you pull onto it in a rail alongside. Drawn here; the draft, the
// lists it pulls from and the save and send handlers still live in App.tsx
// and arrive as props. Loaded with Billing › New Invoice, not with the shell.
import { t } from "../../lib/i18n";
import { currencySymbol, formatMoney, parseMoneyInput, parseQuantityInput } from "../../lib/money";
import { formatDateForDisplay } from "../../lib/date";
import { ChevronDown, ChevronUp, Download, Pencil, Plus, Search, Send, X } from "lucide-react";
import { ClarityCalendar, ClarityEmail, ClarityPassesCredits, ClarityPayments, ClarityProducts, ClarityProfile, ClarityStore } from "../shared/ClarityIcons";
import { invoiceLineGross, invoiceLineNet, lineDiscountAmount } from "./invoiceMath";
import { buildWeekDays, formatRange, itemService, itemWeek } from "../calendar/calendarModel";
import type { CalendarItem } from "../calendar/calendarModel";
import type { InvoicedBookingLink } from "../clients/clientProfileModel";
import type { Person } from "../clients/clientsModel";
import type { Service } from "../services/serviceModel";
import type { Toast } from "../shared/toast";
import type { BrandSettings, CoachAccount } from "../workspace/workspaceModel";
import type { BookingPullFilter } from "./billingSections";
import type { BillingCatalogItem, BillingDiscount, BillingInvoiceStatus, InvoiceCustomField, InvoiceDraft, InvoiceLine, InvoiceLineTag, InvoicePaymentSource, InvoiceSettings, PosBookingPayment } from "./types";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";

export type InvoiceEditorProps = {
  invoiceSettings: InvoiceSettings;
  invoiceDraft: InvoiceDraft;
  invoiceLocked: boolean;
  invoiceIssueState: "idle" | "saving";
  openedInvoiceStatus: "" | BillingInvoiceStatus;
  openedInvoicePayment: InvoicePaymentSource | null;
  updateInvoiceLine: (id: string, field: keyof InvoiceLine, value: string | number) => void;
  updateInvoiceDraft: <K extends keyof InvoiceDraft>(field: K, value: InvoiceDraft[K]) => void;
  phoneLayout: boolean;
  invoiceCustomFieldsToPrint: InvoiceCustomField[];
  setCustomDiscountLineId: Dispatch<SetStateAction<string>>;
  invoicePhonePrimary: { label: string; icon: ReactNode; run: () => void; disabled: boolean; };
  bookingConflict: { message: string; conflicts: Array<{ bookingId: string; invoiceNumber: string; }>; } | null;
  newInvoiceCustomer: { name: string; email: string; phone: string; } | null;
  setInvoiceLineDiscount: (id: string, selection: string) => void;
  invoiceLineTagOptions: InvoiceLineTag[];
  bookingPullFilter: BookingPullFilter;
  invoiceTotal: number;
  invoiceEditing: boolean;
  openedInvoiceSentAt: string;
  coachAccount: CoachAccount;
  updateNewInvoiceCustomer: (field: "name" | "email" | "phone", value: string) => void;
  invoiceCustomerCreateLabel: string;
  discountPresets: BillingDiscount[];
  invoiceDiscountTotal: number;
  setDiscountEditing: Dispatch<SetStateAction<boolean>>;
  activeInvoiceId: string;
  editOpenedInvoice: () => void;
  clarityPayState: "idle" | "loading";
  invoiceSendState: "idle" | "sending";
  openedInvoicePaidAt: string;
  conflictRetryMode: "draft" | "publish" | "publish-send";
  brandSettings: BrandSettings;
  isNewInvoice: boolean;
  setDatesEditing: Dispatch<SetStateAction<boolean>>;
  newInvoiceCustomerSaving: boolean;
  invoiceCustomerMatches: Person[];
  openInvoiceLineId: string;
  customDiscountLineId: string;
  setOpenInvoiceLineId: Dispatch<SetStateAction<string>>;
  scrollToInvoiceRail: (id: string) => void;
  invoiceLineDiscountTotal: number;
  discountSet: boolean;
  invoiceDiscountLabel: string;
  discountEditing: boolean;
  invoiceTaxTotal: number;
  openInvoiceCoachSettings: () => void;
  effectivePullFrom: string;
  calendarPullRangeSorted: CalendarItem[];
  setToast: Dispatch<SetStateAction<Toast | null>>;
  visibleInvoiceCatalogOptions: BillingCatalogItem[];
  includePaymentLink: boolean;
  paymentLinkChosenRef: RefObject<boolean>;
  setIncludePaymentLink: Dispatch<SetStateAction<boolean>>;
  isRevisingInvoice: boolean;
  bookingConflictLabel: (bookingId: string) => string;
  setBookingConflict: Dispatch<SetStateAction<{ message: string; conflicts: Array<{ bookingId: string; invoiceNumber: string; }>; } | null>>;
  bookingBrandName: string;
  openedInvoiceStateLabel: string;
  activeInvoiceNumber: string;
  datesEditing: boolean;
  hasInvoiceCustomer: boolean;
  clearInvoiceCustomer: () => void;
  setNewInvoiceCustomer: Dispatch<SetStateAction<{ name: string; email: string; phone: string; } | null>>;
  invoiceCustomerSearch: string;
  setInvoiceCustomerSearch: Dispatch<SetStateAction<string>>;
  selectInvoiceCustomer: (customer: Pick<Person, "name" | "email" | "phone"> & { id?: string; }) => void;
  openNewInvoiceCustomer: () => void;
  invoiceLineTagLabel: (tagId: string) => string;
  removeInvoiceLine: (id: string) => void;
  invoiceLineDiscountSelection: (line: InvoiceLine) => string;
  addManualInvoiceLine: () => void;
  invoiceLineSubtotal: number;
  clearInvoiceDiscount: () => void;
  selectedDiscountPresetId: string;
  applyDiscountPreset: (presetId: string) => void;
  markInvoiceDraftDirty: () => void;
  setSelectedDiscountPresetId: Dispatch<SetStateAction<string>>;
  setInvoiceDraft: Dispatch<SetStateAction<InvoiceDraft>>;
  setBookingPullFilter: Dispatch<SetStateAction<BookingPullFilter>>;
  pullRangeEditing: boolean;
  pullRangeFrom: string;
  setPullRangeFrom: Dispatch<SetStateAction<string>>;
  pullRangeTo: string;
  setPullRangeTo: Dispatch<SetStateAction<string>>;
  resetPullRange: () => void;
  setPullRangeEditing: Dispatch<SetStateAction<boolean>>;
  effectivePullTo: string;
  openPullRangeEdit: () => void;
  services: Service[];
  invoicedBookingIds: Record<string, InvoicedBookingLink>;
  posPaidBookings: Record<string, PosBookingPayment>;
  invoicePayerBookingIds: Set<string>;
  addCompletedBookingLine: (item: CalendarItem) => void;
  completedAppointments: CalendarItem[];
  addCatalogInvoiceLine: (item: BillingCatalogItem) => void;
  commitInvoice: (mode: "draft" | "publish" | "publish-send", { force }?: { force?: boolean | undefined; }) => Promise<void>;
  downloadInvoicePdf: () => Promise<void>;
  deleteOpenedInvoice: () => Promise<void>;
  startClarityPay: () => Promise<void>;
  markActiveInvoicePaid: () => Promise<void>;
  sendOpenedInvoice: () => Promise<void>;
  saveNewInvoiceCustomer: () => Promise<void>;
};

export function InvoiceEditor(props: InvoiceEditorProps) {
  const {
    invoiceSettings,
    invoiceDraft,
    invoiceLocked,
    invoiceIssueState,
    openedInvoiceStatus,
    openedInvoicePayment,
    updateInvoiceLine,
    updateInvoiceDraft,
    phoneLayout,
    invoiceCustomFieldsToPrint,
    setCustomDiscountLineId,
    invoicePhonePrimary,
    bookingConflict,
    newInvoiceCustomer,
    setInvoiceLineDiscount,
    invoiceLineTagOptions,
    bookingPullFilter,
    invoiceTotal,
    invoiceEditing,
    openedInvoiceSentAt,
    coachAccount,
    updateNewInvoiceCustomer,
    invoiceCustomerCreateLabel,
    discountPresets,
    invoiceDiscountTotal,
    setDiscountEditing,
    activeInvoiceId,
    editOpenedInvoice,
    clarityPayState,
    invoiceSendState,
    openedInvoicePaidAt,
    conflictRetryMode,
    brandSettings,
    isNewInvoice,
    setDatesEditing,
    newInvoiceCustomerSaving,
    invoiceCustomerMatches,
    openInvoiceLineId,
    customDiscountLineId,
    setOpenInvoiceLineId,
    scrollToInvoiceRail,
    invoiceLineDiscountTotal,
    discountSet,
    invoiceDiscountLabel,
    discountEditing,
    invoiceTaxTotal,
    openInvoiceCoachSettings,
    effectivePullFrom,
    calendarPullRangeSorted,
    setToast,
    visibleInvoiceCatalogOptions,
    includePaymentLink,
    paymentLinkChosenRef,
    setIncludePaymentLink,
    isRevisingInvoice,
    bookingConflictLabel,
    setBookingConflict,
    bookingBrandName,
    openedInvoiceStateLabel,
    activeInvoiceNumber,
    datesEditing,
    hasInvoiceCustomer,
    clearInvoiceCustomer,
    setNewInvoiceCustomer,
    invoiceCustomerSearch,
    setInvoiceCustomerSearch,
    selectInvoiceCustomer,
    openNewInvoiceCustomer,
    invoiceLineTagLabel,
    removeInvoiceLine,
    invoiceLineDiscountSelection,
    addManualInvoiceLine,
    invoiceLineSubtotal,
    clearInvoiceDiscount,
    selectedDiscountPresetId,
    applyDiscountPreset,
    markInvoiceDraftDirty,
    setSelectedDiscountPresetId,
    setInvoiceDraft,
    setBookingPullFilter,
    pullRangeEditing,
    pullRangeFrom,
    setPullRangeFrom,
    pullRangeTo,
    setPullRangeTo,
    resetPullRange,
    setPullRangeEditing,
    effectivePullTo,
    openPullRangeEdit,
    services,
    invoicedBookingIds,
    posPaidBookings,
    invoicePayerBookingIds,
    addCompletedBookingLine,
    completedAppointments,
    addCatalogInvoiceLine,
    commitInvoice,
    downloadInvoicePdf,
    deleteOpenedInvoice,
    startClarityPay,
    markActiveInvoicePaid,
    sendOpenedInvoice,
    saveNewInvoiceCustomer,
  } = props;
  return (
    /* The invoice as a sheet of paper on a mat, with the things you
       pull onto it in a rail alongside. Everything you can type into
       is dashed; everything solid came from the template, so the
       sheet says which of its own lines are yours without a single
       field label. */
    <div className="invoice-paper-layout">
      {phoneLayout ? (
        <div className="ip-phone-bar">
          <span className="ip-phone-total">
            <em>{t("Total")}</em>
            <strong>{formatMoney(invoiceTotal, invoiceSettings.currency)}</strong>
          </span>
          <button
            className="primary-button"
            disabled={invoicePhonePrimary.disabled}
            onClick={invoicePhonePrimary.run}
            type="button"
          >
            {invoicePhonePrimary.icon}
            {invoicePhonePrimary.label}
          </button>
        </div>
      ) : null}
      <div className="ip-actionbar">
        <p>{t("You are typing on the invoice itself. Dashed is editable; everything else comes from your template.")}</p>
        <div className="ip-actionbar-buttons">
          {activeInvoiceId && (
            /* Rule 10: Delete and Void are text, not a filled red
               button sitting in the same row as Publish & Send. */
            <button className="text-button danger" onClick={deleteOpenedInvoice} type="button">
              {openedInvoiceStatus === "draft" || openedInvoiceStatus === "void" ? t("Delete") : t("Void")}
            </button>
          )}
          {/* Beside the send buttons because that is what it changes:
              the emailed invoice carries a Clarity Pay link. Hidden
              once the invoice is settled - there is nothing left to
              pay, and the server would not mint a link anyway. */}
          {openedInvoiceStatus !== "paid" && openedInvoiceStatus !== "void" && (
            <label className="ip-pay-toggle" title={t("Email a Clarity Pay link with this invoice so the client can pay it online")}>
              <input
                checked={includePaymentLink}
                onChange={(event) => {
                  paymentLinkChosenRef.current = true;
                  setIncludePaymentLink(event.target.checked);
                }}
                type="checkbox"
              />
              <span>{t("Include payment link")}</span>
            </label>
          )}
          {invoiceEditing ? (
            isRevisingInvoice ? (
              <>
                {activeInvoiceId && (
                  <button className="outline-button" onClick={downloadInvoicePdf} type="button">
                    <Download size={16} />{t("Download PDF")}</button>
                )}
                <button className="outline-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("draft")} type="button">
                  {invoiceIssueState === "saving" ? t("Saving...") : t("Save")}
                </button>
                <button className="primary-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("publish-send")} type="button">
                  <ClarityEmail size={16} />{t("Save & email")}</button>
              </>
            ) : (
              <>
                <button className="outline-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("draft")} type="button">
                  {invoiceIssueState === "saving" ? t("Saving...") : t("Save draft")}
                </button>
                <button className="outline-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("publish")} type="button">{t("Publish")}</button>
                <button className="primary-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("publish-send")} type="button">
                  <ClarityEmail size={16} />{t("Publish & email")}</button>
              </>
            )
          ) : openedInvoiceStatus === "draft" ? (
            <>
              <button className="outline-button" onClick={editOpenedInvoice} type="button">
                <Pencil size={16} />{t("Edit")}</button>
              <button className="outline-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("publish")} type="button">{t("Publish")}</button>
              <button className="primary-button" disabled={invoiceIssueState === "saving"} onClick={() => commitInvoice("publish-send")} type="button">
                <ClarityEmail size={16} />{t("Publish & email")}</button>
            </>
          ) : (
            <>
              <button className="outline-button" onClick={editOpenedInvoice} type="button">
                <Pencil size={16} />{t("Edit")}</button>
              <button className="outline-button" onClick={downloadInvoicePdf} type="button">
                <Download size={16} />{t("Download PDF")}</button>
              {(openedInvoiceStatus === "sent" || openedInvoiceStatus === "overdue") && (
                <>
                  <button
                    className="outline-button"
                    disabled={clarityPayState === "loading"}
                    onClick={startClarityPay}
                    type="button"
                  >
                    <ClarityPayments size={16} />
                    {clarityPayState === "loading" ? t("Opening...") : t("Clarity Pay")}
                  </button>
                  <button className="outline-button" onClick={markActiveInvoicePaid} type="button">{t("Mark Paid")}</button>
                </>
              )}
              <button
                className="primary-button"
                disabled={invoiceSendState === "sending"}
                onClick={sendOpenedInvoice}
                type="button"
                title={openedInvoiceSentAt ? t("Email this invoice to the customer again") : t("Email this invoice to the customer")}
              >
                <Send size={16} />
                {invoiceSendState === "sending" ? t("Sending...") : openedInvoiceSentAt ? t("Resend") : t("Send")}
              </button>
            </>
          )}
        </div>
        {/* Where a "Paid" came from. A bank-matched invoice will show
            nothing in Stripe - the money arrived by transfer - so the
            credit is named here, and a mis-match is visible instead of
            hiding behind the badge. */}
        {openedInvoiceStatus === "paid" && (
          <div className="ip-payment-source">
            <span className="ip-payment-head">{t("Paid")}{openedInvoicePaidAt ? ` ${formatDateForDisplay(openedInvoicePaidAt.slice(0, 10))}` : ""}
              {openedInvoicePayment ? t(" · matched to a bank credit") : t(" · marked paid manually")}
            </span>
            {openedInvoicePayment && (
              <span className="ip-payment-detail">
                {openedInvoicePayment.date ? `${formatDateForDisplay(openedInvoicePayment.date)} · ` : ""}
                {formatMoney(openedInvoicePayment.amount, invoiceSettings.currency)} ·{" "}
                {openedInvoicePayment.description || t("Bank credit")}
                {openedInvoicePayment.reference ? ` · ${openedInvoicePayment.reference}` : ""}
              </span>
            )}
          </div>
        )}
        {/* A refused save, named. The server sends back which booking
            is on which invoice; without this the coach is told
            "already invoiced" and left to open every invoice they
            have to find out which lesson and which one. */}
        {bookingConflict && (
          <div className="ip-conflict" role="alert">
            <p className="ip-conflict-head">{bookingConflict.message}</p>
            {bookingConflict.conflicts.length > 0 && (
              <ul>
                {bookingConflict.conflicts.map((conflict) => (
                  <li key={conflict.bookingId}>
                    {bookingConflictLabel(conflict.bookingId)}
                    {conflict.invoiceNumber ? ` - on ${conflict.invoiceNumber}` : ""}
                  </li>
                ))}
              </ul>
            )}
            <div className="ip-conflict-actions">
              <button
                className="outline-button"
                disabled={invoiceIssueState === "saving"}
                onClick={() => void commitInvoice(conflictRetryMode, { force: true })}
                type="button"
              >
                {invoiceIssueState === "saving"
                  ? t("Saving...")
                  : conflictRetryMode === "draft"
                    ? t("Save anyway")
                    : t("Publish anyway")}
              </button>
              <button className="text-button" onClick={() => setBookingConflict(null)} type="button">{t("Dismiss")}</button>
            </div>
            <p className="ip-conflict-note">{t("Publishing anyway moves these lessons onto this invoice. Any invoice named above keeps the line and the total already billed - void it if this is a re-bill.")}</p>
          </div>
        )}
      </div>

      <div className="ip-grid">
        <div className="ip-mat">
          <article className="ip-paper" aria-label={t("Invoice editor")}>
            <header className="ip-paper-head">
              {brandSettings.logoPreview && (
                <span className="ip-logo">
                  <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
                </span>
              )}
              <div className="ip-issuer">
                <strong>{coachAccount.businessName}</strong>
                <span>
                  {invoiceSettings.businessAddress || coachAccount.contactEmail}
                  {invoiceSettings.taxNumber && ` · ${invoiceSettings.taxName} ${invoiceSettings.taxNumber}`}
                </span>
              </div>
              <div className="ip-issue-meta">
                <span
                  className={`invoice-status-pill invoice-status-${
                    invoiceEditing && isNewInvoice
                      ? "draft"
                      : openedInvoiceStatus === "sent" && !openedInvoiceSentAt
                        ? "published"
                        : openedInvoiceStatus || "draft"
                  }`}
                >
                  {invoiceEditing && isNewInvoice ? t("Draft") : openedInvoiceStateLabel}
                </span>
                <strong>{activeInvoiceNumber}</strong>
                {invoiceLocked || !datesEditing ? (
                  <>
                    <span>{t("Issued {invoiceDate}", { invoiceDate: formatDateForDisplay(invoiceDraft.invoiceDate) })}</span>
                    <span>{t("Due {dueDate}", { dueDate: formatDateForDisplay(invoiceDraft.dueDate) })}</span>
                    {!invoiceLocked && (
                      <button className="invoice-inline-edit" onClick={() => setDatesEditing(true)} type="button">
                        <Pencil size={13} />{t("Edit dates")}</button>
                    )}
                  </>
                ) : (
                  <>
                    <label className="ip-date-field">
                      <span>{t("Issued")}</span>
                      <input
                        className="ip-dash"
                        value={invoiceDraft.invoiceDate}
                        onChange={(event) => updateInvoiceDraft("invoiceDate", event.target.value)}
                        type="date"
                      />
                    </label>
                    <label className="ip-date-field">
                      <span>{t("Due")}</span>
                      <input
                        className="ip-dash"
                        value={invoiceDraft.dueDate}
                        onChange={(event) => updateInvoiceDraft("dueDate", event.target.value)}
                        type="date"
                      />
                    </label>
                    <button className="invoice-inline-edit" onClick={() => setDatesEditing(false)} type="button">{t("Done")}</button>
                  </>
                )}
              </div>
            </header>

            {invoiceSettings.headerText && <p className="ip-template-note">{invoiceSettings.headerText}</p>}

            <div className="ip-parties">
              <div className="ip-party">
                <span className="ip-label">{t("Bill to")}</span>
                {hasInvoiceCustomer ? (
                  <button
                    className="ip-payer ip-dash"
                    onClick={invoiceLocked ? undefined : clearInvoiceCustomer}
                    disabled={invoiceLocked}
                    title={t("Pick a different client")}
                    type="button"
                  >
                    <span>
                      <strong>{invoiceDraft.payerName || invoiceDraft.payerEmail}</strong>
                      <em>{invoiceDraft.payerEmail || invoiceDraft.payerPhone || t("No contact saved")}</em>
                    </span>
                    {!invoiceLocked && <ClarityProfile size={13} />}
                  </button>
                ) : newInvoiceCustomer ? (
                  <div className="ip-new-customer">
                    <label className="settings-field">
                      <span>{t("Name")}</span>
                      <input
                        className="w-name"
                        value={newInvoiceCustomer.name}
                        onChange={(event) => updateNewInvoiceCustomer("name", event.target.value)}
                        placeholder={t("Customer name")}
                        autoFocus
                      />
                    </label>
                    <label className="settings-field">
                      <span>{t("Email")}</span>
                      <input
                        className="w-email"
                        value={newInvoiceCustomer.email}
                        onChange={(event) => updateNewInvoiceCustomer("email", event.target.value)}
                        placeholder={t("name@example.com")}
                        type="email"
                      />
                    </label>
                    <label className="settings-field">
                      <span>{t("Phone")}</span>
                      <input
                        className="w-name"
                        value={newInvoiceCustomer.phone}
                        onChange={(event) => updateNewInvoiceCustomer("phone", event.target.value)}
                        placeholder={t("Optional")}
                      />
                    </label>
                    <div className="ip-new-customer-actions">
                      {/* Rule 10: Cancel is text. A box around it gives
                          backing out the same weight as adding the
                          client, which is what the form is for. */}
                      <button className="text-button" onClick={() => setNewInvoiceCustomer(null)} type="button">{t("Cancel")}</button>
                      <button
                        className="primary-button"
                        onClick={saveNewInvoiceCustomer}
                        disabled={newInvoiceCustomerSaving}
                        type="button"
                      >
                        {newInvoiceCustomerSaving ? t("Adding...") : t("Add to clients")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ip-payer-search">
                    <input
                      className="ip-dash"
                      value={invoiceCustomerSearch}
                      onChange={(event) => setInvoiceCustomerSearch(event.target.value)}
                      placeholder={t("Search name, email, or phone")}
                    />
                    {(invoiceCustomerMatches.length > 0 || invoiceCustomerCreateLabel) && (
                      <div className="ip-payer-results">
                        {invoiceCustomerMatches.map((person) => (
                          <button key={person.id} onClick={() => selectInvoiceCustomer(person)} type="button">
                            <span>
                              <strong>{person.name}</strong>
                              <em>{person.email || person.phone || t("No contact saved")}</em>
                            </span>
                            <Plus size={14} />
                          </button>
                        ))}
                        {invoiceCustomerCreateLabel && (
                          <button onClick={openNewInvoiceCustomer} type="button">
                            <span>
                              <strong>{t("Create new customer")}</strong>
                              <em>{invoiceCustomerCreateLabel}</em>
                            </span>
                            <Plus size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="ip-party">
                <span className="ip-label">{t("Reference")}</span>
                {invoiceLocked ? (
                  <p className="settings-static-value">{invoiceDraft.reference || "—"}</p>
                ) : (
                  <input
                    className="ip-dash"
                    value={invoiceDraft.reference}
                    onChange={(event) => updateInvoiceDraft("reference", event.target.value)}
                    placeholder={t("Add a reference")}
                  />
                )}
              </div>
            </div>

            {invoiceCustomFieldsToPrint.some((field) => field.placement === "header" || field.placement === "bill-to") && (
              <div className="ip-custom-fields">
                {invoiceCustomFieldsToPrint
                  .filter((field) => field.placement === "header" || field.placement === "bill-to")
                  .map((field) => (
                    <span key={field.id}>
                      <strong>{field.label}</strong>
                      {field.value || t("Not set")}
                    </span>
                  ))}
              </div>
            )}

            <div className="ip-lines">
              <div className="ip-line-head">
                <span>{t("Item")}</span>
                <span>{t("Qty")}</span>
                <span>{t("Unit")}</span>
                <span>{t("Amount")}</span>
                <span />
                <span />
              </div>

              {invoiceDraft.lines.map((line) => {
                // Once the invoice is locked (a saved invoice opened for
                // viewing) a line reads as a printed line. While it is
                // being edited every line stays fully editable no matter
                // where it came from - a pulled-in price is a starting
                // point, not a fact.
                if (invoiceLocked) {
                  return (
                    <div className="ip-line ip-line-plain" key={line.id}>
                      <span className="ip-line-desc">
                        {line.description}
                        {/* A date only describes a single lesson; a line of several has none. */}
                        {((line.serviceDate && line.quantity <= 1) || line.tag) && (
                          <em className="ip-line-meta">
                            {[line.serviceDate && line.quantity <= 1 ? formatDateForDisplay(line.serviceDate) : "", invoiceLineTagLabel(line.tag)]
                              .filter(Boolean)
                              .join(" · ")}
                          </em>
                        )}
                      </span>
                      <span className="ip-line-qty">{line.quantity}</span>
                      <span className="ip-line-unit">{formatMoney(line.unitPrice, invoiceSettings.currency)}</span>
                      <span className="ip-line-amount">
                        <strong>{formatMoney(invoiceLineNet(line), invoiceSettings.currency)}</strong>
                        {lineDiscountAmount(line) > 0 && (
                          <em>{formatMoney(invoiceLineGross(line), invoiceSettings.currency)}</em>
                        )}
                      </span>
                      <span />
                      <span />
                    </div>
                  );
                }
                const drawerOpen = openInvoiceLineId === line.id;
                // The discount picker opens as the saved-discount list.
                // The custom boxes only appear once they are asked for -
                // either by picking "+ Custom", or because this line
                // already carries a discount that is not a saved one.
                const activeDiscountPresets = discountPresets.filter((preset) => preset.active);
                const customDiscountOpen =
                  !activeDiscountPresets.length ||
                  customDiscountLineId === line.id ||
                  (line.discountKind !== "none" && !line.discountPresetId);
                return (
                  <div className={`ip-line${drawerOpen ? " is-open" : ""}`} key={line.id}>
                    <input
                      className="ip-dash ip-line-desc"
                      value={line.description}
                      onChange={(event) => updateInvoiceLine(line.id, "description", event.target.value)}
                      placeholder={t("What are you charging for?")}
                      aria-label={t("Line item")}
                    />
                    <input
                      className="ip-dash ip-line-qty"
                      value={line.quantity}
                      inputMode="numeric"
                      onChange={(event) => updateInvoiceLine(line.id, "quantity", parseQuantityInput(event.target.value))}
                      type="text"
                      aria-label={t("Quantity")}
                    />
                    <label className="ip-dash ip-line-unit ip-affix">
                      <span aria-hidden="true">{currencySymbol(invoiceSettings.currency)}</span>
                      <input
                        value={line.unitPrice}
                        inputMode="decimal"
                        onChange={(event) => updateInvoiceLine(line.id, "unitPrice", parseMoneyInput(event.target.value))}
                        type="text"
                        aria-label={t("Unit price in {currency}", { currency: invoiceSettings.currency })}
                      />
                    </label>
                    <span className="ip-line-amount">
                      <strong>{formatMoney(invoiceLineNet(line), invoiceSettings.currency)}</strong>
                      {lineDiscountAmount(line) > 0 && (
                        <em>{formatMoney(invoiceLineGross(line), invoiceSettings.currency)}</em>
                      )}
                    </span>
                    <button
                      className="ip-line-remove"
                      onClick={() => {
                        if (openInvoiceLineId === line.id) setOpenInvoiceLineId("");
                        if (customDiscountLineId === line.id) setCustomDiscountLineId("");
                        removeInvoiceLine(line.id);
                      }}
                      title={t("Remove this line")}
                      aria-label={t("Remove this line")}
                      type="button"
                    >
                      <X size={14} />
                    </button>
                    <button
                      className={`ip-line-toggle${drawerOpen ? " is-open" : ""}`}
                      onClick={() => {
                        setOpenInvoiceLineId(drawerOpen ? "" : line.id);
                        setCustomDiscountLineId("");
                      }}
                      title={drawerOpen ? t("Close") : t("Discount for this line")}
                      aria-label={drawerOpen ? t("Close line options") : t("Discount for this line")}
                      aria-expanded={drawerOpen}
                      type="button"
                    >
                      {drawerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>

                    {drawerOpen && (
                      <div className="ip-line-drawer">
                        {customDiscountOpen ? (
                          <>
                            <label className="ip-drawer-field ip-drawer-money">
                              <span>{t("Amount off")}</span>
                              <div className="ip-dash ip-affix">
                                <i aria-hidden="true">{currencySymbol(invoiceSettings.currency)}</i>
                                <input
                                  value={line.discountKind === "amount" ? line.discountValue || "" : ""}
                                  inputMode="decimal"
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    setInvoiceLineDiscount(line.id, raw ? "amount" : "");
                                    if (raw) updateInvoiceLine(line.id, "discountValue", parseMoneyInput(raw));
                                  }}
                                  placeholder="0.00"
                                  type="text"
                                />
                              </div>
                            </label>
                            <label className="ip-drawer-field ip-drawer-percent">
                              <span>{t("Percent off")}</span>
                              <div className="ip-dash ip-affix">
                                <input
                                  value={line.discountKind === "percent" ? line.discountValue || "" : ""}
                                  inputMode="decimal"
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    setInvoiceLineDiscount(line.id, raw ? "percent" : "");
                                    if (raw) updateInvoiceLine(line.id, "discountValue", parseMoneyInput(raw));
                                  }}
                                  placeholder="0"
                                  type="text"
                                />
                                <i aria-hidden="true">%</i>
                              </div>
                            </label>
                            {activeDiscountPresets.length > 0 && (
                              <button
                                className="ip-drawer-back"
                                onClick={() => {
                                  setCustomDiscountLineId("");
                                  setInvoiceLineDiscount(line.id, "");
                                }}
                                type="button"
                              >{t("Saved discounts")}</button>
                            )}
                          </>
                        ) : (
                          <label className="ip-drawer-field ip-drawer-preset">
                            <span>{t("Discount")}</span>
                            <select
                              className="ip-dash"
                              value={invoiceLineDiscountSelection(line)}
                              onChange={(event) => {
                                const selection = event.target.value;
                                // "+ Custom" is a mode, not a discount:
                                // it swaps the list for the boxes and
                                // leaves the line undiscounted until a
                                // figure is typed.
                                if (selection === "custom") {
                                  setCustomDiscountLineId(line.id);
                                  return;
                                }
                                setCustomDiscountLineId("");
                                setInvoiceLineDiscount(line.id, selection);
                              }}
                            >
                              <option value="">{t("No discount")}</option>
                              {activeDiscountPresets.map((preset) => (
                                <option key={preset.id} value={`preset:${preset.id}`}>
                                  {preset.name} (
                                  {preset.discountType === "percentage"
                                    ? `${preset.value}%`
                                    : formatMoney(preset.value, invoiceSettings.currency)}
                                  )
                                </option>
                              ))}
                              <option value="custom">{t("+ Custom")}</option>
                            </select>
                          </label>
                        )}
                        <label className="ip-drawer-field ip-drawer-date">
                          <span>{t("Date")}</span>
                          <input
                            className="ip-dash"
                            value={line.serviceDate}
                            onChange={(event) => updateInvoiceLine(line.id, "serviceDate", event.target.value)}
                            type="date"
                            aria-label={t("Date this line was delivered")}
                          />
                        </label>
                        {/* The Tag picker only exists once the coach has
                            a list to pick from. A workspace that doesn't
                            report this way never sees an empty select. */}
                        {invoiceLineTagOptions.length > 0 && (
                          <label className="ip-drawer-field ip-drawer-tag">
                            <span>{t("Tag")}</span>
                            <select
                              className="ip-dash"
                              value={line.tag}
                              onChange={(event) => updateInvoiceLine(line.id, "tag", event.target.value)}
                            >
                              <option value="">{t("No tag")}</option>
                              {invoiceLineTagOptions.map((tag) => (
                                <option key={tag.id} value={tag.id}>
                                  {tag.label.trim()}
                                </option>
                              ))}
                              {/* A tag retired from the list after this
                                  line was saved still has to be pickable,
                                  or opening the draft would silently
                                  clear it on the next save. */}
                              {line.tag && !invoiceLineTagOptions.some((tag) => tag.id === line.tag) && (
                                <option value={line.tag}>{t("{tag} (retired)", { tag: line.tag })}</option>
                              )}
                            </select>
                          </label>
                        )}
                        {customDiscountOpen && (
                          <span className="ip-drawer-note">{t("One discount per line — filling one box clears the other. The invoice-wide discount below still applies on top.")}</span>
                        )}
                        {invoiceLineTagOptions.length > 0 && (
                          <span className="ip-drawer-note">{t("Tags are your own list — coach, location, whatever you report on — kept in Billing › Settings.")}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {!invoiceDraft.lines.length && (
                <p className="ip-lines-empty">
                  {phoneLayout
                    ? t("No lines yet. Pull in a lesson or a product, or start a blank one.")
                    : t("No lines yet. Pull a lesson from the right, or start a blank one.")}
                </p>
              )}

              {!invoiceLocked && (
                <button className="ip-add-line" onClick={addManualInvoiceLine} type="button">
                  <Plus size={14} />{t("Add a line")}</button>
              )}
              {/* On a phone the lessons and the catalog sit under the
                  whole sheet, so they are a tap away from here rather
                  than a long scroll. */}
              {phoneLayout && !invoiceLocked && (
                <div className="ip-phone-pull">
                  <button className="outline-button" onClick={() => scrollToInvoiceRail("ip-rail-lessons")} type="button">
                    <ClarityCalendar size={16} />{t("Completed lessons")}</button>
                  <button className="outline-button" onClick={() => scrollToInvoiceRail("ip-rail-catalog")} type="button">
                    <ClarityProducts size={16} />{t("Catalog")}</button>
                </div>
              )}
            </div>

            <div className="ip-totals-wrap">
              <div className="ip-totals">
                <div className="ip-total-row">
                  <span>{t("Subtotal")}</span>
                  <span>{formatMoney(invoiceLineSubtotal, invoiceSettings.currency)}</span>
                </div>
                {invoiceLineDiscountTotal > 0 && (
                  <div className="ip-total-row">
                    <span>{t("Line discounts")}</span>
                    <span>− {formatMoney(invoiceLineDiscountTotal, invoiceSettings.currency)}</span>
                  </div>
                )}
                {invoiceLocked ? (
                  discountSet && (
                    <div className="ip-total-row">
                      <span>{invoiceDiscountLabel}</span>
                      <span>− {formatMoney(invoiceDiscountTotal, invoiceSettings.currency)}</span>
                    </div>
                  )
                ) : discountSet && !discountEditing ? (
                  // Applied: reads as part of the totals, with a quiet
                  // remove. Clicking the name reopens the controls.
                  <div className="ip-total-row ip-discount-applied">
                    <button
                      className="ip-discount-name"
                      onClick={() => setDiscountEditing(true)}
                      title={t("Change discount")}
                      type="button"
                    >
                      {invoiceDiscountLabel}
                    </button>
                    <span className="ip-discount-value">
                      − {formatMoney(invoiceDiscountTotal, invoiceSettings.currency)}
                      <button
                        className="ip-discount-remove"
                        onClick={clearInvoiceDiscount}
                        aria-label={t("Remove discount")}
                        title={t("Remove discount")}
                        type="button"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                ) : discountEditing ? (
                  <div className="ip-total-row ip-discount-row">
                    {discountPresets.some((preset) => preset.active) && (
                      <select
                        className="ip-dash ip-discount-preset"
                        value={selectedDiscountPresetId}
                        onChange={(event) => applyDiscountPreset(event.target.value)}
                        aria-label={t("Preset discount")}
                      >
                        <option value="">{t("Manual")}</option>
                        {discountPresets
                          .filter((preset) => preset.active)
                          .map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name} (
                              {preset.discountType === "percentage"
                                ? `${preset.value}%`
                                : formatMoney(preset.value, invoiceSettings.currency)}
                              )
                            </option>
                          ))}
                      </select>
                    )}
                    <input
                      className="ip-dash ip-discount-label"
                      value={invoiceDraft.discountLabel}
                      onChange={(event) => updateInvoiceDraft("discountLabel", event.target.value)}
                      placeholder={t("Discount name")}
                      aria-label={t("Invoice discount label")}
                    />
                    <label className="ip-dash ip-discount-amount ip-affix">
                      <span aria-hidden="true">{currencySymbol(invoiceSettings.currency)}</span>
                      <input
                        value={invoiceDraft.discountPercent ? invoiceDiscountTotal.toFixed(2) : invoiceDraft.discountAmount || ""}
                        inputMode="decimal"
                        placeholder="0.00"
                        onChange={(event) => {
                          // Typing a figure makes it a fixed amount.
                          markInvoiceDraftDirty();
                          setSelectedDiscountPresetId("");
                          const amount = parseMoneyInput(event.target.value);
                          setInvoiceDraft((current) => ({ ...current, discountAmount: amount, discountPercent: 0 }));
                        }}
                        type="text"
                        aria-label={t("Invoice discount amount in {currency}", { currency: invoiceSettings.currency })}
                      />
                    </label>
                    <button className="ip-discount-done" onClick={() => setDiscountEditing(false)} type="button">{t("Done")}</button>
                  </div>
                ) : (
                  <button className="ip-discount-add" onClick={() => setDiscountEditing(true)} type="button">
                    <Plus size={12} />{t("Add discount")}</button>
                )}
                <div className="ip-total-row">
                  <span>{t("Total excl. {taxName}", { taxName: invoiceSettings.taxName })}</span>
                  <span>{formatMoney(invoiceTotal - invoiceTaxTotal, invoiceSettings.currency)}</span>
                </div>
                <div className="ip-total-row">
                  <span>
                    {invoiceSettings.taxName} {invoiceSettings.taxRate}%{invoiceDraft.taxInclusive ? t(" (included)") : t(" (added)")}
                  </span>
                  <span>{formatMoney(invoiceTaxTotal, invoiceSettings.currency)}</span>
                </div>
                <div className="ip-total-row ip-total-grand">
                  <span>{t("Total")}{" "}{invoiceDraft.taxInclusive ? `incl. ${invoiceSettings.taxName}` : "due"}</span>
                  <span>{formatMoney(invoiceTotal, invoiceSettings.currency)}</span>
                </div>
                {!invoiceLocked && (
                  <p className="ip-tax-note">
                    {invoiceDraft.taxInclusive
                      ? t("Prices include {taxName}", { taxName: invoiceSettings.taxName })
                      : `${invoiceSettings.taxName} added on top of prices`}{" "}{t("· set in Billing Settings")}</p>
                )}
              </div>
            </div>

            <div className="ip-note">
              <span className="ip-label">{t("Note to the client")}</span>
              {invoiceLocked ? (
                <p className="settings-static-value">{invoiceDraft.message || "—"}</p>
              ) : (
                <textarea
                  className="ip-dash"
                  value={invoiceDraft.message}
                  onChange={(event) => updateInvoiceDraft("message", event.target.value)}
                  rows={2}
                  placeholder={t("Anything you want on this one invoice")}
                />
              )}
            </div>

            <footer className="ip-paper-foot">
              {invoiceSettings.paymentInstructions ||
              invoiceSettings.bankAccount ||
              invoiceSettings.taxNumber ||
              invoiceCustomFieldsToPrint.some((field) => field.placement === "payment") ? (
                <>
                  {invoiceSettings.paymentInstructions && <span>{invoiceSettings.paymentInstructions}</span>}
                  <em>
                    {[
                      invoiceSettings.bankAccount,
                      coachAccount.businessName,
                      invoiceSettings.taxNumber ? `${invoiceSettings.taxName} registered` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </em>
                  {invoiceCustomFieldsToPrint
                    .filter((field) => field.placement === "payment")
                    .map((field) => (
                      <em key={field.id}>
                        {field.label}: {field.value || t("Not set")}
                      </em>
                    ))}
                </>
              ) : !invoiceLocked ? (
                <button className="invoice-add-detail" onClick={openInvoiceCoachSettings} type="button">
                  <Plus size={15} />{t("Add payment details")}</button>
              ) : null}
              {invoiceCustomFieldsToPrint
                .filter((field) => field.placement === "footer")
                .map((field) => (
                  <em key={field.id}>
                    {field.label}: {field.value || t("Not set")}
                  </em>
                ))}
              {invoiceSettings.footerText && <em>{invoiceSettings.footerText}</em>}
            </footer>
          </article>
        </div>

        <aside className="ip-rail">
          <article className="ip-card" id="ip-rail-lessons">
            <strong className="ip-card-title">{t("Completed lessons")}</strong>
            {/* Same bookingPullFilter the Dashboard's list reads, so the
                two can still never disagree about what they are showing -
                only the control is chips here instead of a select. */}
            <div className="ip-chips" role="group" aria-label={t("Show completed bookings")}>
              {(
                [
                  ["all", t("All")],
                  ["unpaid", t("Unpaid")],
                  ["paid", t("Paid")],
                ] as [BookingPullFilter, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={bookingPullFilter === value ? "is-active" : ""}
                  onClick={() => setBookingPullFilter(value)}
                  aria-pressed={bookingPullFilter === value}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="ip-card-note">
              {bookingPullFilter === "unpaid"
                ? t("Lessons with nothing taken at the counter.")
                : bookingPullFilter === "paid"
                  ? t("Already settled at the till — invoicing one again is a second transaction.")
                  : t("Everything completed. A lesson paid at the counter still shows.")}
            </p>
            <div className="ip-pull-range">
              {pullRangeEditing ? (
                <>
                  <label className="settings-field">
                    <span>{t("From")}</span>
                    <input type="date" value={pullRangeFrom} onChange={(event) => setPullRangeFrom(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>{t("To")}</span>
                    <input type="date" value={pullRangeTo} onChange={(event) => setPullRangeTo(event.target.value)} />
                  </label>
                  <div className="pull-range-actions">
                    <button className="invoice-inline-edit" onClick={resetPullRange} type="button">{t("Reset to auto")}</button>
                    <button className="invoice-inline-edit" onClick={() => setPullRangeEditing(false)} type="button">{t("Done")}</button>
                  </div>
                </>
              ) : (
                <div className="pull-range-summary">
                  <span>
                    {effectivePullFrom ? formatDateForDisplay(effectivePullFrom) : t("Earliest")} → {formatDateForDisplay(effectivePullTo)}
                  </span>
                  <button className="invoice-inline-edit" onClick={openPullRangeEdit} type="button" aria-label={t("Edit pull range")}>
                    <Pencil size={13} />{t("Edit")}</button>
                </div>
              )}
            </div>
            <div className="ip-rail-list">
              {calendarPullRangeSorted.length ? (
                calendarPullRangeSorted.map((item) => {
                  const service = itemService(item, services);
                  const days = buildWeekDays(itemWeek(item));
                  const invoiceLink = invoicedBookingIds[item.id];
                  const alreadyInvoiced = Boolean(invoiceLink);
                  // A counter payment is flagged but does not disable the
                  // row - the lesson can be paid at the till and still be
                  // invoiced. See addCompletedBookingLine.
                  const posPayment = posPaidBookings[item.id];
                  const matchesPayer = invoicePayerBookingIds.has(item.id);
                  return (
                    <button
                      key={item.id}
                      className={alreadyInvoiced ? "is-used" : ""}
                      disabled={alreadyInvoiced}
                      onClick={() => {
                        addCompletedBookingLine(item);
                        if (phoneLayout && !alreadyInvoiced) setToast({ message: t("Added to the invoice.") });
                      }}
                      type="button"
                    >
                      <span className="ip-rail-row-main">
                        <strong>{item.client || item.title}</strong>
                        <em>
                          {service?.name ?? t("Lesson")} · {days[item.day].label}, {formatRange(item.start, item.duration)}
                        </em>
                      </span>
                      <span className="ip-rail-row-side">
                        {matchesPayer && <em className="ip-badge">{t("Billing client")}</em>}
                        {alreadyInvoiced ? (
                          // The invoice it is on, by number - it is not
                          // necessarily the one being edited, and "on an
                          // invoice" without saying which one leaves the
                          // coach to go hunting for it.
                          <em
                            className="ip-badge"
                            title={
                              invoiceLink?.invoiceNumber
                                ? t("Already on invoice {invoiceNumber}", { invoiceNumber: invoiceLink.invoiceNumber })
                                : t("Already on an invoice")
                            }
                          >
                            {invoiceLink?.invoiceNumber || t("Invoiced")}
                          </em>
                        ) : posPayment ? (
                          <em className="ip-badge is-paid">{t("Paid · {amount}", { amount: formatMoney(posPayment.amount, posPayment.currency) })}</em>
                        ) : (
                          <em className="ip-badge">{t("Unpaid")}</em>
                        )}
                      </span>
                    </button>
                  );
                })
              ) : completedAppointments.length ? (
                <p className="ip-card-note">{t("No completed bookings in this date range.")}</p>
              ) : (
                <p className="ip-card-note">{t("Mark bookings completed from the calendar to pull them into invoices.")}</p>
              )}
            </div>
          </article>

          <article className="ip-card" id="ip-rail-catalog">
            <strong className="ip-card-title">{t("Catalog")}</strong>
            <label className="ip-search">
              <Search size={14} />
              <input
                value={invoiceDraft.lineSearch}
                onChange={(event) => updateInvoiceDraft("lineSearch", event.target.value)}
                placeholder={t("Search products and packages")}
                aria-label={t("Search the catalog")}
              />
            </label>
            <div className="ip-rail-list">
              {visibleInvoiceCatalogOptions.length ? (
                visibleInvoiceCatalogOptions.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      addCatalogInvoiceLine(item);
                      if (phoneLayout) setToast({ message: t("Added to the invoice.") });
                    }}
                    type="button"
                  >
                    <span className="ip-rail-icon">
                      {item.kind === "product" ? (
                        <ClarityStore size={14} />
                      ) : item.kind === "package" ? (
                        <ClarityPassesCredits size={14} />
                      ) : (
                        <ClarityCalendar size={14} />
                      )}
                    </span>
                    <span className="ip-rail-row-main">
                      <strong>{item.name}</strong>
                      <em>{item.description || item.kind}</em>
                    </span>
                    <span className="ip-rail-row-side">
                      <strong>{formatMoney(item.price, invoiceSettings.currency)}</strong>
                    </span>
                  </button>
                ))
              ) : (
                <p className="ip-card-note">
                  {invoiceDraft.lineSearch.trim() ? t("Nothing matches that.") : t("Add products and services in Billing › Products.")}
                </p>
              )}
            </div>
          </article>

          <article className="ip-card">
            <strong className="ip-card-title">{t("From your template")}</strong>
            <p className="ip-card-note">{t("Logo, address, {taxName} number, bank account and footer are already on this invoice.", { taxName: invoiceSettings.taxName })}</p>
            <button className="outline-button" onClick={openInvoiceCoachSettings} type="button">
              <Pencil size={13} />{t("Edit the template")}</button>
          </article>
        </aside>
      </div>
    </div>
  );
}
