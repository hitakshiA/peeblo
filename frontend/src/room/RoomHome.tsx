import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import Mark from "../components/marketing/PeebloMark";
import { room, PEEBLO_API, type CaseSummary } from "./api";
import { AppLogo, APPS } from "./AppLogo";
import { SCENES, type Scene } from "./scenes";
import "./room.css";

// Judge-facing launcher: pick a case file, Peeblo works it live. Current cases below.
const TILT = [-1.1, 0.7, -0.4, 0.9, -0.8, 0.5];
const spring = { type: "spring", stiffness: 260, damping: 24 } as const;

export default function RoomHome() {
  const [list, setList] = useState<CaseSummary[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [launching, setLaunching] = useState<{ scene: Scene | null; objective: string; step: number } | null>(null);
  const [custom, setCustom] = useState("");
  const [open, setOpen] = useState<Scene | null>(() => SCENES.find((x) => x.id === new URLSearchParams(window.location.search).get("case")) ?? null);
  const [filter, setFilter] = useState<"all" | "working" | "waiting" | "resolved">("all");
  const nav = useNavigate();

  const load = () => room.cases().then(setList).catch(() => {});
  useEffect(() => {
    load();
    fetch(`${PEEBLO_API}/api/health`).then((r) => setOnline(r.ok)).catch(() => setOnline(false));
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const launch = async (scene: Scene | null, objective: string) => {
    if (!objective.trim() || launching) return;
    setLaunching({ scene, objective, step: 0 });
    const tick = (step: number) => setLaunching((l) => (l ? { ...l, step } : l));
    try {
      await new Promise((r) => setTimeout(r, 650));
      tick(1);
      const c = await room.assign(objective.trim());
      tick(2);
      await new Promise((r) => setTimeout(r, 900));
      tick(3);
      await new Promise((r) => setTimeout(r, 500));
      nav(`/room/${c.id}`);
    } catch {
      setLaunching(null);
    }
  };

  const shown = useMemo(() => list.filter((c) => filter === "all" || (filter === "working" ? c.active : !c.active && c.status === filter)), [list, filter]);
  const counts = useMemo(() => ({ working: list.filter((c) => c.active).length, waiting: list.filter((c) => !c.active && c.status === "waiting").length, resolved: list.filter((c) => c.status === "resolved").length }), [list]);

  return (
    <div className="room room-home">
      <header className="room-top">
        <Link to="/" className="room-brand"><Mark size={26} /> peeblo</Link>
        <div className="room-title" />
        <span className={`pill ${online ? "pill-ok" : online === false ? "pill-danger" : ""}`}>{online ? "agent online" : online === false ? "agent offline" : "connecting"}</span>
        <a className="btn ghost" href="https://github.com/hitakshiA/peeblo" target="_blank" rel="noreferrer">How it works</a>
      </header>

      <section className="deck-intro">
        <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}>
          Pick a case. Watch Peeblo work it live.
        </motion.h1>
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25, duration: 0.6 }}>
          Each file is just a message from a colleague. Peeblo investigates across real sandbox apps, checks policy, asks for approval when it needs to, and verifies every change.
        </motion.p>
        <motion.div className="deck-apps" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05, delayChildren: 0.35 } } }}>
          {APPS.map((a) => (
            <motion.span key={a.id} variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }} title={`${a.name}: ${a.role}`}><AppLogo app={a.id} size={20} /></motion.span>
          ))}
        </motion.div>
      </section>

      <section className="deck">
        {SCENES.map((s, i) => <CaseFile key={s.id} scene={s} tilt={TILT[i % TILT.length]} delay={0.1 + i * 0.07} onLaunch={() => setOpen(s)} />)}
        <motion.div className="file file-custom" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.55 }}>
          <div><span className="micro">Your own case</span><h3>Write it the way a colleague would.</h3></div>
          <textarea value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Keystone Apparel says they paid by card last week but QuickBooks still shows them overdue." />
          <button className="btn" disabled={!custom.trim()} onClick={() => launch(null, custom)}>Launch live run</button>
        </motion.div>
      </section>

      <section className="current">
        <div className="current-head">
          <h2 className="micro">Cases Peeblo owns</h2>
          <div className="tabs">
            {(["all", "working", "waiting", "resolved"] as const).map((f) => (
              <button key={f} className={`tab ${filter === f ? "is-on" : ""}`} onClick={() => setFilter(f)}>
                {f}{f !== "all" && <span>{counts[f]}</span>}
                {filter === f && <motion.i layoutId="tab-underline" className="tab-line" transition={spring} />}
              </button>
            ))}
          </div>
        </div>
        <motion.div className="case-grid" layout>
          <AnimatePresence initial={false}>
            {shown.map((c) => (
              <motion.div key={c.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={spring}>
                <Link to={`/room/${c.id}`} className={`case-card ${c.active ? "is-working" : ""}`}>
                  <span className={`pill pill-${c.active ? "info" : ({ resolved: "ok", waiting: "amber", escalated: "danger" } as Record<string, string>)[c.status] ?? "muted"}`}>{c.active ? "working now" : c.status}</span>
                  <h4>{c.title}</h4>
                  <p>{c.wakeup ? `Next check ${new Date(c.wakeup.due_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${c.wakeup.reason}` : c.next_action ?? c.objective}</p>
                  <div className="case-card-foot">
                    <span className="case-apps">{c.apps.filter((a) => a !== "peeblo").map((a) => <AppLogo key={a} app={a} size={14} />)}</span>
                    <span className="room-case-id">{timeAgo(c.updated_at)}</span>
                  </div>
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
        {!shown.length && <p className="muted small">Nothing here yet.</p>}
      </section>

      <AnimatePresence>{open && !launching && <SceneBrief scene={open} onClose={() => setOpen(null)} onStart={() => launch(open, open.objective)} />}</AnimatePresence>
      <AnimatePresence>{launching && <LaunchSequence launching={launching} />}</AnimatePresence>
    </div>
  );
}

function CaseFile({ scene, tilt, delay, onLaunch }: { scene: Scene; tilt: number; delay: number; onLaunch: () => void }) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState(false);
  return (
    <motion.button
      layoutId={`file-${scene.id}`}
      className="file"
      onClick={onLaunch}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      initial={{ opacity: 0, y: 40, rotate: reduce ? 0 : tilt * 2 }}
      animate={{ opacity: 1, y: hover && !reduce ? -10 : 0, rotate: reduce ? 0 : hover ? 0 : tilt }}
      transition={{ ...spring, delay: hover ? 0 : delay }}
    >
      <span className="file-tab micro">File {scene.index} · {scene.customer}</span>
      <div className="file-top">
        <h3>{scene.title}</h3>
        <span className="file-amount">{scene.amount}</span>
      </div>
      <blockquote>
        {scene.quote}
        <cite>{scene.from}</cite>
      </blockquote>
      <div className="file-rule" />
      <span className="micro">Peeblo has to work out</span>
      <ul>{scene.figureOut.map((f) => <li key={f}>{f}</li>)}</ul>
      <Constellation apps={scene.apps} active={hover} />
      <span className="file-cta">Read the case <span aria-hidden>→</span></span>
    </motion.button>
  );
}

// App logos joined by a hairline that draws itself on hover: the systems this case will cross.
function Constellation({ apps, active }: { apps: string[]; active: boolean }) {
  const w = 100 / Math.max(apps.length - 1, 1);
  return (
    <div className="constellation">
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
        <motion.path d={`M 2 5 ${apps.map((_, i) => `L ${Math.min(98, Math.max(2, i * w))} ${i % 2 ? 2.5 : 7.5}`).join(" ")}`} fill="none" stroke="currentColor" strokeWidth="0.35" vectorEffect="non-scaling-stroke" initial={false} animate={{ pathLength: active ? 1 : 0, opacity: active ? 1 : 0 }} transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }} />
      </svg>
      <div className="constellation-logos">
        {apps.map((a, i) => (
          <motion.span key={a} animate={{ y: active ? (i % 2 ? -5 : 5) : 0, scale: active ? 1.08 : 1 }} transition={{ ...spring, delay: active ? i * 0.04 : 0 }}>
            <AppLogo app={a} size={17} />
          </motion.span>
        ))}
      </div>
    </div>
  );
}

// The full scenario, expanded out of its case file: situation, what each app holds, traps, and what "correct" means.
function SceneBrief({ scene, onClose, onStart }: { scene: Scene; onClose: () => void; onStart: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);
  const item = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } };
  return (
    <motion.div className="brief-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.article layoutId={`file-${scene.id}`} className="brief" onClick={(e) => e.stopPropagation()} transition={spring} role="dialog" aria-modal="true" aria-label={scene.title}>
        <motion.div className="brief-inner" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05, delayChildren: 0.15 } } }}>
          <motion.header variants={item} className="brief-head">
            <span className="micro">File {scene.index} · {scene.customer}</span>
            <button className="brief-close" onClick={onClose} aria-label="Close">Esc</button>
          </motion.header>
          <motion.div variants={item} className="brief-title">
            <h2>{scene.title}</h2>
            <span className="file-amount">{scene.amount}</span>
          </motion.div>
          <div className="brief-grid">
            <div className="brief-left">
              <motion.section variants={item}>
                <span className="micro">The situation</span>
                <p className="brief-story">{scene.story}</p>
              </motion.section>
              <motion.section variants={item}>
                <span className="micro">What Peeblo is told</span>
                <blockquote className="brief-quote">“{scene.objective}”<cite>{scene.from}</cite></blockquote>
                <p className="small muted">That message is the only input. No hints, no script.</p>
              </motion.section>
              <motion.section variants={item}>
                <span className="micro">Where it can go wrong</span>
                <ul className="brief-list trap">{scene.traps.map((t) => <li key={t}>{t}</li>)}</ul>
              </motion.section>
              <motion.section variants={item}>
                <span className="micro">A correct outcome</span>
                <ul className="brief-list ok">{scene.success.map((t) => <li key={t}>{t}</li>)}</ul>
              </motion.section>
            </div>
            <motion.aside variants={item} className="brief-apps">
              <span className="micro">Apps Peeblo will use</span>
              <motion.ol initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.3 } } }}>
                {scene.appNotes.map(({ app, note }) => (
                  <motion.li key={app} variants={{ hidden: { opacity: 0, x: 12 }, show: { opacity: 1, x: 0 } }}>
                    <span className="brief-logo"><AppLogo app={app} size={18} /></span>
                    <div><b>{APPS.find((a) => a.id === app)?.name}</b><p>{note}</p></div>
                  </motion.li>
                ))}
              </motion.ol>
              <div className="brief-authority"><span className="pill pill-amber">{scene.authority}</span></div>
            </motion.aside>
          </div>
          <motion.footer variants={item} className="brief-foot">
            <p className="small muted">Starts a real run on the sandbox apps. You can watch every read, approval and verified change.</p>
            <button className="btn" onClick={onStart}>Start this case <span aria-hidden>→</span></button>
          </motion.footer>
        </motion.div>
      </motion.article>
    </motion.div>
  );
}

function LaunchSequence({ launching }: { launching: { scene: Scene | null; objective: string; step: number } }) {
  const steps = ["Handing the message to Peeblo", "Opening a durable case", "Peeblo is reading the systems of record", "Streaming the live run"];
  return (
    <motion.div className="launch" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="launch-card" initial={{ y: 40, scale: 0.94, rotate: -1.5 }} animate={{ y: 0, scale: 1, rotate: 0 }} transition={spring}>
        <span className="micro">{launching.scene ? `File ${launching.scene.index} · ${launching.scene.customer}` : "Your case"}</span>
        <p className="launch-quote">“{launching.objective}”</p>
        <ol>
          {steps.map((s, i) => (
            <motion.li key={s} className={i < launching.step ? "done" : i === launching.step ? "now" : ""} initial={{ opacity: 0, x: -8 }} animate={{ opacity: i <= launching.step ? 1 : 0.35, x: 0 }} transition={{ delay: i * 0.08 }}>
              <span className="launch-dot" /> {s}
            </motion.li>
          ))}
        </ol>
        {launching.scene && <div className="launch-apps">{launching.scene.apps.map((a, i) => <motion.span key={a} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.06 }}><AppLogo app={a} size={22} /></motion.span>)}</div>}
      </motion.div>
    </motion.div>
  );
}

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
