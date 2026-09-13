import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { room, type CaseSummary } from "./api";
import { AppLogo, APPS } from "./AppLogo";
import "./room.css";

// Peeblo's portfolio: every case it owns, what it is waiting on, and a way to hand it new work.
export default function RoomHome() {
  const [list, setList] = useState<CaseSummary[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const nav = useNavigate();
  const load = () => room.cases().then(setList).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  const assign = async () => {
    if (!text.trim()) return;
    setBusy("assign");
    const c = await room.assign(text.trim()).finally(() => setBusy(""));
    nav(`/room/${c.id}`);
  };

  return (
    <div className="room">
      <header className="room-top">
        <Link to="/room" className="room-brand"><AppLogo app="peeblo" size={22} /> Peeblo</Link>
        <div className="room-title"><span className="room-case-id">Accounts receivable teammate</span></div>
        <div className="room-controls">
          <button className="btn ghost" disabled={!!busy} onClick={async () => { setBusy("reset"); await room.reset("eastbridge").finally(() => setBusy("")); load(); }}>{busy === "reset" ? "Resetting sandbox…" : "Reset Eastbridge sandbox"}</button>
        </div>
      </header>
      <nav className="rail">{APPS.map((a) => <div key={a.id} className="rail-app is-used" style={{ ["--brand" as any]: a.color }}><div className="rail-logo"><AppLogo app={a.id} size={22} /></div><div className="rail-meta"><span>{a.name}</span><small>{a.role}</small></div></div>)}</nav>
      <div className="home">
        <span className="micro">Standing responsibility · Miny Labs, Inc. · US receivables</span>
        <h1>Owns receivables <em>until every case</em> reaches a verified outcome.</h1>
        <p className="muted">Detect missing or inaccurate invoices, investigate overdue balances, manage payment promises, reconcile received payments, and escalate anything outside policy.</p>
        <div className="assign">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Hand Peeblo work, e.g. “Crescent Dental says they already paid INV-2296. Can you check?”" />
          <button className="btn" onClick={assign} disabled={busy === "assign"}>{busy === "assign" ? "Assigning…" : "Assign"}</button>
        </div>
        {list.map((c, i) => (
          <motion.div key={c.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
            <Link to={`/room/${c.id}`} className="case-row">
              <span className={`pill pill-${c.active ? "info" : ({ resolved: "ok", waiting: "amber", escalated: "danger" } as any)[c.status] ?? "muted"}`}>{c.active ? "working" : c.status}</span>
              <div><div style={{ fontWeight: 600, color: "var(--color-ink-strong)" }}>{c.title}</div><div className="small muted">{c.wakeup ? `⏰ ${new Date(c.wakeup.due_at).toLocaleString()} · ${c.wakeup.reason}` : c.next_action ?? c.objective}</div></div>
              <div className="case-apps">{c.apps.filter((a) => a !== "peeblo").map((a) => <AppLogo key={a} app={a} size={15} />)}</div>
              <span className="room-case-id">{new Date(c.updated_at).toLocaleTimeString()}</span>
            </Link>
          </motion.div>
        ))}
        {!list.length && <p className="muted">No cases yet. Tag @Peeblo in Slack or assign work above.</p>}
      </div>
    </div>
  );
}
