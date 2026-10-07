type TimingEntry = { name: string; duration: number };

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Small, dependency-free Server-Timing collector for latency-sensitive
 * functions. Metric names are fixed by the caller; values never include user
 * data and are safe to expose in the response header.
 */
export function createServerTiming() {
  const startedAt = now();
  const entries: TimingEntry[] = [];

  return {
    async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const phaseStartedAt = now();
      try {
        return await operation();
      } finally {
        entries.push({ name, duration: now() - phaseStartedAt });
      }
    },

    header() {
      const allEntries = [...entries, { name: "total", duration: now() - startedAt }];
      return allEntries
        .map(({ name, duration }) => `${name};dur=${Math.max(0, duration).toFixed(1)}`)
        .join(", ");
    },
  };
}
