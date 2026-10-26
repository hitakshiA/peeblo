import { EventEmitter } from "node:events";
import { db, now } from "./store.ts";

// Run events for the UI: persisted for replay, broadcast live over SSE.
db.exec(`CREATE TABLE IF NOT EXISTS run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS run_events_case ON run_events(case_id, seq);`);

export interface RunEvent { seq: number; case_id: string; run_id?: string; type: string; data: any; at: string }
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export function emit(caseId: string, runId: string | undefined, type: string, data: unknown) {
  const at = now();
  const res = db.prepare("INSERT INTO run_events (case_id, run_id, type, data, at) VALUES (?,?,?,?,?)").run(caseId, runId ?? null, type, JSON.stringify(data), at);
  const event: RunEvent = { seq: Number(res.lastInsertRowid), case_id: caseId, run_id: runId, type, data, at };
  bus.emit("event", event);
  return event;
}

export function replay(caseId: string, afterSeq = 0): RunEvent[] {
  return (db.prepare("SELECT * FROM run_events WHERE case_id = ? AND seq > ? ORDER BY seq").all(caseId, afterSeq) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

// Which external apps a tool call touches, for the app rail in the UI.
export function appsFor(tool: string, input: any): string[] {
  switch (tool) {
    case "find_customer": return ["stripe", "quickbooks", "salesforce", "hubspot"];
    case "get_billing_state": return [input?.stripe_customer_id && "stripe", input?.qbo_customer_id && "quickbooks"].filter(Boolean) as string[];
    case "find_invoice": return ["stripe", "quickbooks"];
    case "ar_worklist": return ["quickbooks", "stripe"];
    case "get_crm_context": return [input?.salesforce_account_id && "salesforce", input?.hubspot_company_id && "hubspot"].filter(Boolean) as string[];
    case "get_conversations": return ["hubspot"];
    case "read_policy": return ["notion"];
    case "search_documents": case "read_document": return ["dropbox"];
    case "search_jira": return ["jira"];
    case "read_slack": return ["slack"];
    default: {
      const direct = tool.match(/^(stripe|qbo|hubspot|jira|slack|customer|billing)_/);
      if (direct) return [{ qbo: "quickbooks", customer: "hubspot", billing: "stripe" }[direct[1]] ?? direct[1]];
      if (tool !== "propose_action") return ["peeblo"];
    }
    // falls through
    case "propose_action": {
      const app = String(input?.action ?? "").split(".")[0];
      return [{ qbo: "quickbooks", customer: "hubspot" }[app] ?? app];
    }
  }
}
