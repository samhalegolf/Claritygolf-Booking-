// Billing › Settings › Online shop: the one switch that opens the public shop.
//
// The shop sells what the business already sells -- its passes (packages)
// and the gift vouchers under Billing -- so there is nothing to set up
// here but on or off. What it does show is what a customer would see, and when
// the switch is on but the shop still cannot sell, why.

import { useEffect, useState } from "react";
import { apiFetch } from "../auth/apiFetch";
import { getBookingScreenPublicUrl } from "../public-booking/bookingScreens";
import { formatMoney } from "../../lib/money";
import { t, tn } from "../../lib/i18n";

type ShopStatus = {
  enabled: boolean;
  open: boolean;
  blocker: "" | "card_payments" | "nothing_for_sale";
  items: Array<{ id: string; kind: "package" | "voucher"; name: string; price: number; currency: string }>;
};

export function OnlineShopSetup({ business }: { business: string }) {
  const [status, setStatus] = useState<ShopStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/billing/online-shop")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then((data: ShopStatus) => { if (!cancelled) setStatus(data); })
      .catch(() => { if (!cancelled) setError(t("Could not load the shop settings.")); });
    return () => { cancelled = true; };
  }, []);

  async function setEnabled(enabled: boolean) {
    setSaving(true);
    setError("");
    try {
      const response = await apiFetch("/api/billing/online-shop", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error();
      setStatus((await response.json()) as ShopStatus);
    } catch {
      setError(t("Could not save the shop setting."));
    } finally {
      setSaving(false);
    }
  }

  const shopUrl = business ? getBookingScreenPublicUrl(`/${business}/shop`, true) : "";
  const packages = status?.items.filter((item) => item.kind === "package") || [];
  const vouchers = status?.items.filter((item) => item.kind === "voucher") || [];

  return (
    <>
      <p className="field-help">
        {t("Let anyone buy your passes and gift vouchers online and pay by card. A pass lands on the buyer's profile; a voucher's code is emailed to them. Every order is a sale in your takings, like one at the till.")}
      </p>
      <label className="settings-field pos-settles-toggle">
        <input
          checked={status?.enabled === true}
          disabled={!status || saving}
          onChange={(event) => void setEnabled(event.target.checked)}
          type="checkbox"
        />
        <span>{t("Sell passes and gift vouchers online")}</span>
      </label>
      {status ? (
        <p className="field-help">
          {tn(packages.length, "{count} pass", "{count} passes")} · {tn(vouchers.length, "{count} gift voucher", "{count} gift vouchers")}
          {status.items.length ? ` (${status.items.map((item) => `${item.name} ${formatMoney(item.price, item.currency)}`).join(", ")})` : ""}
        </p>
      ) : null}
      {status?.enabled && status.blocker === "card_payments" ? (
        <p className="field-help">{t("The shop stays closed until Clarity Pay is set up, because customers pay by card.")}</p>
      ) : null}
      {status?.enabled && status.blocker === "nothing_for_sale" ? (
        <p className="field-help">{t("The shop stays closed until there is something to sell: a pass with a price under Billing › Passes, or a gift voucher under Billing › Vouchers.")}</p>
      ) : null}
      {status?.open && shopUrl ? (
        <p className="field-help">
          {t("Your shop:")}{" "}
          <a href={shopUrl} rel="noreferrer" target="_blank">{shopUrl}</a>
        </p>
      ) : null}
      {error ? <p className="field-help" role="alert">{error}</p> : null}
    </>
  );
}
