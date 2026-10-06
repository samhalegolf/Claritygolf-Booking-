// Billing > Passes > Create or Edit Passes. A pass type is a package lesson
// type, and those are made and changed in Settings > Services so a pass can
// never disagree with what the booking screen sells. This lists them and sends
// the coach there.

import type { Service } from "../services/serviceModel";
import { t } from "../../lib/i18n";

export type PassTypesListProps = {
  services: Service[];
  formatMoney: (amount: number) => string;
  onEdit: () => void;
};

export function PassTypesList({ services, formatMoney, onEdit }: PassTypesListProps) {
  const packages = services.filter((service) => service.lessonFormat === "package");
  const coveredName = (id?: string) => services.find((service) => service.id === id)?.name || "";

  return (
    <>
      {packages.length ? (
        <table className="recent-invoices-table">
          <thead>
            <tr>
              <th>{t("Pass")}</th>
              <th>{t("Covers")}</th>
              <th>{t("Credits")}</th>
              <th>{t("Price")}</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((service) => (
              <tr key={service.id} className={service.active ? "" : "voided-row"}>
                <td>{service.name}</td>
                <td>{coveredName(service.packageCoversServiceId) || "—"}</td>
                <td>{service.packageAllowance ?? "—"}</td>
                <td>{formatMoney(service.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t("No pass types yet.")}</p>
      )}
      <div className="panel-actions">
        <button className="primary-button" onClick={onEdit} type="button">
          {packages.length ? t("Create or edit in Settings") : t("Create one in Settings")}
        </button>
      </div>
    </>
  );
}
