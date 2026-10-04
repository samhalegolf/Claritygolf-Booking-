import { ArrowLeft, Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { formatMoney } from "../../lib/money";
import { usePhoneLayout } from "../phone/phoneLayout";
import { customGroupMaxParticipants } from "../services/serviceModel";
import { ClarityProfile, ClaritySessions } from "../shared/ClarityIcons";
import { locationById } from "../workspace/workspaceModel";
import { bookingCoachSnapshotFor, type CalendarItem, customGroupStatusLabel } from "./calendarModel";
import type { CalendarController } from "./useCalendarController";

/** How many lesson types a phone sheet lists before "more". */
const PHONE_SERVICE_COUNT = 3;

/**
 * Making a booking at a time already picked: the lesson type first, then who
 * it is for. The calendar shows it in a popover over the time tapped; Book
 * shows it as the second step of its own screen.
 */
export function QuickCreateForm({
  calendar,
  allowBlocks = false,
  onCreated,
}: {
  calendar: CalendarController;
  /** Offer blocking the time out instead. The calendar does; Book is for bookings. */
  allowBlocks?: boolean;
  onCreated?: (item: CalendarItem) => void;
}) {
  const {
    quickCreate,
    quickCreateService,
    quickCreateServices,
    selectQuickService,
    effectiveCalendarPerspective,
    createBlockFromQuick,
    backToQuickServiceChoice,
    quickCreateChoices,
    chooseQuickCreateScope,
    quickCreateAvailabilityError,
    quickCreateCandidate,
    coachProfiles,
    locations,
    quickClientSearch,
    setQuickMatchField,
    setQuickClientSearch,
    setQuickCreate,
    confirmQuickAppointment,
    quickClientMatchButton,
    updateQuickCreateField,
    quickCreateIsCustomGroup,
    quickCreateCustomGroupParticipantCount,
    quickCreateCustomGroupPrice,
    removeQuickCreateCustomGroupAttendee,
    updateQuickCreateAttendeeDraft,
    addQuickCreateCustomGroupAttendee,
  } = calendar;
  const phoneLayout = usePhoneLayout();
  const [showAllServices, setShowAllServices] = useState(false);
  if (!quickCreate) return null;

  // A phone sheet holds the first few lesson types; the rest are one tap away
  // rather than pushing the sheet up over the time that was tapped.
  const shortList = phoneLayout && !showAllServices && quickCreateServices.length > PHONE_SERVICE_COUNT + 1;
  const listedServices = shortList ? quickCreateServices.slice(0, PHONE_SERVICE_COUNT) : quickCreateServices;

  function submit() {
    const created = confirmQuickAppointment();
    if (created) onCreated?.(created);
  }

  return !quickCreateService ? (
    <>
      {listedServices.map((service) => (
        <button key={service.id} onClick={() => selectQuickService(service.id)}>
          <Plus size={16} />
          <span>
            <strong>{service.name}</strong>
            <em>{t("{duration} min · {price}", { duration: service.duration, price: formatMoney(service.price) })}</em>
          </span>
        </button>
      ))}
      {shortList ? (
        <button className="quick-create-more" onClick={() => setShowAllServices(true)} type="button">
          <ChevronDown size={16} />
          {t("More")}
          <em>{quickCreateServices.length - PHONE_SERVICE_COUNT}</em>
        </button>
      ) : null}
      {/* Blocking time out is the odd one out here, so it is a slim row under
          the lesson types rather than another card the same size as them. */}
      {!allowBlocks ? null : effectiveCalendarPerspective === "location" ? (
        <>
          <button className="quick-create-block" onClick={() => createBlockFromQuick("location")}>
            <ClaritySessions size={14} />{t("Block this location")}</button>
          {quickCreate.coachId ? (
            <button className="quick-create-block" onClick={() => createBlockFromQuick("coach-location")}>
              <ClaritySessions size={14} />{t("Block this coach")}</button>
          ) : null}
        </>
      ) : (
        <button className="quick-create-block" onClick={() => createBlockFromQuick("coach-location")}>
          <ClaritySessions size={14} />{t("Block 30 minutes")}</button>
      )}
    </>
  ) : (
    <div className="quick-create-form">
      <button className="quick-service-summary" onClick={backToQuickServiceChoice} type="button">
        <span>
          <strong>{quickCreateService.name}</strong>
          <em>{t("{duration} min · {price}", { duration: quickCreateService.duration, price: formatMoney(quickCreateService.price) })}</em>
        </span>
        <ArrowLeft size={14} />
      </button>
      {quickCreateChoices && !quickCreateChoices.fixedCoachId ? (
        <label>
          <span>{t("Coach")}</span>
          <select
            value={quickCreate.coachId ?? ""}
            onChange={(event) => chooseQuickCreateScope("coachId", event.target.value)}
          >
            <option value="" disabled>{t("Choose a coach")}</option>
            {quickCreateChoices.coachIds.map((coachId) => {
              const coach = bookingCoachSnapshotFor(coachId, coachProfiles);
              const free = !quickCreateAvailabilityError(quickCreateCandidate!, quickCreateService, {
                coachId,
                locationId: quickCreate.locationId,
              });
              return (
                <option key={coachId} value={coachId}>
                  {coach?.displayName || coach?.name || coachId}
                  {free ? "" : t(" (busy)")}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}
      {quickCreateChoices && !quickCreateChoices.fixedLocationId ? (
        <label>
          <span>{t("Location")}</span>
          <select
            value={quickCreate.locationId ?? ""}
            onChange={(event) => chooseQuickCreateScope("locationId", event.target.value)}
          >
            <option value="" disabled>{t("Choose a location")}</option>
            {quickCreateChoices.locationIds.map((locationId) => {
              const location = locationById(locations, locationId);
              const free = !quickCreateAvailabilityError(quickCreateCandidate!, quickCreateService, {
                coachId: quickCreate.coachId,
                locationId,
              });
              return (
                <option key={locationId} value={locationId}>
                  {location?.shortName || location?.name || locationId}
                  {free ? "" : t(" (busy)")}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}
      <label>
        <span>{t("Name")}</span>
        <div className="quick-match-anchor">
          <div className="quick-client-search w-name">
            <Search size={15} />
            <input
              value={quickClientSearch}
              autoComplete="name"
              onBlur={() => setQuickMatchField("")}
              onFocus={() => setQuickMatchField("name")}
              onChange={(event) => {
                setQuickMatchField("name");
                setQuickClientSearch(event.target.value);
                setQuickCreate((current) => (current ? { ...current, error: "" } : current));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("Client name")}
            />
          </div>
          {quickClientMatchButton("name")}
        </div>
      </label>
      <label>
        <span>{t("Phone")}</span>
        <div className="quick-match-anchor">
            <input
              className="w-name"
              value={quickCreate.phone}
              autoComplete="tel"
              inputMode="tel"
              type="tel"
              onBlur={() => setQuickMatchField("")}
              onFocus={() => setQuickMatchField("phone")}
              onChange={(event) => {
              setQuickMatchField("phone");
              updateQuickCreateField("phone", event.target.value);
            }}
            placeholder="+64"
          />
          {quickClientMatchButton("phone")}
        </div>
      </label>
      <label>
        <span>{t("Email")}</span>
        <div className="quick-match-anchor">
            <input
              className="w-email"
              value={quickCreate.email}
              autoComplete="email"
              inputMode="email"
              onFocus={() => setQuickMatchField("email")}
              onBlur={() => setQuickMatchField("")}
              onChange={(event) => {
              setQuickMatchField("email");
              updateQuickCreateField("email", event.target.value);
            }}
            placeholder={t("client@example.com")}
            type="email"
          />
          {quickClientMatchButton("email")}
        </div>
      </label>
      <label>
        <span>{t("Lesson note")}</span>
        <textarea
          className="w-prose"
          value={quickCreate.note}
          onChange={(event) => updateQuickCreateField("note", event.target.value)}
          placeholder={t("Optional")}
        />
      </label>
      {quickCreateIsCustomGroup && quickCreateService && (
        <div className="lesson-receipts-panel custom-group-admin-panel">
          <div className="receipt-panel-title">
            <ClarityProfile size={16} />
            <span>{t("Custom group attendees")}</span>
            <em>
              {quickCreateCustomGroupParticipantCount} / {customGroupMaxParticipants(quickCreateService)} · {formatMoney(quickCreateCustomGroupPrice)}
            </em>
          </div>
          <div className="email-receipt-row">
            <span className="email-status-dot sent" aria-hidden="true" />
            <div>
              <strong>{quickClientSearch.trim() || t("Booker")}</strong>
              <span>{quickCreate.email.trim() || t("Booker")}</span>
            </div>
            <em>{customGroupStatusLabel("booker")}</em>
          </div>
          {quickCreate.attendees.map((attendee) => (
            <div className="email-receipt-row" key={attendee.id}>
              <span className={`email-status-dot ${attendee.status === "manual" ? "sent" : "pending"}`} aria-hidden="true" />
              <div>
                <strong>{attendee.name}</strong>
                <span>{attendee.email || t("Manual attendee")}</span>
              </div>
              <em>{customGroupStatusLabel(attendee.status)}</em>
              <button className="icon-button small" onClick={() => removeQuickCreateCustomGroupAttendee(attendee.id)} aria-label={t("Remove {name}", { name: attendee.name })}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div className="booking-form custom-group-attendee-form">
            <input
              value={quickCreate.attendeeName}
              onChange={(event) => updateQuickCreateAttendeeDraft("attendeeName", event.target.value)}
              placeholder={t("Attendee name")}
            />
            <input
              value={quickCreate.attendeeEmail}
              onChange={(event) => updateQuickCreateAttendeeDraft("attendeeEmail", event.target.value)}
              placeholder={t("Email optional")}
              type="email"
            />
            <button
              className="outline-button"
              onClick={addQuickCreateCustomGroupAttendee}
              disabled={quickCreateCustomGroupParticipantCount >= customGroupMaxParticipants(quickCreateService)}
              type="button"
            >
              <Plus size={15} />
              {quickCreate.attendeeEmail.trim() ? t("Send invite") : t("Confirm attendee")}
            </button>
          </div>
        </div>
      )}
      {quickCreate.error && <p className="quick-create-error">{quickCreate.error}</p>}
      <div className="quick-create-actions">
        <button className="outline-button" onClick={backToQuickServiceChoice} type="button">
          <ArrowLeft size={15} />{t("Back")}</button>
        <button
          className="primary-button"
          onClick={submit}
          disabled={!quickClientSearch.trim() || Boolean(quickCreate.error)}
          type="button"
        >
          <Check size={15} />{t("Create")}</button>
      </div>
    </div>
  );
}
