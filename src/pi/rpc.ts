// Our own Pi JSONL RPC client over any duplex. Pi's RpcClient can't answer extension dialogs (approvals)
// and only spawns a local process, so we speak the protocol directly: split on "\n" only (never U+2028),
// correlate commands by id, and answer extension_ui_request dialogs through a handler.
import type { Readable, Writable } from "node:stream";

export type PiEvent = { type: string; [k: string]: any };
export type DialogRequest = { id: string; method: "select" | "confirm" | "input" | "editor"; title: string; options?: string[]; timeout?: number };

export class PiRpc {
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private n = 0;
  private listeners = new Set<(e: PiEvent) => void>();
  private closed: Error | null = null;

  private stdin: Writable;
  private onDialog: (r: DialogRequest) => Promise<string | boolean | undefined>;

  constructor(stdin: Writable, stdout: Readable, onDialog: (r: DialogRequest) => Promise<string | boolean | undefined> = async () => undefined) {
    this.stdin = stdin;
    this.onDialog = onDialog;
    let buf = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.record(JSON.parse(line));
      }
    });
    stdout.on("close", () => this.fail(new Error("pi exited")));
  }

  private fail(e: Error): void {
    this.closed = e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const l of this.listeners) l({ type: "pi_exit", error: e.message });
  }

  private record(r: PiEvent): void {
    if (r.type === "response" && r.id && this.pending.has(r.id)) {
      const p = this.pending.get(r.id)!;
      this.pending.delete(r.id);
      return r.success ? p.resolve(r.data) : p.reject(new Error(`${r.command}: ${r.error}`));
    }
    if (r.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(r.method)) {
      void this.onDialog(r as unknown as DialogRequest).then((ans) =>
        this.write({ type: "extension_ui_response", id: r.id, ...(ans === undefined ? { cancelled: true } : r.method === "confirm" ? { confirmed: Boolean(ans) } : { value: ans }) }));
    }
    for (const l of this.listeners) l(r);
  }

  private write(o: unknown): void {
    this.stdin.write(JSON.stringify(o) + "\n");
  }

  on(l: (e: PiEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  send<T = any>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = `c${++this.n}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, type, ...fields });
    });
  }

  // Resolves on agent_settled (never agent_end: retries, compaction or follow-ups may still run).
  // waiting: true while the turn is waiting on a person (an approval card); that time doesn't count, so the timer
  // starts over each time it would fire during a wait.
  settled(timeoutMs: number, waiting?: () => Promise<boolean>): Promise<PiEvent> {
    return new Promise((resolve, reject) => {
      let t: ReturnType<typeof setTimeout>;
      const arm = () => { t = setTimeout(async () => {
        if (waiting && await waiting().catch(() => false)) return arm();
        off(); reject(new Error("turn timed out"));
      }, timeoutMs); };
      arm();
      const off = this.on((e) => {
        if (e.type === "agent_settled") { clearTimeout(t); off(); resolve(e); }
        if (e.type === "pi_exit") { clearTimeout(t); off(); reject(new Error(e.error)); }
      });
    });
  }
}
