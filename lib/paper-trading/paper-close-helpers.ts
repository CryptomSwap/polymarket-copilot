/**
 * Pure helpers for paper 12h close (tests + engine).
 */

export const PAPER_CLOSE_HORIZON_MS = 12 * 60 * 60 * 1000;

/** `true` when the trade has reached the close horizon (12h after entry by default). */
export function isPaperTradeDueForClose(entryTime: Date, now: Date, horizonMs: number): boolean {
  return entryTime.getTime() + horizonMs <= now.getTime();
}

/** Prisma filter value: open trades due as of `now`. */
export function paperCloseDueBefore(now: Date, horizonMs: number): Date {
  return new Date(now.getTime() - horizonMs);
}

export function mergePaperCloseMetadata(
  metadataJson: string | null | undefined,
  patch: Record<string, unknown>
): string {
  let base: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      base = JSON.parse(metadataJson) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const prevClose =
    base.paperClose && typeof base.paperClose === "object" && !Array.isArray(base.paperClose)
      ? (base.paperClose as Record<string, unknown>)
      : {};
  return JSON.stringify({
    ...base,
    paperClose: { ...prevClose, ...patch },
  });
}
