// Peeblo's console: everything you can do in Slack, from the same API. Hash routes keep it a single static page.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, get, money, post, when, type RunEvent, type Teammate } from "./api";
import { Connectors } from "./Connectors";
import { Face, PEEBLO_FACE, primeFaces } from "./Face";
import { useLoad } from "./hooks";
import { ConnectOtari, Login, Wizard, useSetup } from "./Setup";

type Route = { page: string; arg?: string };
const parse = (): Route => { const [page = "", arg] = location.hash.replace(/^#\/?/, "").split("/"); return { page: page || "crew", arg: arg ? decodeURIComponent(arg) : undefined }; };
function useRoute(): Route { const [r, setR] = useState(parse()); useEffect(() => { const f = () => setR(parse()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []); return r; }

// Grouped like the work: the crew and what it's doing, then what helps you debug it, then the system around it.
const NAV: [string, [string, string][]][] = [
  ["Work", [["crew", "Crew"], ["connectors", "Connectors"], ["sessions", "Sessions"], ["approvals", "Approvals"], ["schedules", "Schedules"]]],
  ["Debug", [["people", "People"], ["computers", "Computers"], ["feedback", "Feedback"]]],
  ["System", [["otari", "Otari"], ["setup", "Setup"], ["checks", "Checks"]]],
];

export default function App() {
  const route = useRoute();
  const setup = useSetup();
  const { state, signedIn, loaded } = setup;
  const unfinished = Boolean(state && state.next !== "done");
  const pending = useLoad<{ approvals: any[] }>(signedIn ? "/v1/approvals?status=pending" : null, 10_000);
  // Until setup is done, the console opens on it.
  useEffect(() => { if (loaded && signedIn && unfinished && !location.hash.replace(/^#\/?/, "")) location.replace("#/setup"); }, [loaded, signedIn, unfinished]);
  if (!loaded) return null;
  if (!signedIn) return state && (!state.password_set || unfinished) ? <Wizard setup={setup} /> : <Login onIn={setup.reload} />;
  if (route.page === "setup" && setup.available && !setup.locked) return <Wizard setup={setup} />;
  const n = pending.data?.approvals.length ?? 0;
  const page = route.page === "setup" ? "checks" : route.page;
  return (
    <div className="shell">
      <nav className="side">
        <a className="brand" href="#/crew"><Face slug="peeblo" face={PEEBLO_FACE} size={32} />peeblo</a>
        <div className="nav-groups">
          {NAV.map(([group, items]) => <div key={group} className="nav-group"><div className="nav-label">{group}</div>
            {items.filter(([k]) => k !== "setup" || setup.available).map(([k, label]) => <a key={k} className={`nav ${page === k || (k === "crew" && page === "teammate") ? "on" : ""}`} href={`#/${k}`}>{label}{k === "approvals" && n > 0 && <span className="badge">{n}</span>}{k === "setup" && unfinished && <span className="badge soft">to do</span>}</a>)}</div>)}
        </div>
        <div className="side-foot">Signed in as {setup.person ?? "admin"}<br /><a href="#" onClick={(e) => { e.preventDefault(); post("/v1/console/logout").then(() => setup.reload()); }}>Sign out</a></div>
      </nav>
      <main className="main">
        {page === "crew" && <Crew />}
        {page === "teammate" && route.arg && <TeammatePage slug={route.arg} />}
        {page === "connectors" && <Connectors />}
        {page === "approvals" && <Approvals onChange={pending.reload} />}
        {page === "sessions" && <Sessions id={route.arg} />}
        {page === "people" && <People />}
        {page === "schedules" && <Schedules />}
        {page === "computers" && <Computers />}
        {page === "otari" && <Otari />}
        {page === "feedback" && <Feedback />}
        {page === "checks" && <Checks />}
      </main>
    </div>
  );
}

const Status = ({ s }: { s: string }) => <span className={`pill ${s === "done" || s === "approved" || s === "awake" ? "ok" : s === "failed" || s === "denied" || s.startsWith("stopped") ? "bad" : s === "running" || s === "waiting" || s === "pending" ? "warn" : ""}`}>{s}</span>;
const Page = ({ title, sub, error, children }: { title: string; sub?: string; error?: string | null; children: ReactNode }) => <><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}{error && <div className="err" role="alert">{error}</div>}{children}</>;
const hidden = (t: Teammate) => Boolean((t as any).hidden);

function Crew() {
  const { data, error } = useLoad<{ teammates: Teammate[] }>("/v1/teammates");
  useEffect(() => { if (data) primeFaces(data.teammates); }, [data]);
  const crew = (data?.teammates ?? []).filter((t) => !hidden(t));
  return (
    <Page title="Your crew" sub="Open a teammate to talk to it, adjust it, or read its memory." error={error}>
      <p className="muted" style={{ marginBottom: 16 }}>To hire, ask Peeblo in Slack: “I need a teammate who…”. Peeblo proposes the role, tools and budget, and you approve its ID card there.</p>
      <div className="grid">
        {crew.map((t) => (
          <a key={t.id} className="card link" href={`#/teammate/${t.slug}`}>
            <div className="mate"><Face slug={t.slug} face={t.face} size={56} /><h3>{t.config.name}</h3></div>
            <div className="muted clamp">{t.config.role}</div>
            <div className="row tags"><span className="pill">{t.config.model.default.replace(/^peeblo-/, "").split("/").pop()}</span><span className="pill">${t.config.budget.monthly_usd}/mo</span><span className="pill">{t.config.mode}</span></div>
          </a>
        ))}
      </div>
      {data && crew.length === 0 && <div className="empty card stack"><Face slug="peeblo" face={PEEBLO_FACE} size={64} /><h3>No teammates yet</h3><p className="muted">DM Peeblo in Slack: “I need a teammate who…”. Your crew shows up here.</p></div>}
    </Page>
  );
}

function TeammatePage({ slug }: { slug: string }) {
  const { data, reload } = useLoad<any>(`/v1/teammates/${slug}/overview`);
  const [tab, setTab] = useState("talk");
  if (!data) return null;
  const t: Teammate = data.teammate;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Face slug={slug} face={t.face} size={96} /><div><h1>{t.config.name}</h1><div className="sub" style={{ margin: 0 }}>{t.config.role}</div></div></div>
      <div className="row">
        <span className="pill">{t.config.model.default}</span><span className="pill">{data.spend ? `${money(data.spend.spent)} of ${money(data.spend.cap)} this month` : `$${t.config.budget.monthly_usd}/mo`}</span>
        <span className="pill">{t.config.mode} mode</span><span className="pill">{t.config.computer?.size ?? "small"} computer</span><span className="pill">v{t.version}</span>
        {data.app && (data.app.installed ? <span className="pill ok">in Slack</span> : data.app.install_url ? <a className="btn" href={data.app.install_url} target="_blank" rel="noreferrer">Add to Slack</a> : null)}
      </div>
      <div className="tabs">{["talk", "settings", "memory", "jobs", "schedules", "computer"].map((k) => <button key={k} className={tab === k ? "" : "ghost"} onClick={() => setTab(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}</div>
      {tab === "talk" && <Talk slug={slug} name={t.config.name} />}
      {tab === "settings" && <Settings t={t} onSaved={reload} />}
      {tab === "memory" && <Memory slug={slug} />}
      {tab === "jobs" && <div className="card"><table><thead><tr><th>Asked</th><th>Status</th><th>When</th></tr></thead><tbody>{data.recent_runs.map((r: any) => <tr key={r.id}><td>{r.asked}</td><td><Status s={r.status} /></td><td className="muted">{when(r.created_at)}</td></tr>)}</tbody></table></div>}
      {tab === "schedules" && <ScheduleTable rows={data.schedules.map((s: any) => ({ ...s, teammate: slug }))} reload={reload} />}
      {tab === "computer" && <ComputerCard c={data.computer ?? { teammate: slug, size: t.config.computer?.size ?? "small", state: "asleep", builds: [] }} reload={reload} />}
    </>
  );
}

// A conversation with a teammate from the console: the same run, tools, approvals and receipts as in Slack.
function Talk({ slug, name }: { slug: string; name: string }) {
  const [session, setSession] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ ask: string; run: string; events: RunEvent[]; status: string; receipt?: string }[]>([]);
  const [text, setText] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const send = async () => {
    const ask = text.trim(); if (!ask) return; setText("");
    const s = session ?? (await post<{ id: string }>(`/v1/teammates/${slug}/sessions`, { kind: "api", place_key: `console:${crypto.randomUUID()}` })).id;
    setSession(s);
    const { run_id } = await post<{ run_id: string }>(`/v1/sessions/${s}/submissions`, { text: ask, request_id: crypto.randomUUID() });
    setTurns((x) => [...x, { ask, run: run_id, events: [], status: "queued" }]);
    if (timer.current) clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      const r = await get<{ run: any; events: RunEvent[] }>(`/v1/runs/${run_id}`);
      let receipt: string | undefined;
      if (["done", "failed"].includes(r.run.status)) { clearInterval(timer.current!); receipt = (await get<{ line: string }>(`/v1/runs/${run_id}/receipt`).catch(() => ({ line: "" }))).line; }
      setTurns((x) => x.map((t) => (t.run === run_id ? { ...t, events: r.events, status: r.run.status, receipt } : t)));
    }, 2000);
  };
  return (
    <div className="card chat">
      {turns.length === 0 && <div className="muted">Ask {name} anything you'd ask it in Slack.</div>}
      {turns.map((t) => {
        const said = t.events.filter((e) => e.type === "slack.post").map((e) => e.data.text).join("\n\n") || t.events.filter((e) => e.type === "turn.finished").map((e) => e.data.text).pop() || "";
        const tools = t.events.filter((e) => e.type === "tool.call" && !["slack_post", "plan"].includes(e.data.tool));
        const asks = t.events.filter((e) => e.type === "approval.requested" && !t.events.some((x) => x.type === "approval.resolved" && x.data.approval_id === e.data.approval_id));
        return (
          <div key={t.run} className="stack">
            <div className="bubble me">{t.ask}</div>
            {tools.length > 0 && <div className="tasks">{tools.map((e) => <div key={e.id}>{e.data.status === "completed" ? "✓" : e.data.status === "waiting_approval" ? "…" : "✗"} {e.data.tool.replace(/__/g, " · ").replace(/_/g, " ")}</div>)}</div>}
            {asks.map((e) => <ApprovalCard key={e.id} a={{ id: e.data.approval_id, action: e.data.action, teammate: slug }} />)}
            {(said || t.status === "done" || t.status === "failed") && <div className="bubble">{said || (t.status === "failed" ? "It hit a problem and stopped." : "")}{t.receipt && <div className="receipt">{t.receipt}</div>}</div>}
            {!["done", "failed"].includes(t.status) && !said && <div className="muted">{name} is working…</div>}
          </div>
        );
      })}
      <div className="row"><input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Message ${name}`} /><button onClick={send}>Send</button></div>
    </div>
  );
}

function Settings({ t, onSaved }: { t: Teammate; onSaved: () => void }) {
  const [f, setF] = useState({ instructions: t.config.instructions, model: t.config.model.default, budget: t.config.budget.monthly_usd, mode: t.config.mode, connectors: t.config.connectors.join(", "), tools: t.config.tools.join(", "), size: t.config.computer?.size ?? "small", note: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = () => api("PATCH", `/v1/teammates/${t.slug}`, { instructions: f.instructions, budget: { monthly_usd: Number(f.budget) }, mode: f.mode, connectors: f.connectors.split(",").map((x) => x.trim()).filter(Boolean), tools: f.tools.split(",").map((x) => x.trim()).filter(Boolean), computer: { size: f.size }, note: f.note || "changed in the console" }).then((r: any) => { setMsg(`Saved as version ${r.version}. Running conversations keep their setup; new ones use this.`); onSaved(); }, (e) => setMsg(e.message));
  return (
    <div className="card stack">
      <div className="form">
        <label>Model<input value={f.model} disabled title="Teammates run on their role policy in Otari (see the Otari page)" /></label>
        <label>Budget (USD a month)<input type="number" value={f.budget} onChange={set("budget")} /></label>
        <label>Approvals<select value={f.mode} onChange={set("mode")}><option value="ask">Ask</option><option value="auto">Auto</option><option value="trusted">Trusted</option><option value="yolo">YOLO (admin)</option></select></label>
        <label>Connectors<input value={f.connectors} onChange={set("connectors")} /></label>
        <label>Tools<input value={f.tools} onChange={set("tools")} /></label>
        <label>Computer<select value={f.size} onChange={set("size")}><option value="small">Small</option><option value="large">Large</option></select></label>
      </div>
      <label>Standing instructions<textarea value={f.instructions} onChange={set("instructions")} /></label>
      <label>Why (kept with the version)<input value={f.note} onChange={set("note")} /></label>
      <div className="row"><button onClick={save}>Save a new version</button>{msg && <span className="muted">{msg}</span>}</div>
    </div>
  );
}

function Memory({ slug }: { slug: string }) {
  const { data, reload } = useLoad<{ notes: any[] }>(`/v1/teammates/${slug}/memory`);
  const [open, setOpen] = useState<any>(null);
  const [draft, setDraft] = useState({ title: "", body: "" });
  const show = (n: any) => get(`/v1/teammates/${slug}/memory/note?bank=${encodeURIComponent(n.bank)}&path=${encodeURIComponent(n.path)}`).then((r: any) => { setOpen(r.note); setDraft({ title: r.note.title, body: r.note.body }); });
  return (
    <div className="stack">
      <div className="card"><table><thead><tr><th>Note</th><th>Place</th><th>State</th><th /></tr></thead><tbody>
        {(data?.notes ?? []).map((n) => <tr key={`${n.bank}/${n.path}`}><td><a href="#" onClick={(e) => { e.preventDefault(); show(n); }}>{n.title}</a><div className="muted mono">{n.path}</div></td><td className="mono">{n.bank}</td><td>{n.verified ? <span className="pill ok">verified</span> : <span className="pill warn">unverified</span>}</td>
          <td>{!n.verified && <button className="ghost" onClick={() => post(`/v1/teammates/${slug}/memory/verify`, { bank: n.bank, path: n.path }).then(reload)}>Verify</button>}</td></tr>)}
      </tbody></table>{!data?.notes.length && <div className="muted">No memory yet.</div>}</div>
      {open && <div className="card stack"><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label><label>Note<textarea style={{ minHeight: 180 }} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
        <div className="row"><button onClick={() => api("PUT", `/v1/teammates/${slug}/memory/note`, { bank: open.bank, path: open.path, title: draft.title, body: draft.body }).then(() => { setOpen(null); reload(); })}>Save (as verified)</button><button className="ghost" onClick={() => setOpen(null)}>Close</button></div></div>}
    </div>
  );
}

function ApprovalCard({ a, onDone }: { a: any; onDone?: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const act = a.action ?? {};
  const answer = (decision: string, scope = "once") => post(`/v1/approvals/${a.id}`, { decision, scope }).then((r: any) => { setMsg(r.ok ? (decision === "approved" ? "Approved." : "Declined.") : r.status === "not_allowed" ? "Only the owner (or the person who asked) can answer this one." : `It's ${r.status}.`); onDone?.(); });
  const perAction = act.per_action || act.kind === "hire" || act.kind === "recipe_change";
  return (
    <div className="card stack" style={{ borderColor: "var(--ember)" }}>
      {act.id_card_url && <img src={act.id_card_url} alt="ID card" style={{ maxWidth: 420, borderRadius: 16 }} />}
      <div><b>{a.teammate}</b> wants to {act.kind === "hire" ? `hire ${act.summary}` : act.kind === "recipe_change" ? "change its computer setup" : act.tool ? `${String(act.tool).replace(/_/g, " ")}${act.server ? ` in ${act.server}` : ""}` : "go ahead"}{act.risk && act.risk !== "write" ? <span className="pill warn" style={{ marginLeft: 8 }}>{act.risk.replace("_", " ")}</span> : null}</div>
      {act.rule && <div className="muted">{act.rule}</div>}
      {act.arguments && <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(act.arguments, null, 1).slice(0, 800)}</pre>}
      {msg ? <div className="muted">{msg}</div> : <div className="row"><button className="moss" onClick={() => answer("approved")}>Approve once</button>{!perAction && <><button className="ghost" onClick={() => answer("approved", "job")}>For this job</button><button className="ghost" onClick={() => answer("approved", "always")}>Always</button></>}<button className="ember" onClick={() => answer("denied")}>No</button></div>}
    </div>
  );
}

function Approvals({ onChange }: { onChange: () => void }) {
  const { data, reload } = useLoad<{ approvals: any[] }>("/v1/approvals?status=pending", 5000);
  return <Page title="Approvals" sub="What teammates are waiting on. The same cards as in Slack; your answer is checked on the server.">
    <div className="stack">{(data?.approvals ?? []).map((a) => <ApprovalCard key={a.id} a={a} onDone={() => { reload(); onChange(); }} />)}{!data?.approvals.length && <div className="muted">Nothing is waiting.</div>}</div>
  </Page>;
}

function Sessions({ id }: { id?: string }) {
  const list = useLoad<{ sessions: any[] }>(id ? null : "/v1/sessions");
  const one = useLoad<any>(id ? `/v1/sessions/${id}` : null);
  if (id) return <Page title="Session" sub={one.data?.session.place_key}>
    <div className="card"><table><thead><tr><th>Asked</th><th>Status</th><th>Receipt</th></tr></thead><tbody>{(one.data?.runs ?? []).map((r: any) => <tr key={r.id}><td>{r.asked}<div className="muted">{when(r.created_at)}</div></td><td><Status s={r.status} /></td><td className="mono">{r.receipt ?? "—"}</td></tr>)}</tbody></table></div>
  </Page>;
  return <Page title="Sessions" sub="Every conversation, with what each job cost.">
    <div className="card"><table><thead><tr><th>Where</th><th>Kind</th><th>Jobs</th><th>Last active</th></tr></thead><tbody>{(list.data?.sessions ?? []).map((s) => <tr key={s.id}><td><a href={`#/sessions/${s.id}`}>{(s as any).where ?? s.place_key}</a></td><td>{s.kind}</td><td>{s.runs}</td><td className="muted">{when(s.last_active_at)}</td></tr>)}</tbody></table></div>
  </Page>;
}

function People() {
  const { data } = useLoad<{ people: any[] }>("/v1/people");
  return <Page title="People" sub="Everyone who has asked a teammate for something, with what they've spent against their budget tier.">
    <div className="card"><table><thead><tr><th>Person</th><th>Slack</th><th>Spent</th><th>Tier</th></tr></thead><tbody>{(data?.people ?? []).map((p) => <tr key={p.id}><td>{p.display_name ?? "—"}</td><td className="mono">{p.slack_user}</td><td>{money(p.spend)}{p.cap != null && <span className="muted"> of {money(p.cap)}</span>}</td><td>{p.tier ?? "—"}</td></tr>)}</tbody></table></div>
  </Page>;
}

function ScheduleTable({ rows, reload }: { rows: any[]; reload: () => void }) {
  const [hook, setHook] = useState<any>(null);
  return <div className="card"><table><thead><tr><th>Name</th><th>Teammate</th><th>When</th><th>Last run</th><th /></tr></thead><tbody>
    {rows.map((s) => <tr key={s.id}><td>{s.name ?? s.id}<div className="muted">{s.kind}</div></td><td>{s.teammate}</td><td className="mono">{s.cron ?? (s.run_at ? when(s.run_at) : s.kind === "watch" ? `every ${s.filter?.every_hours ?? 1} h` : "on event")}</td><td className="muted">{when(s.last_run_at)}</td>
      <td className="row"><button className="ghost" onClick={() => post(`/v1/schedules/${s.id}/run`).then(reload)}>Run now</button><button className="ghost" onClick={() => api("PATCH", `/v1/schedules/${s.id}`, { enabled: !s.enabled }).then(reload)}>{s.enabled ? "Pause" : "Resume"}</button>{s.kind === "webhook" && <button className="ghost" onClick={() => get(`/v1/schedules/${s.id}/hook`).then(setHook)}>Hook</button>}</td></tr>)}
  </tbody></table>{!rows.length && <div className="muted">No schedules.</div>}{hook && <pre style={{ whiteSpace: "pre-wrap" }}>URL: {hook.url}{"\n"}Secret: {hook.secret}</pre>}</div>;
}
function Schedules() { const { data, reload } = useLoad<{ schedules: any[] }>("/v1/schedules"); return <Page title="Schedules and triggers" sub="Recurring jobs, one-time jobs, webhooks and watches. A run posts only when its teammate finds something worth saying."><ScheduleTable rows={data?.schedules ?? []} reload={reload} /></Page>; }

function ComputerCard({ c, reload }: { c: any; reload: () => void }) {
  return <div className="card stack">
    <div className="row"><b>{c.teammate}</b><span className="pill">{c.size}</span><Status s={c.state} /><span className="muted">disk reset {when(c.l2_reset_at)}</span></div>
    {c.builds?.length > 0 && <table><tbody>{c.builds.map((b: any) => <tr key={b.id}><td className="mono">{b.id}</td><td><Status s={b.status} /> {b.purpose}</td><td className="muted">{when(b.created_at)}</td><td className="muted">{b.error ?? ""}</td></tr>)}</tbody></table>}
    <div className="row"><button className="ghost" onClick={() => post(`/v1/teammates/${c.teammate}/computer/sleep`).then(reload)}>Sleep</button><button className="ghost" onClick={() => post(`/v1/teammates/${c.teammate}/computer/rebuild`).then(reload)}>Rebuild setup</button><button className="ember" onClick={() => confirm("Throw away this computer's working disk? Work in /workspace stays.") && post(`/v1/teammates/${c.teammate}/computer/reset`).then(reload)}>Reset disk</button></div>
  </div>;
}
function Computers() { const { data, reload } = useLoad<{ computers: any[] }>("/v1/computers", 10_000); return <Page title="Computers" sub="Each teammate's own Linux computer: its size, whether it's awake, and its setup builds."><div className="stack">{(data?.computers ?? []).filter((c) => !/^(eval-|vm-)/.test(c.teammate)).map((c) => <ComputerCard key={c.teammate} c={c} reload={reload} />)}</div></Page>; }

// Otari, mirrored: what this Peeblo uses there and how to change it. Configuration lives in Otari's dashboard.
function Otari() {
  const { data, error, reload } = useLoad<any>("/v1/otari");
  if (!data) return <Page title="Otari" error={error}>{null}</Page>;
  const pill = (v: boolean | null, on = "on", off = "off") => v == null ? <span className="pill">unknown</span> : v ? <span className="pill ok">{on}</span> : <span className="pill">{off}</span>;
  const signOut = () => { if (confirm("Disconnect Peeblo from your Otari dashboard? Teammates keep working; admin changes fall back to links.")) api("DELETE", "/v1/otari/session").then(reload); };
  const missing = data.roles.filter((r: string) => !data.routing_policies.includes(r));
  return <Page title="Otari" sub="Every model call, tool and budget runs through Otari. Change settings in Otari's dashboard; this page shows what Peeblo uses.">
    {!data.session ? <ConnectOtari onDone={reload} /> :
      <div className="card row" style={{ marginBottom: 16 }}><span className="pill ok">connected</span><span>as <b>{data.session.signed_in_as}</b> until {when(data.session.expires_at)}</span><button className="ghost" onClick={signOut}>Disconnect</button></div>}
    <div className="grid">
      <div className="card stack"><h3>Routing</h3><div>{data.session ? (missing.length ? <span className="pill bad">{missing.length} missing</span> : <span className="pill ok">in sync</span>) : <span className="pill">not connected</span>}</div>
        <div className="muted">One policy per role ({data.roles.join(", ")}), kept in sync by Peeblo from config/model-tiers.json: the model, Otari's fallback, and for heavy work a cheaper model once half its budget is used. Edit the file and restart to change them.</div>
        <a href={data.links.routing} target="_blank" rel="noreferrer">See them in Otari</a></div>
      <div className="card stack"><h3>Guardrail</h3><div>{pill(data.guardrail.enabled, "org-wide", "outside text only")} <span className="muted">{data.guardrail.profile}</span></div>
        <div className="muted">Peeblo checks text from outside the company (tickets, chats, web pages, files) with your Lakera guardrail in Otari. To screen every call instead, turn on the org guardrail in Otari → Guardrails.</div>
        <a href={data.links.guardrails} target="_blank" rel="noreferrer">Open guardrails in Otari</a></div>
      <div className="card stack"><h3>Traces</h3><div>{pill(data.trace_content, "content kept", "metadata only")}</div>
        <div className="muted">Every job shows in Otari → Sessions under its Slack place. With PEEBLO_TRACE_CONTENT=keep in .env, Otari also keeps each call's prompt and answer, for debugging; off by default.</div>
        <a href={data.links.sessions} target="_blank" rel="noreferrer">Open sessions in Otari</a></div>
      <div className="card stack"><h3>Web search</h3><div>{pill(data.web_search.enabled)}</div>
        <div className="muted">Teammates with the web tool search and read pages only when they choose to. Turn it on in Otari → Tools → Web search.</div>
        <a href={data.links.web_search} target="_blank" rel="noreferrer">Open web search in Otari</a></div>
      <div className="card stack"><h3>Connectors (MCP servers)</h3>
        <div className="muted">Add a server in Otari → Tools → MCP servers (Linear, GitHub, Stripe, Notion…). Then give it to a teammate by name in Slack ("give Ledger stripe, read only") or in its settings here.</div>
        <a href={data.links.mcp} target="_blank" rel="noreferrer">Open MCP servers in Otari</a></div>
      <div className="card stack"><h3>Budgets and keys</h3>
        <div className="muted">Each teammate has its own Otari key with a spend ceiling at its monthly budget; each Slack person is an Otari end user on a budget tier. Change tiers in Otari → Budgets.</div>
        <div className="row"><a href={data.links.dashboard} target="_blank" rel="noreferrer">Usage</a><a href={data.links.keys} target="_blank" rel="noreferrer">Keys</a><a href={data.links.budgets} target="_blank" rel="noreferrer">Budgets</a></div></div>
    </div>
  </Page>;
}

function Feedback() {
  const { data } = useLoad<{ feedback: any[] }>("/v1/feedback");
  return <Page title="Feedback" sub="👍 and 👎 on replies in Slack. They also become memory candidates the owner can verify.">
    <div className="card"><table><thead><tr><th /><th>Teammate</th><th>Asked</th><th>By</th><th>When</th></tr></thead><tbody>{(data?.feedback ?? []).map((f, i) => <tr key={i}><td>{f.vote === "up" ? "👍" : "👎"}</td><td>{f.teammate}</td><td>{f.asked}</td><td>{f.by ?? "—"}</td><td className="muted">{when(f.at)}</td></tr>)}</tbody></table>{!data?.feedback.length && <div className="muted">No feedback yet.</div>}</div>
  </Page>;
}

function Checks() {
  const { data, error, reload } = useLoad<{ checks: any[] }>("/v1/setup");
  const otari = useLoad<any>("/v1/otari");
  return <Page title="Checks" sub="Everything Peeblo needs, checked live (the same as ./peeblo check). Anything to fix says how." error={error}>
    {otari.data && !otari.data.session && <div style={{ marginBottom: 12 }}><ConnectOtari onDone={() => { otari.reload(); reload(); }} /></div>}
    <div className="row" style={{ marginBottom: 22 }}><button className="ghost" onClick={reload}>Check again</button></div>
    {!data && <div className="muted">Checking…</div>}
    {data && [["Otari", (n: string) => /^Otari/.test(n)], ["Slack", (n: string) => /slack|install|public URL/i.test(n)], ["This machine", () => true]].reduce((acc: { title: string; rows: any[] }[], [title, test]: any) => {
      const taken = new Set(acc.flatMap((g) => g.rows.map((r) => r.name)));
      acc.push({ title, rows: data.checks.filter((c) => !taken.has(c.name) && test(c.name)) }); return acc;
    }, []).map((g) => <section key={g.title} style={{ marginBottom: 18 }}><h3 style={{ marginBottom: 10 }}>{g.title} {g.rows.every((r) => r.ok) ? <span className="pill ok">all ok</span> : <span className="pill bad">{g.rows.filter((r) => !r.ok).length} to fix</span>}</h3>
      <div className="card"><table className="checks"><tbody>{g.rows.map((c) => <tr key={c.name}><td>{c.ok ? <span className="pill ok">ok</span> : <span className="pill bad">fix</span>}</td><td><b>{c.name.replace(/^Otari /, "")}</b></td><td>{c.detail}</td></tr>)}</tbody></table></div></section>)}
  </Page>;
}
