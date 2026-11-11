// Loop rules for tool calls, the same on every model: the same call made again quickly is a loop (a nudge on the
// 3rd, a stop on the 6th); made again after a pause it is polling (CI, a deploy, a job's log), which gets a fresh
// result and only a much higher limit.
export const LOOP_NUDGE = 3;
const LOOP_STOP = 6;
// Waiting on something (CI, a deploy, a job's log) is the same call made again after a pause. Calls this far apart
// are polling, not a loop: they get a fresh result and count only toward a much higher limit.
export const POLL_GAP_MS = 30_000;
export const POLL_STOP = 120;
export type Repeat = { rapid: number; total: number; at: number };
export const identical = new Map<string, Repeat>();
// A quick repeat of a read in the same run gets the earlier result back without calling the service again.
export const readCache = new Map<string, { text: string; at: number }>();

// How a repeat of the same call counts: rapid repeats are a loop, spaced ones are polling.
export function countRepeat(prev: Repeat | undefined, now: number): Repeat {
  if (!prev) return { rapid: 1, total: 1, at: now };
  return { rapid: now - prev.at < POLL_GAP_MS ? prev.rapid + 1 : 1, total: prev.total + 1, at: now };
}
export const isLoop = (r: Repeat) => r.rapid >= LOOP_STOP || r.total >= POLL_STOP;
// Finished runs leave nothing behind.
export function forgetOld(now: number): void {
  if (identical.size < 2000) return;
  for (const [k, v] of identical) if (now - v.at > 3_600_000) identical.delete(k);
  for (const [k, v] of readCache) if (now - v.at > 3_600_000) readCache.delete(k);
}
