"use client";

// Peeblo's signature kit, shared by every section so the identity reads as one system:
//   - the visit tally: every demo job that finishes on the page reports itself here, and the
//     closing card prints the visitor's own receipt from it (jobs, cost, "0 keys shared");
//   - <Stamp>: a rubber stamp that thumps onto a finished job;
//   - CSS in peeblo.css: .pb-torn (thermal-receipt tear edge), .pb-pebble (a slowly morphing
//     pebble outline), .pb-print (a slip that feeds out like a receipt printer).

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

export type VisitJob = { id: string; agent: string; what: string; cost: number; model?: string };

const jobs = new Map<string, VisitJob>();
const subs = new Set<() => void>();
let snapshot: VisitJob[] = [];

// Call when a demo job finishes. Same id twice counts once, so looping demos don't inflate it.
export function reportJob(job: VisitJob) {
  if (jobs.has(job.id)) return;
  jobs.set(job.id, job);
  snapshot = [...jobs.values()];
  subs.forEach((f) => f());
}

export function useVisitJobs() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => snapshot,
    () => snapshot,
  );
}

export const totalCost = (list: VisitJob[]) => list.reduce((s, j) => s + j.cost, 0);
export const money = (n: number) => `$${n.toFixed(4)}`;

// A rubber stamp. `on` thumps it in (scale down from 1.6 with a slight rotation), then it rests.
export function Stamp({ on, children, tone = "ember", className }: { on: boolean; children: React.ReactNode; tone?: "ember" | "moss" | "ink"; className?: string }) {
  if (!on) return null;
  return (
    <span className={cn("pb-stamp", `pb-stamp--${tone}`, on && "is-on", className)} aria-hidden="true">
      {children}
    </span>
  );
}
