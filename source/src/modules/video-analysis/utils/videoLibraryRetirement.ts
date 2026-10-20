/** A retirement is an explicit declaration, never inferred from an outage. */
export type RetiredVideoEntry = {
  savedVideoId: string;
  playerId: string;
  title: string;
  retiredAt: string;
  reason: "source-removed";
};
export function cleanRetiredVideoEntry(value: unknown, now = new Date().toISOString()): RetiredVideoEntry | null {
  const input = value as Partial<RetiredVideoEntry> | null;
  if (!input || input.reason !== "source-removed" || typeof input.savedVideoId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(input.savedVideoId) || typeof input.playerId !== "string" ||
      !input.playerId || input.playerId.length > 180) return null;
  return {
    savedVideoId: input.savedVideoId, playerId: input.playerId,
    title: typeof input.title === "string" ? input.title.slice(0,240) : "Video",
    reason: "source-removed", retiredAt: now,
  };
}
export const retiredEntrySettingKey = (id: string) => "videoLibraryRetiredEntry:" + id;
