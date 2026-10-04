import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { t, tn } from "../../lib/i18n";
import { formatTime } from "../calendar/calendarModel";
import { WeekSlots } from "../public-booking/WeekSlots";
import { servicePriceLabel } from "../services/serviceModel";
import { ClarityProfile } from "../shared/ClarityIcons";
import type { BookingFlow } from "./useBookingFlow";

/** The booking flow as the booking page preview lays it out. */
export function BookingFlowView({ bookingFlow }: { bookingFlow: BookingFlow }) {
  const {
    bookingCardScheme,
    showBookingBrandLogo,
    brandSettings,
    bookingBrandName,
    bookingBrandPrimary,
    bookingBrandSecondary,
    coachAccount,
    isAppointmentSectionOpen,
    isAppointmentStepComplete,
    setPublicBookingSection,
    visiblePublicServices,
    bookingServiceId,
    handlePublicBookingServiceSelect,
    appointmentSummaryName,
    appointmentSummaryDuration,
    appointmentSummaryDescription,
    appointmentSummaryLessonNote,
    isDateTimeSectionOpen,
    isDateTimeStepComplete,
    moveWeek,
    weekTitle,
    selectedBookingService,
    activeWeek,
    visibleBookingSlots,
    weekDays,
    isGroupBookingTimeSelection,
    bookingDaySelected,
    bookingDay,
    bookingStart,
    handlePublicBookingTimeSelect,
    dateTimeSummaryLine,
    dateTimeSummaryLocation,
    isInformationSectionOpen,
    showCapturedCustomerDetailsSummary,
    bookingForm,
    updateBookingForm,
    handleBookingMatchKeyDown,
    bookingClientSuggestion,
    showBookingClientSuggestion,
    applyBookingClient,
    customGroupAttendeePanel,
    bookingSubmitError,
    isInformationStepComplete,
    confirmPublicBooking,
    bookingCustomerSummaryName,
    bookingCustomerSummaryContact,
  } = bookingFlow;

  return (
    <div className={`public-booking booking-theme-${bookingCardScheme}`}>
  <div className={`booking-brand ${showBookingBrandLogo ? "" : "booking-brand-subtle"}`}>
    {showBookingBrandLogo && brandSettings.logoPreview ? (
      <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
    ) : showBookingBrandLogo ? (
      <>
        <strong>{bookingBrandPrimary.toUpperCase()}</strong>
        {bookingBrandSecondary && <span>{bookingBrandSecondary.toUpperCase()}</span>}
      </>
    ) : (
      <strong>{bookingBrandName}</strong>
    )}
    <em>{coachAccount.venueShortName}</em>
  </div>

  <div className="booking-columns booking-progressive-flow">
    <section className={`booking-progressive-section ${isAppointmentSectionOpen ? "is-open" : ""} ${
      isAppointmentStepComplete ? "is-complete" : ""
    }`}>
      <button
        className="booking-progressive-title"
        onClick={() => setPublicBookingSection("appointment")}
        type="button"
      >
        <span className="booking-progressive-title-label">{t("1. Appointment")}{" "}<span className="booking-required-mark" aria-hidden="true">*</span>
        </span>
        <span className="booking-progressive-title-state">{isAppointmentStepComplete ? t("Done") : t("In progress")}</span>
      </button>
      {isAppointmentSectionOpen ? (
        <div className="booking-progressive-body">
          <div className="service-picker">
            {visiblePublicServices.length ? (
              visiblePublicServices.map((service) => (
                <button
                  className={service.id === bookingServiceId ? "selected-service" : ""}
                  key={service.id}
                  onClick={() => handlePublicBookingServiceSelect(service.id)}
                  type="button"
                >
                  <strong>{service.name}</strong>
                  <em>{t("{duration} minutes @ {service}", { duration: service.duration, service: servicePriceLabel(service) })}</em>
                  {service.description && <small>{service.description}</small>}
                  {(service.lessonNote || service.location) && <small>{service.lessonNote || service.location}</small>}
                </button>
              ))
            ) : (
              <p>{t("No public lesson types are active.")}</p>
            )}
          </div>
        </div>
      ) : isAppointmentStepComplete ? (
                <button
                  className="booking-summary booking-progressive-summary"
                  onClick={() => setPublicBookingSection("appointment")}
                  type="button"
                >
                  <strong>{appointmentSummaryName}</strong>
                  <span>{appointmentSummaryDuration}</span>
                  {appointmentSummaryDescription ? <small>{appointmentSummaryDescription}</small> : null}
                  {appointmentSummaryLessonNote ? <small>{appointmentSummaryLessonNote}</small> : null}
                </button>
              ) : (
        <button
          className="booking-progressive-summary booking-progressive-summary-empty"
          onClick={() => setPublicBookingSection("appointment")}
          type="button"
        >
          <strong>{t("Appointment not selected")}</strong>
          <span>{t("Pick a lesson to continue")}</span>
        </button>
      )}
    </section>

    <section className={`booking-progressive-section ${isDateTimeSectionOpen ? "is-open" : ""} ${
      isDateTimeStepComplete ? "is-complete" : ""
    }`}>
      <button
        className="booking-progressive-title"
        onClick={() => setPublicBookingSection("datetime")}
        type="button"
        disabled={!isAppointmentStepComplete}
      >
        <span className="booking-progressive-title-label">{t("2. Date & Time")}{" "}<span className="booking-required-mark" aria-hidden="true">*</span>
        </span>
        <span className="booking-progressive-title-state">{isDateTimeStepComplete ? t("Done") : isAppointmentStepComplete ? t("In progress") : t("Locked")}</span>
      </button>
      {isDateTimeSectionOpen ? (
        <div className="booking-progressive-body">
          <div className="booking-week-controls">
            <button onClick={() => moveWeek(-1)} type="button">
              <ArrowLeft size={15} />
              <span>{t("Previous week")}</span>
            </button>
            <strong>{weekTitle}</strong>
            <button onClick={() => moveWeek(1)} type="button">
              <span>{t("Next week")}</span>
              <ArrowRight size={15} />
            </button>
          </div>
          {selectedBookingService ? (
            <WeekSlots
              week={activeWeek}
              slots={visibleBookingSlots}
              dayLabel={(day) => weekDays[day]?.isToday ? `${weekDays[day].label} · ${t("Today")}` : weekDays[day]?.label ?? ""}
              slotLabel={(slot) =>
                isGroupBookingTimeSelection
                  ? `${formatTime(slot.start)} · ${tn(slot.remainingSpots, "{count} spot left", "{count} spots left")}`
                  : formatTime(slot.start)
              }
              isSelected={(slot) => bookingDaySelected && bookingDay === slot.day && bookingStart === slot.start}
              onSelect={handlePublicBookingTimeSelect}
              emptyLabel={isGroupBookingTimeSelection ? t("No upcoming group lesson times are available yet.") : t("No public times available this week.")}
            />
          ) : (
            <p>{t("Choose an appointment type first.")}</p>
          )}
        </div>
      ) : isDateTimeStepComplete ? (
        <button
                  className="booking-summary booking-progressive-summary"
                  onClick={() => setPublicBookingSection("datetime")}
                  type="button"
                >
                  <span>{dateTimeSummaryLine}</span>
                  {dateTimeSummaryLocation ? <small>{dateTimeSummaryLocation}</small> : null}
                </button>
              ) : (
        <button
          className="booking-progressive-summary booking-progressive-summary-empty"
          onClick={() => setPublicBookingSection("datetime")}
          type="button"
          disabled={!isAppointmentStepComplete}
        >
          <strong>{isAppointmentStepComplete ? t("Date not selected") : t("Select appointment first")}</strong>
          <span>{isAppointmentStepComplete ? t("Choose day and time") : t("Complete appointment step")}</span>
        </button>
      )}
    </section>

    <section className={`booking-progressive-section ${isInformationSectionOpen ? "is-open" : ""} ${
      showCapturedCustomerDetailsSummary ? "is-complete" : ""
    }`}>
      <button
        className="booking-progressive-title"
        onClick={() => setPublicBookingSection("information")}
        type="button"
        disabled={!isDateTimeStepComplete}
      >
        <span className="booking-progressive-title-label">{t("3. Your Information")}</span>
        <span className="booking-progressive-title-state">
          {showCapturedCustomerDetailsSummary ? t("Done") : isDateTimeStepComplete ? t("In progress") : t("Locked")}
        </span>
      </button>
      {isInformationSectionOpen ? (
        <div className="booking-progressive-body">
          <div className="booking-form">
            <label className="booking-required-field w-name">
              <input
                value={bookingForm.firstName}
                aria-label={t("First name required")}
                aria-required="true"
                autoComplete="given-name"
                onChange={(event) => updateBookingForm("firstName", event.target.value)}
                onKeyDown={handleBookingMatchKeyDown}
                placeholder={t("First name")}
                required
              />
              <span className="booking-required-mark" aria-hidden="true">*</span>
            </label>
            <label className="booking-required-field w-name">
              <input
                value={bookingForm.lastName}
                aria-label={t("Last name required")}
                aria-required="true"
                autoComplete="family-name"
                onChange={(event) => updateBookingForm("lastName", event.target.value)}
                onKeyDown={handleBookingMatchKeyDown}
                placeholder={t("Last name")}
                required
              />
              <span className="booking-required-mark" aria-hidden="true">*</span>
            </label>
            <input
              className="w-name"
              value={bookingForm.phone}
              autoComplete="tel"
              inputMode="tel"
              onChange={(event) => updateBookingForm("phone", event.target.value)}
              onKeyDown={handleBookingMatchKeyDown}
              placeholder={t("Phone")}
              type="tel"
            />
            <label className="booking-required-field w-email">
              <input
                value={bookingForm.email}
                aria-label={t("Email required")}
                aria-required="true"
                autoComplete="email"
                inputMode="email"
                onChange={(event) => updateBookingForm("email", event.target.value)}
                onKeyDown={handleBookingMatchKeyDown}
                placeholder={t("Email")}
                required
                type="email"
              />
              <span className="booking-required-mark" aria-hidden="true">*</span>
            </label>
          </div>
          {bookingClientSuggestion && showBookingClientSuggestion && (
            <button
              className="client-match-prompt booking-client-match"
              onClick={() => applyBookingClient(bookingClientSuggestion)}
              type="button"
            >
              <ClarityProfile size={15} />
              <span>
                <strong>{bookingClientSuggestion.name}</strong>
                <em>{[bookingClientSuggestion.phone, bookingClientSuggestion.email].filter(Boolean).join(" · ")}</em>
              </span>
            </button>
          )}
          {customGroupAttendeePanel}
          {bookingSubmitError && (
            <div className="email-status failed" role="alert">
              <X size={17} />
              <span>{bookingSubmitError}</span>
            </div>
          )}
          <button
            className="primary-button confirm-booking"
            disabled={!selectedBookingService || bookingStart === null || !isInformationStepComplete}
            onClick={confirmPublicBooking}
            type="button"
          >
            {t("Confirm Appointment")}
          </button>
        </div>
      ) : showCapturedCustomerDetailsSummary ? (
                <button
                  className="booking-summary booking-progressive-summary"
                  onClick={() => setPublicBookingSection("information")}
                  type="button"
                  disabled={!isDateTimeStepComplete}
                >
                  <strong>{bookingCustomerSummaryName}</strong>
                  <span>{bookingCustomerSummaryContact}</span>
                </button>
              ) : (
        <button
          className="booking-progressive-summary booking-progressive-summary-empty"
          onClick={() => setPublicBookingSection("information")}
          type="button"
          disabled={!isDateTimeStepComplete}
        >
          <strong>{isDateTimeStepComplete ? t("Customer details missing") : t("Complete time step first")}</strong>
          <span>{isDateTimeStepComplete ? t("Enter your details to confirm") : t("Lock a time first")}</span>
        </button>
      )}
    </section>
  </div>

    </div>
  );
}
