// The market the shell on screen is presenting, for code that sits outside it.
//
// The coach workspace and the client portal each resolve their business's
// market (market-profile.mts) and publish it here. The one reader today is the
// sandbox leak detector, which is mounted above both shells by boot.tsx and so
// cannot read either one's state -- and should not make a request of its own to
// learn what the shell already knows.

import type { ResolvedMarket } from "../../netlify/functions/_shared/market-profile.mts";

type Listener = (market: ResolvedMarket) => void;

let current: ResolvedMarket | null = null;
const listeners = new Set<Listener>();

export function publishActiveMarket(market: ResolvedMarket): void {
  current = market;
  for (const listener of listeners) listener(market);
}

export function getActiveMarket(): ResolvedMarket | null {
  return current;
}

export function subscribeActiveMarket(listener: Listener): () => void {
  listeners.add(listener);
  if (current) listener(current);
  return () => {
    listeners.delete(listener);
  };
}
