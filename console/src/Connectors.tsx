// Connectors: the services teammates can use. Each is an MCP server in the owner's Otari; Peeblo shows its health,
// its tools and which teammates have it. Adding one happens in Otari, giving one to a teammate happens in Slack.
import { useState } from "react";
import type { Connector } from "./api";
import { Face, PEEBLO_FACE } from "./Face";
import { useLoad } from "./hooks";

type Data = { servers: Connector[]; add_url: string; otari_connected: boolean };

function Icon({ c }: { c: Connector }) {
  const [broken, setBroken] = useState(false);
  if (c.icon_url && !broken) return <img className="conn-icon" src={c.icon_url} alt="" onError={() => setBroken(true)} />;
  return <span className="conn-icon letter" aria-hidden="true">{(c.label || c.name).trim()[0]?.toUpperCase() ?? "?"}</span>;
}

const health = (h: boolean | null) => (h === true ? "Working" : h === false ? "Not responding" : "Not checked yet");

function Card({ c }: { c: Connector }) {
  return <div className="card conn stack">
    <div className="conn-head">
      <Icon c={c} />
      <div className="conn-title"><h3>{c.label || c.name}</h3>
        <span className="conn-meta"><span className={`dot ${c.healthy === true ? "ok" : c.healthy === false ? "bad" : ""}`} aria-hidden="true" />{health(c.healthy)}{c.tools != null && <> · {c.tools} tool{c.tools === 1 ? "" : "s"}</>}</span></div>
    </div>
    {c.purpose && <p className="muted conn-purpose">{c.purpose}</p>}
    <div className="conn-used">
      <div className="nav-label" style={{ padding: 0 }}>Used by</div>
      {c.used_by.length === 0
        ? <div className="muted">No teammate has it yet.</div>
        : <ul>{c.used_by.map((u) => <li key={u.slug}><a href={`#/teammate/${encodeURIComponent(u.slug)}`}><Face slug={u.slug} size={28} live={false} /><span>{u.name}</span></a>{u.read_only && <span className="muted"> (read only)</span>}</li>)}</ul>}
    </div>
  </div>;
}

export function Connectors() {
  const { data, error, reload } = useLoad<Data>("/v1/connectors");
  const [busy, setBusy] = useState(false);
  const refresh = () => { setBusy(true); reload(); setTimeout(() => setBusy(false), 600); };
  const servers = data?.servers ?? [];
  return <>
    <div className="page-head">
      <div><h1>Connectors</h1><p className="sub">The services your teammates can use, like Linear, GitHub or Notion. Each connector is an MCP server in your Otari; you choose which teammates get it.</p></div>
      <div className="row">{data?.add_url && <a className="btn" href={data.add_url} target="_blank" rel="noreferrer">Add a connector in Otari<span className="ext" aria-hidden="true">↗</span></a>}<button className="ghost" disabled={busy} onClick={refresh}>{busy ? "Refreshing…" : "Refresh"}</button></div>
    </div>
    <ol className="howto card">
      <li>In Otari, open <b>Tools → MCP servers → Add</b>.</li>
      <li>Come back here and press <b>Refresh</b>.</li>
      <li>In Slack, tell Peeblo: “give &lt;teammate&gt; &lt;connector&gt;, read only”.</li>
    </ol>
    {data && !data.otari_connected && <div className="notice">Connect your Otari dashboard to see each connector's health and tools. <a href="#/setup">Connect Otari</a></div>}
    {error && <div className="err" role="alert">{error}</div>}
    {data && servers.length === 0 && <div className="empty card stack">
      <Face slug="peeblo" face={PEEBLO_FACE} size={64} mood="thinking" />
      <h3>No connectors yet</h3>
      <p className="muted">Add the first one in Otari, then press Refresh. Teammates can use it as soon as you give it to them.</p>
    </div>}
    <div className="grid">{servers.map((c) => <Card key={c.name} c={c} />)}</div>
  </>;
}
