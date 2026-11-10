"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Critter } from "@/components/peeblo/critter";
import { Slip, SlipRow, SlipRule } from "@/components/peeblo/sig-slip";
import { money, totalCost, useVisitJobs, type VisitJob } from "@/components/peeblo/signature";
import { siGithub } from "simple-icons";
import { site } from "@/content/site";
import s from "./shared.module.css";
import c from "./Cta.module.css";

// "Your first AI employees, this afternoon.": the dark band card with a checklist.
const points = [
  "Open source under Apache-2.0. Read every line",
  "Self-hosted on your own servers with Docker. Your data stays on premise",
  "Open-weight models through Otari, with a price before costly jobs",
  "Teammates never hold an API key, and every person has an AI budget",
];

// Shown until the visitor has watched a teammate finish something on the page.
const sample: VisitJob[] = [
  { id: "s1", agent: "sprout", what: "which Q4 renewals are at risk?", cost: 0.0061 },
  { id: "s2", agent: "ledger", what: "reconcile October expenses", cost: 0.0061 },
  { id: "s3", agent: "scout", what: "how many customers asked for SSO?", cost: 0.0063 },
];
const MAX = 6;

// The visitor's own receipt: every job they watched finish on this page, printed when the card
// comes into view, held up by Peeblo peeking over the top.
function VisitReceipt() {
  const jobs = useVisitJobs();
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const isSample = jobs.length === 0;
  const list = isSample ? sample : jobs;
  const rows = list.slice(-MAX);
  const more = list.length - rows.length;
  return (
    <div ref={ref} className={c.slipAt} aria-label={isSample ? "Sample receipt" : `Your receipt: ${list.length} jobs, ${money(totalCost(list))}`}>
      <span className={c.peek} aria-hidden="true">
        <Critter id="peeblo" size={68} mood={isSample ? "idle" : "happy"} reach={240} />
      </span>
      <Slip key={seen ? "on" : "off"} className={`${c.slip} ${seen ? "" : c.unseen}`}>
        <SlipRow left={<b>peeblo · {isSample ? "sample" : "your visit"}</b>} right="today" />
        <SlipRow dim left="acme · on your servers" />
        <SlipRule />
        {more > 0 && <SlipRow dim left={`+ ${more} earlier`} />}
        {rows.map((j) => (
          <SlipRow key={j.id} dim={isSample} left={`@${j.agent} ${j.what}`} right={money(j.cost)} />
        ))}
        <SlipRule />
        <SlipRow strong left={`${list.length} ${list.length === 1 ? "JOB" : "JOBS"}`} right={money(totalCost(list))} />
        <SlipRow dim left="0 keys shared · self-hosted" />
        <span className={c.barcode} aria-hidden="true" />
      </Slip>
    </div>
  );
}

export function Cta() {
  return (
    <section className={s.story} id="start" aria-labelledby="start-h">
      <div className={s.shell}>
        <div className={c.start}>
          <div>
            <h2 id="start-h">Your first AI employees, this afternoon.</h2>
            <div className={c.actions}>
              <a className={`${s.btn} ${s.btnLight}`} href={site.repoUrl} target="_blank" rel="noreferrer">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                  <path d={siGithub.path} />
                </svg>
                GitHub
              </a>
              <a className={c.link} href={site.slackUrl} target="_blank" rel="noreferrer">
                Try Demo
              </a>
            </div>
          </div>
          <ul className={c.points} role="list">
            {points.map((p) => (
              <li key={p}>
                <Check strokeWidth={2.2} aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
          <VisitReceipt />
        </div>
      </div>
    </section>
  );
}
