// Billing > Reports sub-view. Purely presentational: it receives the display
// counts it shows and renders them - it does not know about Service/catalog
// domain types or reach into workspace state. First component slice of the
// billing workspace extraction out of App.tsx; markup unchanged.

export type BillingReportsPanelProps = {
  lessonTypeCount: number;
  packageTypeCount: number;
  productCount: number;
  completedUninvoicedCount: number;
};

export function BillingReportsPanel({
  lessonTypeCount,
  packageTypeCount,
  productCount,
  completedUninvoicedCount,
}: BillingReportsPanelProps) {
  return (
    <div className="billing-reports">
      <article className="data-card">
        <span>Revenue</span>
        <h2>By item source</h2>
        <div className="settings-summary-grid">
          <span>
            <strong>{lessonTypeCount}</strong>
            lesson types
          </span>
          <span>
            <strong>{packageTypeCount}</strong>
            package types
          </span>
          <span>
            <strong>{productCount}</strong>
            products/services
          </span>
        </div>
      </article>
      <article className="data-card">
        <span>Reconciliation</span>
        <h2>Package dots coming next</h2>
        <p>
          Reports will read completed bookings, invoice-linked coverage, and manual coverage to classify green,
          blue, orange, grey, and red package slots.
        </p>
      </article>
      <article className="data-card">
        <span>Uninvoiced</span>
        <h2>{completedUninvoicedCount} completed lessons</h2>
        <p>These are ready to pull into a manual invoice without making calendar pull the only workflow.</p>
      </article>
    </div>
  );
}
