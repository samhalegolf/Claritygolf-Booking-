// The headline balance on a client: what they could spend today, summed across
// their live passes. Read off the server's per-pass numbers (pass_balances),
// never recomputed from the ledger here.
//
// Its own module so the profile header can show it without pulling in the
// lazily loaded Passes panel.

type BalancePass = { status: string; creditsAvailable: number; nextExpiry: string | null };

export function passBalanceSummary(passes: BalancePass[]) {
  const live = passes.filter((pass) => pass.status === "active");
  const nextExpiry =
    live
      .map((pass) => pass.nextExpiry)
      .filter((value): value is string => Boolean(value))
      .sort()[0] || null;
  return {
    credits: live.reduce((sum, pass) => sum + Math.max(0, Number(pass.creditsAvailable) || 0), 0),
    livePasses: live.length,
    nextExpiry,
  };
}
