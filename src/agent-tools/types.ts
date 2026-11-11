// Peeblo's own agent tools. The model chooses when to call them; the harness fills in everything it already
// knows (who is asking, who pays, which session and run), checks the arguments, and gates writes.
import type { Person } from "../store/people.ts";
import type { Teammate } from "../store/teammates.ts";
import type { Schema } from "./schema.ts";

export type ToolContext = {
  teammate: Teammate; // the session's pinned config
  person: Person | null; // who asked (the run's submitter)
  sessionId: string;
  runId: string | null;
  endUser: string | null; // who pays
  toolCallId: string;
  otariKey: { keyId: string; secret: string } | null; // the teammate's own Otari key, if it has one
  subagent: boolean; // a read-only subagent session
};

// `endTurn`: the turn stops after this tool batch (a reply posted, a job handed off); no extra model call.
export type ToolResult = { text: string; isError?: boolean; data?: unknown; untrusted?: string; endTurn?: boolean };

export type AgentTool = {
  name: string;
  description: string;
  input_schema: Schema;
  // read: runs at once. write: always waits for a person (Otari settings), after an authority check.
  // local: changes only the teammate's own computer; no card, but one at a time.
  kind: "read" | "write" | "local";
  // Who may call it at all; returns a refusal sentence, or null.
  authorize?: (ctx: ToolContext, args: any) => Promise<string | null> | string | null;
  // The rule engine for this exact call: deny refuses; ask waits for a person; null goes ahead.
  gate?: (ctx: ToolContext, args: any) => Promise<{ deny?: string; ask?: string } | null>;
  // What the approval card shows (writes only).
  describe?: (ctx: ToolContext, args: any) => Promise<Record<string, unknown>> | Record<string, unknown>;
  run: (ctx: ToolContext, args: any) => Promise<ToolResult>;
  // Own tools that act outside the conversation (push, hand a job on, set up a schedule): the risk class for this call,
  // or null when this call doesn't (a list, a pause). The gate then treats it like a connector write: the mode
  // rule, the reviewer in Auto, a card (src/proxy/tools.ts).
  outward?: (
    ctx: ToolContext,
    args: any,
  ) => Promise<"write" | "shipping" | "outside_thread" | null> | "write" | "shipping" | "outside_thread" | null;
  // Found with find_tools and called through use_tool, instead of declared at session start (fewer than 20 up front).
  deferred?: boolean;
};
