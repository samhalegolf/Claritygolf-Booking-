// Billing › Settings › Online shop: what the public shop is selling.
//
// There is no switch here. Each pass, bundle, gift voucher and product is
// ticked "Show on your website store" where it is edited, and the shop is open
// whenever something is ticked and card payments work. This shows what a
// customer would see, and when the shop still cannot sell, why.

import { useEffect, useState } from "react";
import { apiFetch } from "../auth/apiFetch";
import { getBookingScreenPublicUrl } from "../public-booking/bookingScreens";
import { formatMoney } from "../../lib/money";
import { t, tn } from "../../lib/i18n";

type ShopStatus = {
  open: boolean;
  blocker: "" | "card_payments" | "nothing_for_sale";
  items: Array<{ id: string; kind: "package" | "voucher" | "product"; name: string; price: number; currency: string }>;
};

export function OnlineShopSetup({ business }: { business: string }) {
  const [status, setStatus] = useState<ShopStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/billing/online-shop")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then((data: ShopStatus) => { if (!cancelled) setStatus(data); })
      .catch(() => { if (!cancelled) setError(t("Could not load the shop settings.")); });
    return () => { cancelled = true; };
  }, []);

  const shopUrl = business ? getBookingScreenPublicUrl(`/${business}/shop`, true) : "";
  const count = (kind: ShopStatus["items"][number]["kind"]) => status?.items.filter((item) => item.kind === kind).length || 0;

  return (
    <>
      <p className="field-help">
        {t("Let anyone buy your passes, gift vouchers and products online and pay by card. Choose what shows by ticking \"Show on your website store\" on each one: passes and bundles under Billing › Passes, vouchers and products under Billing › Products. Every order is a sale in your takings, like one at the till.")}
      </p>
      {status ? (
        <p className="field-help">
          {tn(count("package"), "{count} pass", "{count} passes")} · {tn(count("voucher"), "{count} gift voucher", "{count} gift vouchers")} · {tn(count("product"), "{count} product", "{count} products")}
          {status.items.length ? ` (${status.items.map((item) => `${item.name} ${formatMoney(item.price, item.currency)}`).join(", ")})` : ""}
        </p>
      ) : null}
      {status?.blocker === "card_payments" ? (
        <p className="field-help">{t("The shop stays closed until Clarity Pay is set up, because customers pay by card.")}</p>
      ) : null}
      {status?.blocker === "nothing_for_sale" ? (
        <p className="field-help">{t("The shop is closed: nothing is ticked to show on your website store yet.")}</p>
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
