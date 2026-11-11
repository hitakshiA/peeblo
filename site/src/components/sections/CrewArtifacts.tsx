"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { people } from "@/content/crew";
import { reducedMotion } from "@/lib/pointer";
import c from "./Crew.module.css";

// The small working artifact inside each card's window. Each one gets the card's current step
// and shows what the teammate has done so far. Layouts: job rows and status chips, mini cards,
// and a small chart (line draws, dots pop, metrics rise).

const on = (yes: boolean) => (yes ? c.on : undefined);

function Count({ to, live, kind, ms = 1100 }: { to: number; live: boolean; kind: "int" | "usd"; ms?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fmt = (n: number) => (kind === "usd" ? "$" : "") + Math.round(n).toLocaleString("en-US");
    if (!live) {
      el.textContent = fmt(0);
      return;
    }
    if (reducedMotion()) {
      el.textContent = fmt(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, to, kind, ms]);
  return <span ref={ref}>{kind === "usd" ? "$0" : "0"}</span>;
}

function Mark({ state }: { state: "wait" | "run" | "done" | "warn" }) {
  if (state === "done")
    return (
      <span className={c.mk} data-s="done">
        <Check size={10} strokeWidth={3.2} />
      </span>
    );
  return <span className={c.mk} data-s={state} />;
}

function Row({ show, state, text, time }: { show: boolean; state: "wait" | "run" | "done" | "warn"; text: React.ReactNode; time: string }) {
  return (
    <li className={`${c.row} ${on(show) ?? ""}`}>
      <Mark state={state} />
      <span className={c.rt}>{text}</span>
      <time>{time}</time>
    </li>
  );
}

// boo: an error-rate strip that spikes, then the incident steps tick in.
const spike = [3, 4, 3, 5, 4, 3, 4, 3, 5, 4, 3, 4, 5, 3, 4, 3, 4, 5, 4, 3, 14, 22, 26, 24, 25, 23];
export function BooWork({ step }: { step: number }) {
  const rows = [
    { t: <><b>47</b> checkout 500s in Sentry</>, at: "3:12" },
    { t: <>Traced to deploy <code>a41f2c</code></>, at: "3:13" },
    { t: <>Opened <b>INC-2094</b> in Linear</>, at: "3:14" },
    { t: <>Rollback staged</>, at: "3:15" },
  ];
  return (
    <div className={c.boo}>
      <div className={`${c.spike} ${on(step >= 1) ?? ""}`} aria-hidden="true">
        {spike.map((h, i) => (
          <i key={i} data-hot={h > 10 || undefined} style={{ height: h, transitionDelay: `${i * 18}ms` }} />
        ))}
        <span>5xx / min</span>
      </div>
      <ul className={c.rows}>
        {rows.map((r, i) => {
          const s = step > i + 1 ? (i === 3 ? "warn" : "done") : step === i + 1 ? "run" : "wait";
          return <Row key={i} show={step >= i + 1} state={s} text={r.t} time={r.at} />;
        })}
      </ul>
      <div className={`${c.ask} ${on(step >= 5) ?? ""}`}>
        <span className={c.btnGo}>Roll back</span>
        <span className={c.btnNo}>Not now</span>
      </div>
    </div>
  );
}

// sprout: two metric tiles count up, then the week line draws and its dots pop in.
const pts = [
  [8, 70],
  [44, 64],
  [80, 66],
  [116, 55],
  [152, 58],
  [188, 44],
  [224, 30],
  [256, 14],
];
const lastYear = "M8 74 L44 72 L80 70 L116 69 L152 66 L188 66 L224 61 L256 58";
const line = "M" + pts.map((p) => p.join(" ")).join(" L");
export function SproutWork({ step }: { step: number }) {
  return (
    <div className={c.sprout}>
      <div className={c.tiles}>
        <div className={`${c.tile} ${on(step >= 1) ?? ""}`}>
          <span>Signups</span>
          <b>
            <Count to={1284} live={step >= 1} kind="int" />
          </b>
          <em data-up>▲ 18%</em>
        </div>
        <div className={`${c.tile} ${on(step >= 1) ?? ""}`} style={{ transitionDelay: "120ms" }}>
          <span>Paid CAC</span>
          <b>
            <Count to={38} live={step >= 1} kind="usd" ms={800} />
          </b>
          <em data-up>▼ 8%</em>
        </div>
      </div>
      <svg className={`${c.chart} ${on(step >= 2) ?? ""}`} viewBox="0 0 264 84" aria-hidden="true">
        {[20, 44, 68].map((y) => (
          <line key={y} x1="0" x2="264" y1={y} y2={y} className={c.gl} />
        ))}
        <path d={`${line} L256 84 L8 84 Z`} className={c.area} />
        <path d={lastYear} pathLength={1} className={c.ly} />
        <path d={line} pathLength={1} className={c.ln} />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.6" className={c.dot} style={{ transitionDelay: `${280 + i * 175}ms` }} />
        ))}
      </svg>
      <p className={`${c.note} ${on(step >= 3) ?? ""}`}>
        Most of it came from the <b>pricing page test</b>.
      </p>
    </div>
  );
}

// snap: page screenshots tick off one by one; one breaks and gets a Linear issue.
const pages = ["Home", "Pricing", "Docs", "Blog", "Login", "Sign up", "Settings", "Billing"];
export function SnapWork({ step }: { step: number }) {
  return (
    <div className={c.snap}>
      <ul className={c.shots}>
        {pages.map((p, i) => {
          const s = step > i ? (i === 1 ? "warn" : "done") : step === i ? "run" : "wait";
          return (
            <li key={p} data-s={s}>
              <span className={c.shot} aria-hidden="true">
                <i />
                <i />
                <i />
                {i === 1 && <u />}
              </span>
              <span className={c.sl}>
                {p}
                {s === "done" && <Check size={9} strokeWidth={3.4} />}
              </span>
            </li>
          );
        })}
      </ul>
      <div className={`${c.issue} ${on(step >= 9) ?? ""}`}>
        <b>LIN-311</b>
        <span>Pricing at 390px: the button covers the plan names</span>
      </div>
    </div>
  );
}

// ledger: the matched total counts up, then the charge rows land.
export function LedgerWork({ step }: { step: number }) {
  const rows = [
    { n: "Acme", v: "$12,400", s: "Matched" },
    { n: "Brightline", v: "$8,150", s: "Matched" },
    { n: "Corveta", v: "$860", s: step >= 5 ? "Invoice drafted" : "No invoice" },
  ];
  return (
    <div className={c.ledger}>
      <div className={`${c.total} ${on(step >= 1) ?? ""}`}>
        <b>
          <Count to={48920} live={step >= 1} kind="usd" ms={1200} />
        </b>
        <span>matched this week · 214 charges</span>
      </div>
      <ul className={c.lines}>
        {rows.map((r, i) => (
          <li key={r.n} className={on(step >= i + 2)}>
            <span>{r.n}</span>
            <span className={c.amt}>{r.v}</span>
            <em data-tone={i === 2 ? (step >= 5 ? "ok" : "warn") : "ok"}>{r.s}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

// whisk: tickets arrive, get a tag and an owner; the sorted counter climbs.
export function WhiskWork({ step }: { step: number }) {
  const sorted = [0, 4, 7, 11, 14, 14][step] ?? 14;
  const tickets = [
    { id: "#5518", t: "Refund after 30 days?", tag: "Billing", who: "priya" },
    { id: "#5519", t: "SSO login loops on Safari", tag: "Bug", who: "sam" },
    { id: "#5520", t: "How do I export to CSV?", tag: "Answered", who: "" },
    { id: "#5521", t: "Wrong address on invoice", tag: "Billing", who: "priya" },
  ];
  return (
    <div className={c.whisk}>
      <p className={c.sorted}>
        <b>{sorted}</b> of 14 sorted
        <span className={c.meter}>
          <i style={{ transform: `scaleX(${sorted / 14})` }} />
        </span>
      </p>
      <ul className={c.tix}>
        {tickets.map((x, i) => (
          <li key={x.id} className={on(step >= i + 1)}>
            <span className={c.tid}>{x.id}</span>
            <span className={c.tt}>{x.t}</span>
            <em data-tone={x.tag === "Answered" ? "ok" : x.tag === "Bug" ? "warn" : "plain"}>{x.tag}</em>
            <span className={c.to}>
              {x.who ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={people[x.who].photo} alt={people[x.who].name} width={18} height={18} />
              ) : (
                <Check size={11} strokeWidth={3} />
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// recall: a page diff. The old line strikes out, the new one types in, and the source is linked.
export function RecallWork({ step }: { step: number }) {
  return (
    <div className={c.recall}>
      <p className={c.crumb}>Sales / Pricing FAQ / Annual plans</p>
      <ol className={c.diff}>
        <li>Annual plans are billed once a year.</li>
        <li data-k="del" className={on(step >= 1)}>
          Annual plans get two months free.
        </li>
        <li data-k="add" className={on(step >= 2)}>
          <span>Annual plans get 20% off, from Dec 1.</span>
        </li>
        <li>Monthly plans do not change.</li>
      </ol>
      <p className={`${c.src} ${on(step >= 3) ?? ""}`}>
        Source: <b>#sales</b> thread, Theo at 4:51 PM
      </p>
    </div>
  );
}

export const work: Record<string, (p: { step: number }) => React.ReactNode> = {
  boo: BooWork,
  sprout: SproutWork,
  snap: SnapWork,
  ledger: LedgerWork,
  whisk: WhiskWork,
  recall: RecallWork,
};
