// Settings › Business › Coaches: the staff list, and the profile editor for the one that is open.
import { t, tn } from "../../lib/i18n";
import { SettingsGroup } from "./SettingsLayout";
import { Suspense } from "react";
import { ClarityCoachesStaff } from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import { Archive, Plus, RefreshCw, Trash2 } from "lucide-react";
import { CoachAvatar } from "../business-hub/CoachAvatar";
import { CoachProfilePanel } from "../business-hub/CoachProfilePanel";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";
import type { CoachWeekDay } from "../business-hub/CoachProfilePanel";
import type { CoachProfile } from "../workspace/workspaceModel";
import type { JSX } from "react";

export type CoachesSettingsPanelProps = {
  terms: BusinessTerminology;
  openCoach: CoachProfile | undefined;
  newCoach: CoachProfile | null;
  openCoachProfile: (coachId: string | null) => void;
  activeCoachList: CoachProfile[];
  coachRoleLabel: (coach: CoachProfile) => string;
  coachLocationOptions: { id: string; label: string; }[];
  coachWeekFor: (coachId: string) => CoachWeekDay[];
  openCoachCalendar: (coachId: string) => void;
  openCoachAvailability: (coachId: string) => void;
  googleCalendarSyncEnabled: boolean;
  googleCalendarProfileCoachId: string;
  googleCalendarCard: JSX.Element;
  startNewCoach: () => void;
  coachProfiles: CoachProfile[];
  restoreCoach: (coach: CoachProfile) => void;
  deleteCoach: (coach: CoachProfile) => void;
  archiveCoach: (coach: CoachProfile) => void;
  saveEditedCoach: (draft: CoachProfile) => Promise<boolean>;
};

export function CoachesSettingsPanel(props: CoachesSettingsPanelProps) {
  const {
    terms,
    openCoach,
    newCoach,
    openCoachProfile,
    activeCoachList,
    coachRoleLabel,
    coachLocationOptions,
    coachWeekFor,
    openCoachCalendar,
    openCoachAvailability,
    googleCalendarSyncEnabled,
    googleCalendarProfileCoachId,
    googleCalendarCard,
    startNewCoach,
    coachProfiles,
    restoreCoach,
    deleteCoach,
    archiveCoach,
    saveEditedCoach,
  } = props;
  return (
    <SettingsGroup id="coaches" icon={ClarityCoachesStaff} section="business" title={terms.staffPlural}>
      {openCoach ? (
        <Suspense fallback={<Loading what={terms.staffSingular.toLowerCase()} />}>
        <CoachProfilePanel
          coach={openCoach}
          isNew={Boolean(newCoach)}
          access="owner"
          roleLabel={coachRoleLabel(openCoach)}
          staffSingular={terms.staffSingular}
          staffPlural={terms.staffPlural}
          locations={coachLocationOptions}
          week={newCoach ? [] : coachWeekFor(openCoach.id)}
          onSave={saveEditedCoach}
          onBack={() => openCoachProfile(null)}
          onOpenCalendar={() => openCoachCalendar(openCoach.id)}
          onOpenAvailability={() => openCoachAvailability(openCoach.id)}
        >
          {googleCalendarSyncEnabled && googleCalendarProfileCoachId === openCoach.id ? googleCalendarCard : null}
        </CoachProfilePanel>
        </Suspense>
      ) : (
      <div className="data-card wide">
        <div className="data-card-header">
          <div>
              <h2>{t("{length} active", { length: activeCoachList.length })}{" "}{activeCoachList.length === 1 ? terms.staffSingular.toLowerCase() : terms.staffPlural.toLowerCase()}</h2>
          </div>
          <button className="primary-button" onClick={startNewCoach} type="button">
            <Plus size={16} />
            <span>{t("Add {staffSingular}", { staffSingular: terms.staffSingular.toLowerCase() })}</span>
          </button>
        </div>
        <p className="field-help">{t("{staffSingular} profiles are bookable operator identities. Admin users are a permission layer, not the owner of bookings.", { staffSingular: terms.staffSingular })}</p>

        <div className="service-list" aria-label={terms.staffPlural}>
          {coachProfiles.map((coach) => (
            <article className={`service-row coach-row ${coach.active && !coach.archived ? "" : "is-archived"}`} key={coach.id}>
              <button className="service-row-main" onClick={() => openCoachProfile(coach.id)} type="button">
                <CoachAvatar name={coach.displayName || coach.name} photoUrl={coach.photoUrl} size={44} />
                <span className="coach-row-text">
                  <span>{coach.active && !coach.archived ? t("Active") : t("Archived")}</span>
                  <strong>{coach.displayName || coach.name}</strong>
                  {coach.email && <em>{coach.email}</em>}
                  <em>{tn((coach.assignedLocationIds ?? []).length || 0, "Assigned to {count} location", "Assigned to {count} locations")}
                  </em>
                </span>
              </button>
              <div className="service-row-meta">
                <strong>{coach.shortName || coach.name}</strong>
                <span>{coach.phone || t("No phone")}</span>
              </div>
              <div className="service-row-actions">
                {coach.archived || !coach.active ? (
                  <>
                    <button className="outline-button service-action-button" onClick={() => restoreCoach(coach)} type="button">
                      <RefreshCw size={15} />
                      <span>{t("Restore")}</span>
                    </button>
                    <button className="outline-button service-action-button" onClick={() => deleteCoach(coach)} type="button">
                      <Trash2 size={15} />
                      <span>{t("Delete")}</span>
                    </button>
                  </>
                ) : (
                  <button className="outline-button service-action-button" onClick={() => archiveCoach(coach)} type="button">
                    <Archive size={15} />
                    <span>{t("Archive")}</span>
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      )}
    </SettingsGroup>
  );
}
