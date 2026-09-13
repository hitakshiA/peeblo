import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { room, usd, type RoomEvent, type CaseDetail } from "./api";
import { AppLogo, APPS } from "./AppLogo";
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

  return (
    <div className="room">
      <header className="room-top">
        <Link to="/room" className="room-brand"><AppLogo app="peeblo" size={22} /> Peeblo</Link>
        <div className="room-title">
          <span className="room-case-id">{id}</span>
          <h1>{detail?.title ?? "Case"}</h1>
        </div>
        <span className={`pill pill-${statusTone(view.interrupted && !running ? "interrupted" : detail?.status ?? "open")}`}>{running ? "working" : view.interrupted ? "interrupted" : detail?.status ?? "…"}</span>
        <div className="room-controls">
          {running && <button className="btn ghost" onClick={() => room.interrupt(id, "after_next_write")}>Interrupt after next write</button>}
          {running && <button className="btn danger" onClick={() => room.interrupt(id, "now")}>Interrupt now</button>}
          {!running && <button className="btn" onClick={() => room.resume(id)}>{view.interrupted ? "Resume run" : "Run again"}</button>}
        </div>
      </header>

      <AppRail used={view.appsUsed} active={view.activeApps} />

      <main className="room-grid">
        <section className="col col-agent">
          <h2>Peeblo is thinking</h2>
          <AnimatePresence mode="popLayout">
            {view.currentStep && running && (
              <motion.div key={view.currentStep.id} className="now" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <span className="spinner" />
                <div><div className="now-label">{TOOL_LABEL[view.currentStep.tool] ?? view.currentStep.tool}</div><div className="now-apps">{view.currentStep.apps.map((a: string) => <AppLogo key={a} app={a} size={14} />)}</div></div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="thinking">
            {view.thoughts.slice(-6).map((t, i, arr) => (
              <motion.p key={t.seq} initial={{ opacity: 0 }} animate={{ opacity: i === arr.length - 1 ? 1 : 0.45 }} transition={{ duration: 0.4 }}>{t.text}</motion.p>
            ))}
            {running && <span className="caret" />}
          </div>
          {detail?.wakeup && <div className="wakeup">⏰ Follow-up {new Date(detail.wakeup.due_at).toLocaleString()} · {detail.wakeup.reason}</div>}
        </section>

        <section className="col col-feed" ref={feedRef}>
          <h2>Evidence across systems</h2>
          <AnimatePresence initial={false}>
            {view.cards.map((c) => (
              <motion.div key={c.seq} layout initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 26 }}>
                <EvidenceCard event={c} />
              </motion.div>
            ))}
          </AnimatePresence>
        </section>

        <section className="col col-ops">
          <h2>Changes and approvals</h2>
          <AnimatePresence initial={false}>
            {view.opEvents.map((e) => (
              <motion.div key={e.seq} layout initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}>
                <OpCard event={e} />
              </motion.div>
            ))}
          </AnimatePresence>
          {view.outcome && (
            <motion.div className="outcome" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
              <div className="outcome-head"><span className={`pill pill-${statusTone(view.outcome.status)}`}>{view.outcome.status}</span> Outcome</div>
              <p>{view.outcome.summary}</p>
              <p className="muted"><b>Next:</b> {view.outcome.next_action}</p>
            </motion.div>
          )}
        </section>
      </main>
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
  const thoughts: { seq: number; text: string }[] = [];
  const cards: RoomEvent[] = [];
  const opEvents: RoomEvent[] = [];
  let buf = "", bufSeq = 0, running = false, interrupted = false, outcome: any;
  for (const e of events) {
    if (e.type === "run.started") { running = true; interrupted = false; outcome = undefined; }
    if (e.type === "thinking") { buf += e.data.text; bufSeq = e.seq; }
    if (e.type === "message" || e.type === "tool.started") {
      const text = (e.type === "message" ? e.data.text : buf).replace(/\s+/g, " ").trim();
      if (text) thoughts.push({ seq: e.type === "message" ? e.seq : bufSeq, text: text.length > 420 ? `${text.slice(0, 420)}…` : text });
      buf = "";
    }
    if (e.type === "tool.started") { started.set(e.data.id, e.data); }
    if (e.type === "tool.finished") {
      started.delete(e.data.id);
      for (const a of e.data.apps) appsUsed[a] = (appsUsed[a] ?? 0) + 1;
      const isAction = e.data.tool === "propose_action" || /^(stripe|qbo|hubspot|jira|slack|customer|billing)_/.test(e.data.tool);
      const unknownTool = /NoSuchTool|unavailable tool/i.test(JSON.stringify(e.data.output ?? ""));
      if (!isAction && !unknownTool && !["retry_operation", "finish_run", "propose_lesson"].includes(e.data.tool)) cards.push(e);
      if (e.data.tool === "finish_run") outcome = e.data.input;
    }
    if (["operation.submitted", "operation.verified"].includes(e.type)) {
      // One row per operation, showing its latest state.
      const at = opEvents.findIndex((x) => ["operation.submitted", "operation.verified"].includes(x.type) && x.data.operation_id === e.data.operation_id);
      if (at >= 0) opEvents.splice(at, 1);
      opEvents.push(e);
    }
    if (["operation.reconciled", "operation.step", "operation.resuming", "approval.requested", "approval.decided", "interrupt.armed"].includes(e.type)) opEvents.push(e);
    if (e.type === "run.finished") { running = false; interrupted = e.data.status === "interrupted"; if (interrupted) opEvents.push(e); if (e.data.case && !outcome) outcome = e.data.case; }
  }
  const current = [...started.values()].pop();
  return { appsUsed, activeApps: new Set<string>(current?.apps ?? []), currentStep: current, thoughts, cards, opEvents, running, interrupted, outcome };
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
