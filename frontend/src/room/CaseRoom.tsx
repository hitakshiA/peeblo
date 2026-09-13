import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { room, usd, type RoomEvent, type CaseDetail } from "./api";
import { AppLogo, APPS } from "./AppLogo";
import Mark from "../components/marketing/PeebloMark";
import "./room.css";

// Live view of one case. Everything rendered here comes from the agent's event stream; nothing is scripted.

const TOOL_LABEL: Record<string, string> = {
  find_customer: "Matching customer identities", get_billing_state: "Reading billing and ledger state", find_invoice: "Looking up invoice",
  ar_worklist: "Scanning the receivables portfolio", get_crm_context: "Reading CRM account", get_conversations: "Reading customer conversations",
  read_policy: "Checking policy", search_documents: "Searching documents", read_document: "Reading document", search_jira: "Checking dependencies",
  read_slack: "Reading team context", record_evidence: "Recording evidence", propose_action: "Proposing a change", retry_operation: "Resuming operation",
  schedule_follow_up: "Scheduling follow-up", propose_lesson: "Proposing a lesson", finish_run: "Reporting outcome",
};

const statusTone = (s: string) => ({ resolved: "ok", succeeded: "ok", verified: "ok", approved: "ok", waiting: "amber", awaiting_approval: "amber", pending: "amber", open: "info", submitted: "info", escalated: "danger", failed: "danger", rejected: "danger", interrupted: "danger", uncertain: "danger" } as Record<string, string>)[s] ?? "muted";

export default function CaseRoom() {
  const { id = "" } = useParams();
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [detail, setDetail] = useState<CaseDetail>();
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents([]);
    const seen = new Set<number>();
    const stop = room.stream(id, (e) => { if (seen.has(e.seq)) return; seen.add(e.seq); setEvents((prev) => [...prev, e]); });
    return stop;
  }, [id]);
  useEffect(() => { room.case(id).then(setDetail).catch(() => {}); }, [id, events.length]);
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }, [events.length]);

  const view = useMemo(() => derive(events), [events]);
  const running = detail?.active ?? view.running;

  const counts = { steps: view.timeline.filter((t) => t.kind === "tool").length, evidence: view.cards.length, changes: view.opEvents.length };
  const reasonRef = useRef<HTMLDivElement>(null);
  useEffect(() => { reasonRef.current?.scrollTo({ top: reasonRef.current.scrollHeight, behavior: "smooth" }); }, [view.timeline.length]);

  return (
    <div className="room room-case">
      <header className="room-top">
        <Link to="/room" className="room-brand"><Mark size={24} /> peeblo</Link>
        <div className="room-title">
          <span className="room-case-id">{id}</span>
          <h1>{detail?.title ?? "Case"}</h1>
        </div>
        <span className={`pill pill-${statusTone(view.interrupted && !running ? "interrupted" : running ? "submitted" : detail?.status ?? "open")}`}>{running ? "working" : view.interrupted ? "interrupted" : detail?.status ?? "…"}</span>
        <div className="room-controls">
          {running && <button className="btn ghost" onClick={() => room.interrupt(id, "after_next_write")}>Interrupt after next write</button>}
          {running && <button className="btn danger" onClick={() => room.interrupt(id, "now")}>Interrupt now</button>}
          {!running && <button className="btn" onClick={() => room.resume(id)}>{view.interrupted ? "Resume run" : "Run again"}</button>}
        </div>
      </header>

      <AppRail used={view.appsUsed} active={view.activeApps} />

      <main className="room-grid">
        <section className="col col-agent">
          <div className="col-head"><h2>Reasoning</h2><span className="col-count">{counts.steps} tool calls</span>{running && <span className="live-dot" />}</div>
          <div className="col-body" ref={reasonRef}>
            {(view.plan ?? detail?.plan)?.length ? <Plan items={(view.plan ?? detail?.plan)!} /> : null}
            <ol className="timeline">
              <AnimatePresence initial={false}>
                {view.timeline.map((t) => (
                  <motion.li key={t.key} layout="position" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }} className={`tl tl-${t.kind} ${t.kind === "tool" ? `is-${t.status}` : ""}`}>
                    {t.kind === "thought" ? <p>{t.text}</p> : t.kind === "run" ? <span className="run-divider">Resumed run</span> : <ToolStep t={t} />}
                  </motion.li>
                ))}
              </AnimatePresence>
              {running && <li className="tl tl-thought"><span className="caret" /></li>}
            </ol>
            {detail?.wakeup && <div className="wakeup">Next wake-up {new Date(detail.wakeup.due_at).toLocaleString()} · {detail.wakeup.reason}</div>}
          </div>
        </section>

        <section className="col col-feed">
          <div className="col-head"><h2>Evidence across systems</h2><span className="col-count">{counts.evidence} records</span></div>
          <div className="col-body" ref={feedRef}>
            <AnimatePresence initial={false}>
              {view.cards.map((c) => (
                <motion.div key={c.seq} layout="position" initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 26 }}>
                  <EvidenceCard event={c} />
                </motion.div>
              ))}
            </AnimatePresence>
            {!view.cards.length && <p className="empty">Evidence appears here as Peeblo reads each system.</p>}
          </div>
        </section>

        <section className="col col-ops">
          <div className="col-head"><h2>Changes and approvals</h2><span className="col-count">{counts.changes}</span></div>
          <div className="col-body">
            <AnimatePresence initial={false}>
              {view.opEvents.map((e) => (
                <motion.div key={e.seq} layout="position" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}>
                  <OpCard event={e} />
                </motion.div>
              ))}
            </AnimatePresence>
            {!view.opEvents.length && <p className="empty">Nothing changed yet. Every write shows here with its verified result.</p>}
            {view.outcome && (
              <motion.div className="outcome" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
                <div className="outcome-head"><span className={`pill pill-${statusTone(view.outcome.status)}`}>{view.outcome.status}</span> Outcome</div>
                <p>{view.outcome.summary}</p>
                <p className="muted"><b>Next:</b> {view.outcome.next_action}</p>
              </motion.div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

const ACTION_VERB: Record<string, string> = {
  find_customer: "Search customers", get_billing_state: "Read billing and ledger", find_invoice: "Look up invoice", ar_worklist: "Scan receivables", get_crm_context: "Read CRM account", get_conversations: "Read conversations",
  read_policy: "Read policy", search_documents: "Search documents", read_document: "Open document", search_jira: "Search Jira", read_slack: "Read team channel", record_evidence: "Record evidence",
  propose_action: "Propose change", retry_operation: "Resume operation", schedule_follow_up: "Schedule wake-up", propose_lesson: "Propose lesson", finish_run: "Report outcome",
};
const argSummary = (tool: string, input: any): string => {
  if (!input) return "";
  if (input.query) return `“${input.query}”`;
  if (input.invoice_ref) return input.invoice_ref;
  if (input.title) return input.title;
  if (input.path) return String(input.path).split("/").pop()!;
  if (input.text) return `“${input.text}”`;
  if (input.action) return String(input.action).replace(/[._]/g, " ");
  if (input.fact) return input.fact;
  if (input.due_at) return `${String(input.due_at).slice(0, 16).replace("T", " ")} · ${input.reason ?? ""}`;
  if (input.status && tool === "finish_run") return input.status;
  if (input.operation_id) return input.operation_id;
  const ids = Object.entries(input).filter(([k]) => /_id$/.test(k)).map(([k, v]) => `${k.replace(/_id$/, "").replace(/_/g, " ")} ${v}`);
  return ids.join(" · ");
};

function Plan({ items }: { items: { step: string; status: string; note?: string }[] }) {
  const done = items.filter((i) => i.status === "done").length;
  return (
    <div className="plan">
      <div className="plan-head"><span>Plan</span><span className="col-count">{done}/{items.length} done</span></div>
      <div className="plan-bar"><motion.i animate={{ width: `${(done / items.length) * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} /></div>
      <ol>
        {items.map((it, i) => (
          <motion.li key={`${i}-${it.step}`} layout className={`plan-item is-${it.status}`}>
            <span className="plan-box" />
            <span>{it.step}{it.note && <em className="plan-note"> · {it.note}</em>}</span>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}

function ToolStep({ t }: { t: any }) {
  const direct = /^(stripe|qbo|hubspot|jira|slack|customer|billing)_/.test(t.tool);
  const verb = ACTION_VERB[t.tool] ?? (direct ? t.tool.replace(/^(\w+?)_/, "").replace(/_/g, " ") : t.tool.replace(/_/g, " "));
  const secs = t.endedAt ? Math.max(0.1, (Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000) : null;
  return (
    <div className="step">
      <span className="step-icon">
        {t.apps.filter((a: string) => a !== "peeblo").slice(0, 3).map((a: string) => <AppLogo key={a} app={a} size={15} />)}
        {t.apps.every((a: string) => a === "peeblo") && <AppLogo app="peeblo" size={15} />}
      </span>
      <div className="step-main">
        <div className="step-line"><b>{verb}</b>{t.status === "running" ? <span className="spinner" /> : <span className={`step-status ${t.status}`}>{t.status === "error" ? "error" : `${secs?.toFixed(1)}s`}</span>}</div>
        {t.arg && <div className="step-arg">{t.arg}</div>}
        {t.status === "error" && t.error && <div className="step-err">{t.error}</div>}
      </div>
    </div>
  );
}

function AppRail({ used, active }: { used: Record<string, number>; active: Set<string> }) {
  return (
    <nav className="rail">
      {APPS.map((a) => (
        <div key={a.id} className={`rail-app ${active.has(a.id) ? "is-active" : ""} ${used[a.id] ? "is-used" : ""}`} style={{ ["--brand" as any]: a.color }}>
          <div className="rail-logo"><AppLogo app={a.id} size={22} /></div>
          <div className="rail-meta"><span>{a.name}</span><small>{used[a.id] ? `${used[a.id]} ${used[a.id] === 1 ? "call" : "calls"}` : a.role}</small></div>
        </div>
      ))}
    </nav>
  );
}

function derive(events: RoomEvent[]) {
  const appsUsed: Record<string, number> = {};
  const started = new Map<string, any>();
  const timeline: any[] = [];
  const cards: RoomEvent[] = [];
  const opEvents: RoomEvent[] = [];
  let buf = "", bufSeq = 0, running = false, interrupted = false, outcome: any, plan: any[] | undefined;
  const flush = (seq: number, text?: string) => {
    const t = (text ?? buf).replace(/\s+/g, " ").trim();
    if (t) timeline.push({ kind: "thought", key: `th-${seq}`, text: t.length > 600 ? `${t.slice(0, 600)}…` : t });
    buf = "";
  };
  for (const e of events) {
    if (e.type === "run.started") { running = true; interrupted = false; outcome = undefined; timeline.push({ kind: "run", key: `run-${e.seq}` }); }
    if (e.type === "thinking") { buf += e.data.text; bufSeq = e.seq; }
    if (e.type === "plan.updated") plan = e.data.items;
    if (e.type === "message") flush(e.seq, e.data.text);
    if (e.type === "tool.started") {
      flush(bufSeq || e.seq);
      const item = { kind: "tool", key: `tool-${e.data.id}`, id: e.data.id, tool: e.data.tool, apps: e.data.apps, arg: argSummary(e.data.tool, e.data.input), status: "running", startedAt: e.at };
      started.set(e.data.id, item);
      timeline.push(item);
    }
    if (e.type === "tool.finished") {
      const item = started.get(e.data.id);
      const out = JSON.stringify(e.data.output ?? "");
      const unknownTool = /NoSuchTool|unavailable tool/i.test(out);
      if (item) { item.status = e.data.error ? "error" : "done"; item.endedAt = e.at; item.error = e.data.error ? String(e.data.output?.error ?? "").slice(0, 220) : undefined; if (unknownTool) item.status = "skipped"; }
      started.delete(e.data.id);
      for (const a of e.data.apps) appsUsed[a] = (appsUsed[a] ?? 0) + 1;
      const isAction = e.data.tool === "propose_action" || /^(stripe|qbo|hubspot|jira|slack|customer|billing)_/.test(e.data.tool);
      if (!isAction && !unknownTool && !["retry_operation", "finish_run", "propose_lesson"].includes(e.data.tool)) cards.push(e);
      if (e.data.tool === "finish_run") outcome = e.data.input;
    }
    if (["operation.submitted", "operation.verified"].includes(e.type)) {
      const at = opEvents.findIndex((x) => ["operation.submitted", "operation.verified"].includes(x.type) && x.data.operation_id === e.data.operation_id);
      if (at >= 0) opEvents.splice(at, 1);
      opEvents.push(e);
    }
    if (["operation.reconciled", "operation.step", "operation.resuming", "approval.requested", "approval.decided", "interrupt.armed"].includes(e.type)) opEvents.push(e);
    if (e.type === "run.finished") { flush(e.seq); running = false; interrupted = e.data.status === "interrupted"; if (interrupted) opEvents.push(e); if (e.data.case && !outcome) outcome = e.data.case; for (const it of started.values()) it.status = "skipped"; started.clear(); }
  }
  const current = [...started.values()].pop();
  return { appsUsed, activeApps: new Set<string>(current?.apps ?? []), plan, timeline: timeline.filter((t) => t.kind !== "run" || timeline.indexOf(t) > 0), cards, opEvents, running, interrupted, outcome };
}

function EvidenceCard({ event }: { event: RoomEvent }) {
  const { tool, apps, input, output, error } = event.data;
  const head = (title: string, sub?: string) => (
    <div className="card-head"><span className="card-logos">{apps.map((a: string) => <AppLogo key={a} app={a} size={15} />)}</span><b>{title}</b>{sub && <span className="muted">{sub}</span>}</div>
  );
  if (error || output?.error) return <div className="card card-error">{head(TOOL_LABEL[tool] ?? tool)}<p>{String(output?.error ?? "error")}</p></div>;

  switch (tool) {
    case "find_customer": {
      const rows = [
        ...(Array.isArray(output?.stripe) ? output.stripe.map((c: any) => ["stripe", c.name, c.legal_name ?? c.email]) : []),
        ...(Array.isArray(output?.quickbooks) ? output.quickbooks.map((c: any) => ["quickbooks", c.display_name, c.company_name, c.open_balance_usd ? usd(c.open_balance_usd) : ""]) : []),
        ...(Array.isArray(output?.salesforce) ? output.salesforce.map((c: any) => ["salesforce", c.name, c.parent ? `child of ${c.parent}` : c.website]) : []),
        ...(Array.isArray(output?.hubspot) ? output.hubspot.map((c: any) => ["hubspot", c.name, c.domain]) : []),
      ];
      return <div className="card">{head(`Candidates for “${input.query}”`, `${rows.length} records`)}<table className="mini">{rows.map((r, i) => <tr key={i}><td><AppLogo app={r[0]} size={13} /></td><td>{r[1]}</td><td className="muted">{r[2]}</td><td className="num">{r[3]}</td></tr>)}</table></div>;
    }
    case "get_billing_state": case "find_invoice": {
      const inv = [...(output?.stripe?.invoices ?? (Array.isArray(output?.stripe) ? output.stripe : [])).map((i: any) => ({ ...i, app: "stripe" })), ...(output?.quickbooks?.invoices ?? (Array.isArray(output?.quickbooks) ? output.quickbooks : [])).map((i: any) => ({ ...i, app: "quickbooks" }))]
        .filter((i: any) => !String(i.invoice_ref ?? i.doc_number ?? "").startsWith("archived") && !String(i.doc_number ?? "").startsWith("X")).slice(0, 6);
      const pays = (output?.quickbooks?.payments ?? []).filter((p: any) => p.unapplied_usd > 0 || p.applied_to?.length);
      return (
        <div className="card">{head(tool === "find_invoice" ? `Invoice ${input.invoice_ref}` : "Billing state", inv[0]?.customer_name ?? inv[0]?.customer)}
          {inv.length === 0 && <p className="muted">No open documents.</p>}
          {inv.map((i: any, k: number) => (
            <div key={k} className={`inv ${i.status === "void" ? "is-void" : ""}`}>
              <AppLogo app={i.app} size={14} />
              <span className="inv-ref">{i.invoice_ref ?? i.doc_number}</span>
              <span className="muted">{i.customer_name ?? i.customer}</span>
              <span className={`pill pill-${i.days_past_due > 0 ? "danger" : statusTone(i.status ?? "open")}`}>{i.days_past_due > 0 ? `${i.days_past_due}d overdue` : i.status ?? (i.balance_usd > 0 ? "open" : "settled")}</span>
              <span className="num">{usd(i.total_usd)}</span>
            </div>
          ))}
          {output?.quickbooks && <p className="muted small">{pays.length ? `${pays.length} payment(s) recorded` : "No payments or credits applied"}</p>}
        </div>
      );
    }
    case "get_conversations": {
      const items = Array.isArray(output) ? output.slice(0, 3) : [];
      return <div className="card">{head("Customer conversations", `${Array.isArray(output) ? output.length : 0} items`)}{items.map((m: any, k: number) => (
        <div key={k} className="email"><div className="email-subj">{m.hs_email_subject ?? "Note"}</div><div className="email-body">{highlight(String(m.hs_email_text ?? m.hs_note_body ?? "").slice(0, 380))}</div></div>
      ))}</div>;
    }
    case "get_crm_context": {
      const sf = output?.salesforce;
      return <div className="card">{head(sf?.Name ?? output?.hubspot?.company?.name ?? "CRM account", sf?.Parent?.Name ? `parent: ${sf.Parent.Name}` : undefined)}
        {sf && <p className="small">{highlight(String(sf.Description ?? ""))}</p>}
        {sf?.Contacts?.records?.slice(0, 3).map((c: any, k: number) => <div key={k} className="small muted">{c.Name} · {c.Title} · {c.Email}</div>)}
      </div>;
    }
    case "read_policy":
      if (Array.isArray(output)) return <div className="card">{head("Policies available", `${output.length}`)}<div className="chips">{output.map((t: string) => <span key={t} className="chip">{t}</span>)}</div></div>;
      return <div className="card">{head(output?.title ?? "Policy")}<div className="policy">{String(output?.text ?? "").split("\n").filter((l: string) => /approv|void|reissue|entity|legal|bill-to|name alone/i.test(l)).slice(0, 5).map((l: string, k: number) => <div key={k} className="policy-line">{l.replace(/^[-#\s]+/, "")}</div>)}</div></div>;
    case "search_documents":
      return <div className="card">{head(`Documents: “${input.query}”`, `${Array.isArray(output) ? output.length : 0} files`)}{(Array.isArray(output) ? output : []).slice(0, 5).map((d: any, k: number) => <div key={k} className="small doc-path">{d.path}</div>)}</div>;
    case "read_document": {
      const revs = output?.revisions ?? [];
      const lines = String(output?.text ?? "").split("\n").slice(1, 9);
      return <div className="card">{head(String(output?.path ?? input.path).split("/").pop()!, revs.length > 1 ? `${revs.length} versions` : undefined)}
        {revs.length > 1 && <div className="revs">{revs.map((r: any, k: number) => <span key={r.rev} className={`rev ${k === 0 ? "rev-current" : "rev-old"}`}>{k === 0 ? "current" : "superseded"} · {r.modified.slice(0, 10)}</span>)}</div>}
        <div className="doc">{lines.map((l, k) => <div key={k}>{highlight(l)}</div>)}</div>
      </div>;
    }
    case "search_jira":
      return <div className="card">{head("Jira", `${Array.isArray(output) ? output.length : 0} issues`)}{(Array.isArray(output) ? output : []).slice(0, 3).map((i: any) => <div key={i.key} className="small"><b>{i.key}</b> {i.summary} <span className={`pill pill-${i.status === "Done" ? "ok" : "info"}`}>{i.status}</span></div>)}</div>;
    case "read_slack":
      return <div className="card">{head("Team context in #ar-desk")}{(Array.isArray(output) ? output : []).slice(0, 2).map((m: any) => <p key={m.ts} className="small">{String(m.text).slice(0, 220)}</p>)}</div>;
    case "record_evidence":
      return <div className="fact"><AppLogo app={input.source === "quickbooks" ? "quickbooks" : input.source} size={13} /> {input.fact}</div>;
    case "schedule_follow_up":
      return <div className="fact">⏰ Follow-up scheduled {String(input.due_at).slice(0, 16).replace("T", " ")} · {input.reason}</div>;
    default:
      return <div className="card">{head(TOOL_LABEL[tool] ?? tool)}<pre className="small">{JSON.stringify(output, null, 1)?.slice(0, 400)}</pre></div>;
  }
}

function OpCard({ event }: { event: RoomEvent }) {
  const d = event.data;
  const app = String(d.kind ?? "").split(".")[0].replace("qbo", "quickbooks").replace("customer", "hubspot");
  const label = String(d.kind ?? "").split(".")[1]?.replace(/_/g, " ");
  if (event.type === "interrupt.armed") return <div className="op op-warn">⚡ Interrupt armed: the run will stop right after the next accepted write</div>;
  if (event.type === "run.finished") return <div className="op op-danger">⛔ Run interrupted: {d.reason}</div>;
  if (event.type === "approval.requested") return (
    <div className="op op-approval">
      <div className="op-head"><AppLogo app="slack" size={15} /> Approval requested · {d.approver}</div>
      <div className="op-title">{label} {d.amount != null && <b>{usd(d.amount)}</b>}</div>
      <p className="small muted">{String(d.justification).slice(0, 260)}</p>
    </div>
  );
  if (event.type === "approval.decided") return <div className={`op ${d.decision === "approved" ? "op-ok" : "op-danger"}`}><AppLogo app="slack" size={15} /> {d.decision === "approved" ? "Approved in Slack" : "Rejected in Slack"}</div>;
  if (event.type === "operation.step") return <div className={`op op-ok ${d.kind === "stripe.void_invoice" || d.kind === "qbo.void_invoice" ? "op-void" : ""}`}><div className="op-head"><AppLogo app={app} size={15} /> <span className="op-title">{label}</span> <span className="pill pill-ok">done</span></div><div className="small">{d.detail}</div></div>;
  if (event.type === "operation.resuming") return <div className="op op-warn">↻ Resuming the recorded correction: checking what already happened before any write</div>;
  if (event.type === "operation.submitted") return <div className="op op-info"><AppLogo app={app} size={15} /> <span className="op-title">{label}</span> <span className="pill pill-info">submitted</span></div>;
  if (event.type === "operation.reconciled") return <div className="op op-ok"><div className="op-head"><AppLogo app={app} size={15} /> <span className="op-title">{label}</span> <span className="pill pill-ok">already done</span></div><div className="small">Found existing result: {d.detail ?? d.provider_id}. No duplicate created.</div></div>;
  return (
    <div className={`op ${d.ok ? "op-ok" : "op-danger"} ${d.kind === "stripe.void_invoice" ? "op-void" : ""}`}>
      <div className="op-head"><AppLogo app={app} size={15} /> <span className="op-title">{label}</span> <span className={`pill pill-${d.ok ? "ok" : "danger"}`}>{d.ok ? "verified" : "not verified"}</span></div>
      <div className="small">{d.observed}</div>
      {d.note && <div className="small muted">{d.note}</div>}
    </div>
  );
}

const highlight = (s: string) => {
  const parts = s.split(/(Eastbridge Logistics LLC|Eastbridge Holdings, Inc\.|EIN [0-9-]+|\$[0-9,]+(?:\.\d\d)?|REJECTED|rejected|supersedes[^.]*|INV-\d+)/g);
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
};
