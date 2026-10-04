import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { ClarityMore, type IconComponent } from "../shared/ClarityIcons";

export type PhoneDestination = {
  key: string;
  label: string;
  Icon: IconComponent;
  active: boolean;
  onSelect: () => void;
};

/**
 * The phone layout's navigation: four tabs along the bottom, and More for
 * everything the sidebar holds that is not one of them.
 */
export function PhoneTabBar({ tabs, more }: { tabs: PhoneDestination[]; more: PhoneDestination[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = more.some((destination) => destination.active);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  return (
    <>
      {moreOpen && (
        <div className="phone-more-overlay" role="presentation" onClick={() => setMoreOpen(false)}>
          <nav className="phone-more-sheet" aria-label={t("More")} onClick={(event) => event.stopPropagation()}>
            {more.map(({ key, label, Icon, active, onSelect }) => (
              <button
                key={key}
                type="button"
                className={active ? "active" : ""}
                onClick={() => {
                  setMoreOpen(false);
                  onSelect();
                }}
              >
                <Icon size={20} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      )}
      <nav className="phone-tab-bar" aria-label={t("Workspace")}>
        {tabs.map(({ key, label, Icon, active, onSelect }) => (
          <button
            key={key}
            type="button"
            className={active && !moreOpen ? "active" : ""}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              setMoreOpen(false);
              onSelect();
            }}
          >
            <Icon size={22} />
            <span>{label}</span>
          </button>
        ))}
        <button
          type="button"
          className={moreOpen || moreActive ? "active" : ""}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <ClarityMore size={22} />
          <span>{t("More")}</span>
        </button>
      </nav>
    </>
  );
}
