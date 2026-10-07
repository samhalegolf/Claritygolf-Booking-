// The rewards programme, as the coach screens see it. The server owns every
// number here -- what has been earned is recounted from activity on each read
// (_shared/rewards.mts), and this module only carries it.

import { t, tn } from "../../lib/i18n";

export type RewardTrigger = "lessons_completed" | "amount_spent";

export type RewardProgram = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  trigger: RewardTrigger;
  /** Lessons, or minor units of money spent. */
  threshold: number;
  countsServiceIds: string[];
  countsAllServices: boolean;
  countsFrom: string;
  rewardCredits: number;
  rewardCoversServiceIds: string[];
  rewardCoversAllServices: boolean;
  rewardExpiryMonths: number | null;
  maxRewardsPerPerson: number | null;
  peopleRewarded?: number;
  rewardsGranted?: number;
  creditsGranted?: number;
};

export type RewardRun = { programs: number; people: number; rewards: number; credits: number };

export type PersonRewardProgress = {
  programId: string;
  name: string;
  trigger: RewardTrigger;
  threshold: number;
  progress: number;
  earned: number;
  intoCurrent: number;
  remaining: number;
  capped: boolean;
  rewardCredits: number;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || t("Something went wrong."));
  return data as T;
}

const post = <T,>(url: string, body: unknown) => request<T>(url, { method: "POST", body: JSON.stringify(body) });

export const rewardsApi = {
  load: () => request<{ programs: RewardProgram[] }>("/api/rewards"),
  progress: (personId: string) =>
    request<{ progress: PersonRewardProgress[] }>(`/api/rewards?personId=${encodeURIComponent(personId)}`),
  save: (program: Partial<RewardProgram>) =>
    post<{ programs: RewardProgram[]; ran: RewardRun }>("/api/rewards/programs", { program }),
  archive: (id: string) =>
    request<{ programs: RewardProgram[] }>(`/api/rewards/programs?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  run: () => post<{ programs: RewardProgram[]; ran: RewardRun }>("/api/rewards/run", {}),
};

/** "Every 10 lessons" / "Every $500 spent", in the reader's language. */
export function triggerLabel(
  program: Pick<RewardProgram, "trigger" | "threshold">,
  formatMoney: (amount: number) => string,
) {
  return program.trigger === "amount_spent"
    ? t("Every {amount} spent", { amount: formatMoney(program.threshold / 100) })
    : tn(program.threshold, "Every completed lesson", "Every {count} completed lessons");
}

/** What one reward is: "1 credit" on whatever it covers. */
export function rewardLabel(program: Pick<RewardProgram, "rewardCredits">) {
  return tn(program.rewardCredits, "earns 1 credit", "earns {count} credits");
}

/** What a reward toast says after a run. */
export function runLabel(ran: RewardRun) {
  return ran.rewards
    ? tn(ran.rewards, "1 reward paid out.", "{count} rewards paid out.")
    : t("Everyone is up to date. Nothing new to pay out.");
}
