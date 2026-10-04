import { ArrowLeft, Check, ExternalLink, GitMerge, Phone, Plus, Trash2, X } from "lucide-react";
import { Suspense, useRef } from "react";
import { t, tn } from "../../lib/i18n";
import { formatMoney } from "../../lib/money";
import { posMethodLabel } from "../billing/terminal";
import { buildWeekDays, formatRange, itemService, itemWeek } from "../calendar/calendarModel";
import { notificationKindLabel, notificationStatusLabel, notificationTimeLabel } from "../notifications/notificationModel";
import { PassesPanel, PersonMemberships } from "../passes/lazyPanels";
import { usePhoneLayout } from "../phone/phoneLayout";
import { PhoneStepSwipe } from "../phone/PhoneStepSwipe";
import {
  ClarityAccessPermissions,
  ClarityBookingPages,
  ClarityCalendar,
  ClarityEmail,
  ClarityIntegrations,
  ClarityPassesCredits,
  ClarityPayments,
  ClarityProfile,
  ClarityVideoAnalysis,
} from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import {
  caddyProfileUrl,
  editorFromClient,
  preferredVideoPlayerId,
  profileNotesText,
} from "./clientMatching";
import type { ClientProfileController } from "./useClientProfileController";

/** The client profile dialog. Everything it shows and does comes from its controller. */
export function ClientProfileView({ clientProfile }: { clientProfile: ClientProfileController }) {
  const {
    closeClientModal,
    isAddingClient,
    clientEditMode,
    clientEditor,
    setClientEditor,
    selectedClient,
    setToast,
    clientMoveSavingId,
    moveExternalClientToMain,
    openVideoAnalysisForClient,
    videoPlayerIds,
    clientProfileTab,
    setClientProfileTab,
    selectedClientAppointments,
    services,
    bookingPaymentBadge,
    openNotesForClient,
    fetchClientPasses,
    clientPasses,
    clientInvoicedLines,
    clientUnmatchedInvoicedLines,
    passTemplates,
    passCoverableServices,
    clientPassesLoadState,
    passGranting,
    grantClientPass,
    voidClientPass,
    redeemClientPassCredit,
    returnClientPassCredit,
    selectedClientId,
    selectedClientNotifications,
    clientTransactionsLoadState,
    fetchClientTransactions,
    clientTransactions,
    transactionDateLabel,
    switchView,
    openInvoiceForEdit,
    saveClientProfile,
    clientSaveState,
    setClientEditMode,
    billingWorkspaceEnabled,
    openPosCheckoutForClient,
    startClientEdit,
    hasSelectedClientCaddyProfile,
    caddyWorkspaceUrl,
    isAdminUser,
    personDeleteBusyId,
    hardDeletePerson,
  } = clientProfile;
  // On a phone the profile is a page laid over the screen it was opened from,
  // not a box floating in the middle: Back arrow top left, swipe right to
  // slide it off, and that screen's edge showing down the left like the sheet
  // underneath (the phone's back rule, see PhoneStepSwipe).
  const phoneLayout = usePhoneLayout();
  const panelRef = useRef<HTMLElement>(null);

  return (
    <div className="details-overlay client-profile-overlay" role="presentation" onPointerDown={closeClientModal}>
      {phoneLayout ? (
        <PhoneStepSwipe panelRef={panelRef} back={{ label: "", go: closeClientModal }} forward={null} paper={false} />
      ) : null}
      <aside
        ref={panelRef}
        className="details-panel details-modal client-profile-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-profile-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          {phoneLayout ? (
            <button type="button" className="phone-back-button" onClick={closeClientModal} aria-label={t("Back")}>
              <ArrowLeft size={22} />
            </button>
          ) : null}
          <span>{isAddingClient ? t("Add Client") : t("Client Profile")}</span>
          {phoneLayout ? null : (
            <button className="icon-button small" onClick={closeClientModal} aria-label={t("Close client profile")}>
              <X size={17} />
            </button>
          )}
        </div>

        {clientEditMode ? (
          <div className="client-editor">
            <label className="settings-field">
              <span>{t("Name")}</span>
              <input
                value={clientEditor.name}
                autoComplete="name"
                onChange={(event) => setClientEditor((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="settings-field">
              <span>{t("Email")}</span>
              <input
                value={clientEditor.email}
                autoComplete="email"
                inputMode="email"
                onChange={(event) => setClientEditor((current) => ({ ...current, email: event.target.value }))}
                type="email"
              />
            </label>
            <label className="settings-field">
              <span>{t("Phone")}</span>
              <input
                value={clientEditor.phone}
                autoComplete="tel"
                inputMode="tel"
                onChange={(event) => setClientEditor((current) => ({ ...current, phone: event.target.value }))}
                type="tel"
              />
            </label>
            <label className="settings-field">
              <span>{t("Caddy profile URL")}</span>
              <input
                value={clientEditor.caddyProfileUrl}
                onChange={(event) =>
                  setClientEditor((current) => ({ ...current, caddyProfileUrl: event.target.value }))
                }
              />
            </label>
            <label className="settings-field">
              <span>{t("Profile notes")}</span>
              <textarea
                value={clientEditor.notes}
                onChange={(event) => setClientEditor((current) => ({ ...current, notes: event.target.value }))}
              />
            </label>
          </div>
        ) : (
          <>
            <h2 id="client-profile-title">{selectedClient?.name}</h2>
            <div className="info-stack client-profile-info">
              <div>
                <ClarityEmail size={16} />
                <span>{selectedClient?.email || t("No email yet")}</span>
              </div>
              <div>
                <Phone size={16} />
                <span>{selectedClient?.phone || t("No phone yet")}</span>
              </div>
              <div>
                <ClarityCalendar size={16} />
                <span>
                  {tn(selectedClient?.count ?? 0, "{count} booking", "{count} bookings")}
                </span>
              </div>
              {selectedClient && (
                <div>
                  <ClarityAccessPermissions size={16} />
                  <span
                    className="client-profile-user-id"
                    title={t("Copy this client's id")}
                    onClick={() => {
                      void navigator.clipboard?.writeText(selectedClient.id).catch(() => {});
                      setToast({ message: t("Client id copied.") });
                    }}
                  >{t("ID: {id}", { id: selectedClient.id })}</span>
                </div>
              )}
            </div>
            {selectedClient && profileNotesText(selectedClient) && (
              <div className="client-profile-note-block">
                <strong>{t("Profile notes")}</strong>
                <p>{profileNotesText(selectedClient)}</p>
              </div>
            )}
            {selectedClient?.external === true && (
              <button
                type="button"
                className="outline-button client-move-button"
                disabled={clientMoveSavingId === selectedClient.id}
                onClick={() => void moveExternalClientToMain(selectedClient)}
              >
                <GitMerge size={16} />
                {clientMoveSavingId === selectedClient.id ? t("Moving…") : t("Move to clients")}
              </button>
            )}
            {selectedClient && (
              <button
                type="button"
                className="outline-button client-video-button"
                onClick={() =>
                  openVideoAnalysisForClient({
                    id: preferredVideoPlayerId(selectedClient, videoPlayerIds),
                    name: selectedClient.name,
                  })
                }
              >
                <ClarityVideoAnalysis size={16} />{t("Open Video Analysis")}</button>
            )}
          </>
        )}

        {!isAddingClient && (
          <div className="client-profile-tabs">
            <div className="profile-tab-list" role="tablist" aria-label={t("Client profile sections")}>
              <button
                className={clientProfileTab === "bookings" ? "active" : ""}
                onClick={() => setClientProfileTab("bookings")}
                role="tab"
                type="button"
                aria-selected={clientProfileTab === "bookings"}
              >
                <ClarityCalendar size={16} />{t("Booking history")}</button>
              <button
                className={clientProfileTab === "notes" ? "active" : ""}
                onClick={() => setClientProfileTab("notes")}
                role="tab"
                type="button"
                aria-selected={clientProfileTab === "notes"}
              >
                <ClarityBookingPages size={16} />{t("Lesson notes")}</button>
              <button
                className={clientProfileTab === "notifications" ? "active" : ""}
                onClick={() => setClientProfileTab("notifications")}
                role="tab"
                type="button"
                aria-selected={clientProfileTab === "notifications"}
              >
                <ClarityEmail size={16} />{t("Emails sent")}</button>
              <button
                className={clientProfileTab === "transactions" ? "active" : ""}
                onClick={() => setClientProfileTab("transactions")}
                role="tab"
                type="button"
                aria-selected={clientProfileTab === "transactions"}
              >
                <ClarityPayments size={16} />{t("Transactions")}</button>
              <button
                className={clientProfileTab === "passes" ? "active" : ""}
                onClick={() => setClientProfileTab("passes")}
                role="tab"
                type="button"
                aria-selected={clientProfileTab === "passes"}
              >
                <ClarityPassesCredits size={16} />{t("Passes")}</button>
            </div>

            <div className="profile-history-panel">
              {clientProfileTab === "bookings" ? (
                selectedClientAppointments.length ? (
                  selectedClientAppointments.map((appointment) => {
                    const appointmentDays = buildWeekDays(itemWeek(appointment));
                    const service = itemService(appointment, services);
                    return (
                      <div className="profile-history-row" key={appointment.id}>
                        <div>
                          <strong>{service?.name ?? appointment.title}</strong>
                          <span>{appointment.kind === "appointment" ? t("Booked lesson") : t("Blocked time")}</span>
                          {appointment.kind === "appointment" &&
                            appointment.status !== "cancelled" &&
                            (() => {
                              // How this one was settled, read off the maps
                              // the billing screens already keep. Shown
                              // here because "which of these did the pass
                              // pay for" is the question the credits on the
                              // Passes tab cannot answer on their own.
                              const badge = bookingPaymentBadge(appointment.id);
                              return badge ? (
                                <span className={`booking-paid-badge booking-paid-${badge.tone}`}>
                                  {badge.label}
                                </span>
                              ) : null;
                            })()}
                          {appointment.note ? (
                            <span className="booking-note-line">{t("Booking notes: {note}", { note: appointment.note })}</span>
                          ) : null}
                        </div>
                        <em>{`${appointmentDays[appointment.day].label}, ${formatRange(appointment.start, appointment.duration)}`}</em>
                      </div>
                    );
                  })
                ) : (
                  <p>{t("No appointments yet.")}</p>
                )
              ) : clientProfileTab === "notes" ? (
                <div className="lesson-notes-panel">
                  {selectedClient && (
                    <div className="lesson-notes-window">
                      <div>
                        <strong>{t("Lesson Notes")}</strong>
                        <span>{t("Start something fresh, or open the player profile for older records.")}</span>
                      </div>
                      <div className="lesson-quick-actions">
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => openNotesForClient(selectedClient)}
                          title={t("Add lesson note")}
                          aria-label={t("Add lesson note")}
                        >
                          <Plus size={16} />
                          <ClarityBookingPages size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() =>
                            openVideoAnalysisForClient({
                              id: preferredVideoPlayerId(selectedClient, videoPlayerIds),
                              name: selectedClient.name,
                            })
                          }
                          title={t("Add video")}
                          aria-label={t("Add video")}
                        >
                          <Plus size={16} />
                          <ClarityVideoAnalysis size={15} />
                        </button>
                        <button
                          type="button"
                          className="outline-button"
                          onClick={() => openNotesForClient(selectedClient)}
                        >
                          <ClarityProfile size={15} />{t("Player profile")}</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : clientProfileTab === "passes" ? (
                selectedClient && selectedClient.id.startsWith("appointment-") ? (
                  <p>{t("Save this booking contact as a client before giving them a pass.")}</p>
                ) : (
                  <Suspense fallback={<Loading what={t("passes")} />}>
                    {selectedClient ? (
                      <PersonMemberships
                        personId={selectedClient.id}
                        formatMoney={formatMoney}
                        notify={(message) => setToast({ message })}
                        onPassesChanged={() => void fetchClientPasses(selectedClient.id)}
                      />
                    ) : null}
                    <PassesPanel
                      passes={clientPasses}
                      invoicedLines={clientInvoicedLines}
                      unmatchedInvoicedLines={clientUnmatchedInvoicedLines}
                      templates={passTemplates}
                      coverableServices={passCoverableServices}
                      loadState={clientPassesLoadState}
                      granting={passGranting}
                      onGrant={(grant) => void grantClientPass(grant)}
                      onVoid={(pass) => void voidClientPass(pass)}
                      onRedeem={(passId, credits, note) =>
                        void redeemClientPassCredit(passId, credits, note)
                      }
                      onReturnCredit={(redemptionId) => void returnClientPassCredit(redemptionId)}
                      onRetry={() => selectedClientId && void fetchClientPasses(selectedClientId)}
                      serviceName={(serviceId) =>
                        services.find((service) => service.id === serviceId)?.name || serviceId
                      }
                    />
                  </Suspense>
                )
              ) : clientProfileTab === "notifications" ? (
                selectedClientNotifications.length ? (
                  selectedClientNotifications.map((notification) => (
                    <div className="profile-history-row notification-history-row" key={notification.id}>
                      <div>
                        <strong>{notification.subject || notificationKindLabel(notification.kind)}</strong>
                        <span>{t("{kind} to {recipient}", { kind: notificationKindLabel(notification.kind), recipient: notification.recipient })}</span>
                      </div>
                      <em>
                        {notificationStatusLabel(notification)}
                        {notification.createdAt ? ` · ${notificationTimeLabel(notification.createdAt)}` : ""}
                      </em>
                    </div>
                  ))
                ) : (
                  <p>{t("No email receipts recorded yet.")}</p>
                )
              ) : selectedClient && selectedClient.id.startsWith("appointment-") ? (
                <p>{t("Save this booking contact as a client to track their transactions.")}</p>
              ) : clientTransactionsLoadState === "loading" ? (
                <Loading what={t("transactions")} />
              ) : clientTransactionsLoadState === "error" ? (
                <p>{t("Could not load transactions.")}{" "}{selectedClient && (
                    <button
                      className="link-button"
                      onClick={() => void fetchClientTransactions(selectedClient.id)}
                      type="button"
                    >{t("Retry")}</button>
                  )}
                </p>
              ) : clientTransactions.length ? (
                clientTransactions.map((row) =>
                  row.kind === "coupon" ? (
                    <div className="profile-history-row" key={`coupon-${row.coupon.id}`}>
                      <div>
                        <strong>
                          <ClarityPassesCredits size={15} /> {row.coupon.code}
                        </strong>
                        <span>{t("Gift voucher")}{row.coupon.issuedToName ? t(" · bought by {issuedToName}", { issuedToName: row.coupon.issuedToName }) : ""}
                          {row.coupon.note ? ` · ${row.coupon.note}` : ""}
                        </span>
                      </div>
                      <em>
                        {/* What is left, not what it was worth: the
                            question asked at a counter is always "how much
                            is on this", and the original is beside it only
                            because a half-spent voucher is confusing
                            without it. */}
                        {t("{remainingValue} left of {originalValue} · {date}", { remainingValue: formatMoney(row.coupon.remainingValue, row.coupon.currency), originalValue: formatMoney(
                          row.coupon.originalValue,
                          row.coupon.currency,
                        ), date: transactionDateLabel(row.date) })}
                      </em>
                    </div>
                  ) : row.kind === "sale" ? (
                    <div className="profile-history-row" key={`sale-${row.sale.id}`}>
                      <div>
                        <strong>{row.sale.description || row.sale.receiptNumber}</strong>
                        <span>
                          {row.sale.receiptNumber} · {posMethodLabel(row.sale)}
                          {row.sale.isLessonPass ? t(" · Lesson pass") : ""}
                        </span>
                      </div>
                      <em>{`${formatMoney(row.sale.amount, row.sale.currency)} · ${row.sale.status} · ${transactionDateLabel(row.date)}`}</em>
                    </div>
                  ) : (
                    <div className="profile-history-row" key={`invoice-${row.invoice.id}`}>
                      <div>
                        <strong>
                          <button
                            className="link-button"
                            onClick={() => {
                              // The invoice editor lives in the Billing view;
                              // close the profile modal and go there, or the
                              // invoice opens invisibly underneath it.
                              closeClientModal();
                              switchView("billing");
                              void openInvoiceForEdit(row.invoice);
                            }}
                            type="button"
                          >
                            {row.invoice.invoiceNumber}
                          </button>
                        </strong>
                        <span>
                          {row.invoice.relation === "included"
                            ? t("Included on an invoice billed to {name}", { name: row.invoice.customerName || t("someone else") })

                            : t("Invoice")}
                        </span>
                      </div>
                      <em>{`${formatMoney(row.invoice.total, row.invoice.currency)} · ${row.invoice.status} · ${transactionDateLabel(row.date)}`}</em>
                    </div>
                  ),
                )
              ) : (
                <p>{t("No transactions for this client yet.")}</p>
              )}
            </div>
          </div>
        )}

        <div className="panel-actions">
          {clientEditMode ? (
            <>
              <button className="primary-button" onClick={saveClientProfile} disabled={clientSaveState === "saving"}>
                <Check size={16} />
                {clientSaveState === "saving" ? t("Saving") : t("Save")}
              </button>
              <button
                className="outline-button"
                onClick={() => {
                  if (isAddingClient) {
                    closeClientModal();
                    return;
                  }
                  setClientEditMode(false);
                  if (selectedClient) setClientEditor(editorFromClient(selectedClient));
                }}
              >{t("Cancel")}</button>
            </>
          ) : (
            <>
              {selectedClient && billingWorkspaceEnabled && (
                <button
                  className="primary-button"
                  onClick={() => openPosCheckoutForClient(selectedClient)}
                  type="button"
                >
                  <ClarityPayments size={16} />{t("Checkout")}</button>
              )}
              <button className="primary-button" onClick={startClientEdit}>
                <ClarityProfile size={16} />{t("Edit")}</button>
              {selectedClient && hasSelectedClientCaddyProfile ? (
                <a
                  className="outline-button"
                  href={caddyProfileUrl(selectedClient, caddyWorkspaceUrl)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} />{t("Caddy")}</a>
              ) : (
                <button className="outline-button" type="button">
                  <ClarityIntegrations size={16} />{t("Add Clarity Caddy")}</button>
              )}
              {selectedClient && isAdminUser && (
                <button
                  type="button"
                  className="danger-button"
                  disabled={personDeleteBusyId === selectedClient.id}
                  onClick={() => void hardDeletePerson(selectedClient)}
                  title={t("Permanently delete this client and their data. No email is sent.")}
                >
                  <Trash2 size={16} />
                  {personDeleteBusyId === selectedClient.id ? t("Deleting…") : t("Delete permanently")}
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
