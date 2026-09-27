export type StopDecision = "caught_up" | "cap_reached" | "exhausted" | "continue";

export interface DecideStopArgs {
  edge: "top" | "recent";
  pageTimestamps: Date[];
  watermark: Date | null;
  skewMs: number;
  itemsSoFar: number;
  maxItems: number;
  hasNextCursor: boolean;
}

/**
 * Decides whether a sync should stop after processing one page. Checked in
 * this order (spec §6.2 step 5):
 *
 * 1. cap_reached takes priority — hitting the 500-item cap always truncates,
 *    even if the page also looks caught up.
 * 2. caught_up applies only to the "recent" edge when a watermark exists,
 *    and only when the *newest* timestamp on the page (not the first, since
 *    pages are not guaranteed to be ordered) is older than watermark - skew.
 * 3. exhausted when Meta has no more pages.
 * 4. otherwise continue.
 *
 * "top" has no watermark concept (it always re-syncs everything up to the
 * cap or the end), so it can only stop via cap_reached or exhausted.
 */
export function decideStop(args: DecideStopArgs): StopDecision {
  if (args.itemsSoFar >= args.maxItems) {
    return "cap_reached";
  }

  if (args.edge === "recent" && args.watermark !== null && args.pageTimestamps.length > 0) {
    const maxTs = Math.max(...args.pageTimestamps.map((d) => d.getTime()));
    const cutoff = args.watermark.getTime() - args.skewMs;
    if (maxTs < cutoff) {
      return "caught_up";
    }
  }

  if (!args.hasNextCursor) {
    return "exhausted";
  }

  return "continue";
}
