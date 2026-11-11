"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Critter } from "@/components/peeblo/critter";
import { agentByName } from "@/content/crew";
import { models } from "@/content/models";
import { site } from "@/content/site";
import c from "./OtariSection.module.css";
import { Receipt } from "@/components/peeblo/receipt";
import { money } from "@/components/peeblo/signature";
import { avatarById } from "@/avatars";
import { useReducedMotion } from "@/components/sections/motion";

// Otari router: a model row whose lit path draws down to the one doing the job, cycling tasks.
// Peeblo's version sends every path through an Otari node, then down to the teammate. Chips are HTML; the wires are drawn
// in the stage's own pixel space from measured chip edges, so every line starts and ends on a chip.

const TEAM = ["sprout", "patch", "warden", "echo", "ledger", "scout", "recall", "tend"];
const modelOf = (who: string) => models.findIndex((m) => m.id.includes(agentByName(who).model));

// `fail` is a model whose provider answers 503 first, so Otari re-routes the job to `use`.
type Task = { task: string; who: string; why: string; cost: number; via: string; fail?: string; use?: string };
const tasks: Task[] = [
  { task: "summarize 300 messages in #growth", who: "sprout", why: "a small, fast model is enough", cost: 0.0003, via: "deepinfra" },
  { task: "fix a flaky checkout test", who: "patch", why: "a strong coder, for code", cost: 0.0009, via: "together" },
  { task: "double-check the fix", who: "warden", why: "a different model reviews the work", cost: 0.0006, via: "deepinfra" },
  { task: "answer ticket #5518 with four tools", who: "echo", why: "built for jobs with many tools", cost: 0.0005, via: "fireworks" },
  { task: "match 216 charges to invoices", who: "ledger", why: "DeepSeek's provider sent a 503, Otari fell back", cost: 0.0004, via: "together", fail: "deepseek-v4.1-flash", use: "qwen3.8-27b" },
  { task: "research the new EU rules", who: "scout", why: "built for long reads", cost: 0.0007, via: "fireworks" },
  { task: "rewrite the pricing page in the wiki", who: "recall", why: "a bigger model, for the hard ones", cost: 0.0006, via: "deepinfra" },
  { task: "draft week-one checklists for 2 new hires", who: "tend", why: "a quick, cheap job", cost: 0.0002, via: "together" },
];
const modelIdx = (short: string) => models.findIndex((m) => m.id.endsWith(short));

// One clock per task: the failed attempt (if any) plays first, then the route itself.
const FAIL_MS = 1100;
const ROUTE_MS = 1500;
const durOf = (t: Task) => (t.fail ? 4300 : 2800);

// The rider: a tiny pebble with two eyes, in the colour of the teammate it is heading to.
const PEBBLE = "M-6.6 1.2C-6.9-3.6-3.4-6.2 0.6-6.1C4.6-6 7.2-3.1 6.8 0.9C6.4 4.6 3.4 6.4-0.4 6.2C-4.2 6-6.4 4.6-6.6 1.2Z";

type Pt = { x: number; y: number };
type Geo = { w: number; h: number; models: Pt[]; team: Pt[]; hubTop: Pt; hubBottom: Pt; hubW: number };

const wire = (a: Pt, b: Pt) => {
  const k = (b.y - a.y) * 0.62;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${a.x.toFixed(1)} ${(a.y + k).toFixed(1)}, ${b.x.toFixed(1)} ${(b.y - k).toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
};

const features: { title: string; body: React.ReactNode }[] = [
  { title: "Routing and fallback", body: "Each call goes to the cheapest healthy provider. If one fails, Otari quietly tries the next." },
  { title: "Two models, two roles", body: "One teammate works, another checks it on a different model. @warden reviews @patch's fixes." },
  { title: "Budgets and spend limits", body: "Set a monthly cap for the team. Otari checks it before every call and stops new spend at the limit." },
  { title: "Per-person budgets", body: "Everyone gets their own AI budget. Peeblo tags each call with who asked, and Otari holds the line." },
  { title: "Guardrails", body: "Prompts are checked before any provider sees them. The ones that get flagged never leave." },
  { title: "MCP tools", body: "Connect an MCP server once and allow only the tools you want. Otari runs them for you." },
  { title: "Web search and fetch", body: "Teammates search and read the web with Otari's built-in tools, and only on the sites you allow." },
  { title: "Code execution", body: "When a job needs to run code, Otari runs it in a sandbox, well away from your servers." },
  {
    title: "Receipts you can trust",
    body: (
      <>
        Model, provider, attempts and cost come straight from Otari, not from the teammate&apos;s word:
        <span className={`${c.rcpt} pb-torn`}>
          <Receipt text="receipt · deepseek-v4.1-flash · via deepinfra · 1 call · no fallback · $0.0031" />
        </span>
      </>
    ),
  },
];

export function OtariSection() {
  // n counts every route played (it replays the animation); base walks the task list; a click
  // can play a custom route (a model picked by hand), and `held` lets a clicked route linger.
  const [s, setS] = useState({ n: 0, base: 0, custom: null as Task | null, held: false });
  const n = s.n;
  const [geo, setGeo] = useState<Geo | null>(null);
  const t = s.custom ?? tasks[s.base % tasks.length];
  const pick = t.use ? modelIdx(t.use) : modelOf(t.who);
  const failAt = t.fail ? modelIdx(t.fail) : -1;
  const dest = TEAM.indexOf(t.who);
  const stage = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  const modelEls = useRef<(HTMLLIElement | null)[]>([]);
  const teamEls = useRef<(HTMLLIElement | null)[]>([]);
  const inRefs = useRef<(SVGPathElement | null)[]>([]);
  const outRefs = useRef<(SVGPathElement | null)[]>([]);
  const dot = useRef<SVGGElement>(null);
  // What Otari has spent and seen since the section came into view.
  const [tally, setTally] = useState({ cost: 0, provs: [] as string[], falls: 0, runs: 0, last: 0 });
  // Reduced motion: no routes play, so the meter shows a whole loop's worth at once.
  const rm = useReducedMotion();
  const meter = rm ? { cost: tasks.reduce((x, k) => x + k.cost, 0), provs: [...new Set(tasks.map((k) => k.via))], falls: tasks.filter((k) => k.fail).length, runs: 0, last: 0 } : tally;
  const shown = useCountTo(meter.cost);

  // Measure chip edges relative to the stage: model bottoms, the Otari node's top and bottom, teammate tops.
  const measure = useCallback(() => {
    const st = stage.current?.getBoundingClientRect();
    const hb = hub.current?.getBoundingClientRect();
    if (!st || !hb) return;
    const bottom = (el: HTMLElement | null): Pt => {
      const r = el!.getBoundingClientRect();
      return { x: r.left + r.width / 2 - st.left, y: r.bottom - st.top };
    };
    const top = (el: HTMLElement | null): Pt => {
      const r = el!.getBoundingClientRect();
      return { x: r.left + r.width / 2 - st.left, y: r.top - st.top };
    };
    setGeo({
      w: st.width,
      h: st.height,
      models: modelEls.current.map(bottom),
      team: teamEls.current.map(top),
      hubTop: { x: hb.left + hb.width / 2 - st.left, y: hb.top - st.top },
      hubBottom: { x: hb.left + hb.width / 2 - st.left, y: hb.bottom - st.top },
      hubW: hb.width,
    });
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (stage.current) ro.observe(stage.current);
    document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [measure]);

  // Cycle tasks while on screen: 2.8s each, longer when a fallback has to play.
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => setLive(e.isIntersecting));
    if (stage.current) io.observe(stage.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!live) return;
    const id = window.setTimeout(
      () => setS((x) => ({ n: x.n + 1, base: x.base + 1, custom: null, held: false })),
      durOf(t) + (s.held ? 2600 : 0),
    );
    return () => window.clearTimeout(id);
  }, [live, n, t, s.held]);

  // Click a teammate: play its own job. Click a model: send a teammate's job to that model.
  const playTeammate = (name: string) => {
    const idx = tasks.findIndex((k) => k.who === name);
    if (idx >= 0) setS((x) => ({ n: x.n + 1, base: idx, custom: null, held: true }));
  };
  const playModel = (i: number) => {
    const m = models[i];
    const who = TEAM.find((name) => modelOf(name) === i) ?? t.who;
    const job = tasks.find((k) => k.who === who) ?? t;
    setS((x) => ({
      n: x.n + 1,
      base: x.base,
      custom: { task: job.task, who, why: `good for ${m.good}`, cost: job.cost, via: job.via, use: m.id.split("/")[1] },
      held: true,
    }));
  };

  // A route that reaches its teammate adds its cost to the hub's meter.
  const settle = useCallback((task: Task) => {
    setTally((v) => ({
      cost: v.cost + task.cost,
      provs: v.provs.includes(task.via) ? v.provs : [...v.provs, task.via],
      falls: v.falls + (task.fail ? 1 : 0),
      runs: v.runs + 1,
      last: task.cost,
    }));
  }, []);

  // A pebble rides the lit path: model to Otari, then Otari to the teammate. When the task has a
  // failed attempt, the pebble first climbs from Otari to that model, the model answers 503, its
  // line goes ember and fades, and only then does the real route play. One clock drives it all.
  useEffect(() => {
    const a = inRefs.current[pick];
    const b = outRefs.current[dest];
    const f = failAt >= 0 ? inRefs.current[failAt] : null;
    const d = dot.current;
    if (!geo || !a || !b || !d) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      a.style.strokeDashoffset = "0";
      b.style.strokeDashoffset = "0";
      return;
    }
    const task = t;
    const la = a.getTotalLength();
    const lb = b.getTotalLength();
    const lf = f?.getTotalLength() ?? 0;
    const lead = f ? FAIL_MS : 0;
    const start = performance.now();
    let raf = 0;
    let done = false;
    const reset = () => {
      if (!f) return;
      f.style.stroke = "";
      f.style.strokeWidth = "";
      f.style.strokeDasharray = "";
      f.style.strokeDashoffset = "";
    };
    const place = (pt: DOMPoint, now: number, sq = 0) => {
      const wob = Math.sin(now / 70) * 14;
      d.setAttribute("transform", `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)}) rotate(${wob.toFixed(1)}) scale(${(1 + sq).toFixed(3)} ${(1 - sq).toFixed(3)})`);
    };
    const step = (now: number) => {
      const el = now - start;
      if (f) {
        if (el < 560) {
          // Climb from the Otari node up to the model that is about to fail.
          const k = 1 - (1 - el / 560) ** 2;
          f.style.transition = "none";
          f.style.stroke = "var(--otari)";
          f.style.strokeWidth = "1.8px";
          f.style.strokeDasharray = `${k.toFixed(4)} 2`;
          f.style.strokeDashoffset = String(-(1 - k));
          place(f.getPointAtLength(lf * (1 - k)), now);
          d.style.opacity = "1";
        } else if (el < lead) {
          // 503: the pebble shakes at the chip, then pops; the dead line turns ember and fades.
          const k = (el - 560) / (lead - 560);
          f.style.stroke = "var(--ember)";
          f.style.strokeDasharray = "0.02 0.018";
          f.style.strokeDashoffset = "0";
          f.style.opacity = String(1 - Math.max(0, (k - 0.3) / 0.7));
          const top = f.getPointAtLength(0);
          place(new DOMPoint(top.x + Math.sin(el / 22) * 2.4 * (1 - k), top.y + 4), now, k > 0.55 ? 0 : 0.18 * Math.sin(k * 20));
          d.style.opacity = k < 0.55 ? "1" : "0";
        } else f.style.opacity = "0";
      }
      if (el >= lead) {
        const k = Math.min(1, (el - lead) / ROUTE_MS);
        const at = (1 - (1 - k) ** 2) * (la + lb);
        const p = at <= la ? a.getPointAtLength(at) : b.getPointAtLength(at - la);
        // The lit line is drawn exactly up to the pebble, so the two never drift apart.
        a.style.strokeDashoffset = String(1 - Math.min(1, at / la));
        b.style.strokeDashoffset = String(1 - Math.max(0, Math.min(1, (at - la) / lb)));
        place(p, now);
        d.style.opacity = k < 1 ? "1" : "0";
        if (k >= 1 && !done) {
          done = true;
          reset();
          settle(task);
        }
      } else {
        a.style.strokeDashoffset = "1";
        b.style.strokeDashoffset = "1";
      }
      if (!done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      reset();
      if (f) {
        f.style.opacity = "";
        f.style.transition = "";
      }
    };
  }, [pick, dest, failAt, n, geo, t, settle]);

  const color = avatarById(agentByName(t.who).avatar)?.color ?? "#b6dfc5";

  const who = agentByName(t.who);

  return (
    <section className={c.section} id="otari" aria-labelledby="otari-h">
      <div className={c.wrap}>
        <div className={c.split}>
          <div>
            <a className={c.logo} href={site.otariUrl} target="_blank" rel="noreferrer" aria-label="Otari, by Mozilla.ai">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brands/otari/otari-logo.svg" alt="Otari" width={133} height={45} />
            </a>
            <h2 id="otari-h">
              The right open model for every job. <span>Routed, budgeted and logged by Otari.</span>
            </h2>
            <a className={c.more} href={site.otariUrl} target="_blank" rel="noreferrer">
              Read more on otari.ai
            </a>
          </div>
          <div className={c.router}>
            <div className={c.stage} ref={stage}>
              {geo && (
                <svg className={c.svg} width={geo.w} height={geo.h} viewBox={`0 0 ${geo.w} ${geo.h}`} aria-hidden="true">
                  {geo.models.map((p, i) => (
                    <path
                      key={`${models[i].id}-${n}`}
                      ref={(el) => {
                        inRefs.current[i] = el;
                      }}
                      d={wire(p, geo.hubTop)}
                      pathLength={1}
                      className={`${c.route} ${i === pick ? c.on : ""}`}
                    />
                  ))}
                  {geo.team.map((p, j) => (
                    <path
                      key={`${TEAM[j]}-${n}`}
                      ref={(el) => {
                        outRefs.current[j] = el;
                      }}
                      d={wire(geo.hubBottom, p)}
                      pathLength={1}
                      className={`${c.route} ${c.out} ${j === dest ? c.on : ""}`}
                    />
                  ))}
                  <g ref={dot} className={c.pulse} transform={`translate(${geo.hubTop.x} ${geo.hubTop.y})`}>
                    <path d={PEBBLE} fill={color} className={c.pebble} />
                    <circle cx="-1.6" cy="-0.6" r="1.05" className={c.eye} />
                    <circle cx="2.4" cy="-0.6" r="1.05" className={c.eye} />
                  </g>
                </svg>
              )}
              <ul className={c.models} role="list">
                {models.map((m, i) => (
                  <li
                    key={m.id}
                    ref={(el) => {
                      modelEls.current[i] = el;
                    }}
                    className={`${c.model} ${c.tap} ${i === pick ? c.mOn : ""} ${i === failAt ? c.mFail : ""}`}
                    title={`${m.name} · ${m.maker}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Route a job to ${m.name}`}
                    onClick={() => playModel(i)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), playModel(i))}
                  >
                    {i === failAt && (
                      <span key={n} className={c.code} aria-hidden="true">
                        503
                      </span>
                    )}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.logo} alt="" width={22} height={22} />
                    <span className={c.label}>{m.name}</span>
                  </li>
                ))}
              </ul>
              <div className={c.hub} ref={hub}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brands/otari/otari-mark.svg" alt="" width={30} height={28} />
                <span>Otari</span>
              </div>
              <ul className={c.team} role="list">
                {TEAM.map((name, j) => (
                  <li
                    key={name}
                    ref={(el) => {
                      teamEls.current[j] = el;
                    }}
                    className={`${c.mate} ${c.tap} ${j === dest ? c.aOn : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Play @${name}'s job`}
                    onClick={() => playTeammate(name)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), playTeammate(name))}
                  >
                    <Critter id={agentByName(name).avatar} size={34} mood={j === dest ? "happy" : "idle"} bob={false} reach={100} />
                    <span className={c.label}>@{name}</span>
                  </li>
                ))}
              </ul>
            </div>
            {geo && (
              <p className={c.meter} style={{ ["--mx" as string]: `${(geo.hubBottom.x + geo.hubW / 2 + 14).toFixed(0)}px`, ["--my" as string]: `${((geo.hubTop.y + geo.hubBottom.y) / 2).toFixed(0)}px` }}>
                <b>
                  {money(shown)} <span>today</span>
                </b>
                <span>
                  {meter.provs.length} provider{meter.provs.length === 1 ? "" : "s"} · {meter.falls} fallback{meter.falls === 1 ? "" : "s"}
                </span>
                {meter.runs > 0 && (
                  <i key={meter.runs} className={c.plus} aria-hidden="true">
                    +{money(meter.last)}
                  </i>
                )}
              </p>
            )}
            <p className={c.task} aria-live="polite">
              <span className={c.taskName}>{t.task}</span>
              <span className={c.why}>
                @{who.name} on {models[pick].name} · {t.why}
              </span>
            </p>
          </div>
        </div>
        <ul className={c.facts} role="list">
          {features.map((f) => (
            <li key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// Eases the shown dollar amount toward the real one, so the meter rolls instead of jumping.
function useCountTo(to: number) {
  const [v, setV] = useState(to);
  const from = useRef(to);
  useEffect(() => {
    const a = from.current;
    if (a === to) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 520);
      const x = a + (to - a) * (1 - (1 - k) ** 3);
      from.current = x;
      setV(x);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return v;
}
