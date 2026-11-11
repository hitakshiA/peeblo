// Many independent prompts at once, through Otari's batch API: classify 2,000 tickets, summarise every file in a
// folder, draft a reply per row. The provider runs them off the live path (within 24 hours, usually minutes) and the
// answers land in a file on the teammate's computer. Only open-weight models whose Otari provider takes batches;
// Otari refuses the rest and says so.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { config } from "../config.ts";
import { countTokens, estimateCost, isOpenWeight } from "../otari/catalog.ts";
import { otari, type OtariError } from "../otari/client.ts";
import { usd } from "../otari/spend.ts";
import { readComputerFile } from "./media.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

// Measured on Otari (Nov 2026): Kimi K3.1 Pro (served by Together) runs a batch end to end. Mistral's models accept a
// batch, but Otari can't read their results back yet (502), so they aren't the default.
const DEFAULT_MODEL = "moonshotai/kimi-k3.1-pro";
const MAX_ITEMS = 2000;
const DEFAULT_MAX_TOKENS = 4000; // reasoning models spend part of it thinking

type Item = { id: string; prompt: string };
type Manifest = {
  batch_id: string;
  provider: string;
  model: string;
  name: string;
  created_at: string;
  session_id: string;
  max_tokens: number;
  results: string; // /workspace path the answers are written to
  items: Item[];
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "batch";

async function folder(ctx: ToolContext): Promise<string> {
  const { workspaceOf } = await import("../environment/controller.ts");
  const dir = join(workspaceOf(ctx.teammate.slug), "batches");
  await mkdir(dir, { recursive: true });
  return dir;
}

// The prompts: given inline, or read from a file on the computer. A .jsonl or .json file holds strings or
// {"id", "prompt"} objects; any other file is one prompt per line.
export function parseItems(text: string, ext: string): Item[] {
  const asItem = (x: unknown, i: number): Item | null => {
    if (typeof x === "string") return x.trim() ? { id: `r${i + 1}`, prompt: x } : null;
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const prompt = o.prompt ?? o.text ?? o.input;
      if (typeof prompt !== "string" || !prompt.trim()) return null;
      return { id: o.id === undefined || o.id === null ? `r${i + 1}` : String(o.id), prompt };
    }
    return null;
  };
  let raw: unknown[];
  if (ext === ".json") {
    const v = JSON.parse(text);
    raw = Array.isArray(v) ? v : [];
  } else if (ext === ".jsonl")
    raw = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  else raw = text.split("\n");
  const items = raw.map(asItem).filter((x): x is Item => x !== null);
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new Error(`the id "${it.id}" is used twice; each prompt needs its own`);
    seen.add(it.id);
  }
  return items;
}

async function itemsOf(ctx: ToolContext, a: any): Promise<Item[]> {
  if (Array.isArray(a.prompts) && a.prompts.length) return parseItems(JSON.stringify(a.prompts), ".json");
  if (!a.file) throw new Error("give the prompts, or a file on your computer that holds them");
  const text = (await readComputerFile(ctx, String(a.file))).toString("utf8");
  return parseItems(text, extname(String(a.file)).toLowerCase());
}

// The most a batch could cost: every prompt's tokens in, and every answer using its whole allowance.
async function estimate(model: string, items: Item[], instructions: string, maxTokens: number): Promise<number | null> {
  const inTokens =
    (await countTokens(model, items.map((x) => x.prompt).join("\n"))) +
    items.length * (instructions ? await countTokens(model, instructions) : 0);
  return estimateCost(model, inTokens, items.length * maxTokens);
}

const inputCache = new Map<string, Item[]>(); // the gate reads the file once; run reuses it

export const batchRunTool: AgentTool = {
  name: "batch_run",
  description:
    "Run the same kind of task over many inputs at once (classify 500 tickets, summarise every file, draft a reply per row) as one Otari batch: cheaper on the live path, answered within minutes to hours. Give the prompts, or a file on your computer (.jsonl/.json of strings or {id, prompt}, or one prompt per line), and instructions that apply to each. Then call batch_results to wait for the answers, which are saved as a file. For a handful of prompts, just answer them yourself.",
  input_schema: object({
    instructions: {
      type: ["string", "null"],
      description:
        "What to do with each input, the same for all, e.g. 'Label this ticket billing, bug or other. Answer with the label only.'",
    },
    prompts: {
      type: ["array", "null"],
      maxItems: 200,
      items: { type: "string" },
      description: "The inputs, when there are few enough to list.",
    },
    file: { type: ["string", "null"], description: "Or a file on your computer holding the inputs, e.g. /workspace/out/tickets.jsonl" },
    name: { type: ["string", "null"], description: "A short name, e.g. ticket-labels." },
    max_tokens: {
      type: ["integer", "null"],
      minimum: 300,
      maximum: 32000,
      description: `The longest one answer may be, in tokens, thinking included: the model reasons first, so even a one-word label needs about 300. Default ${DEFAULT_MAX_TOKENS}.`,
    },
    model: {
      type: ["string", "null"],
      description: `An open-weight catalog model whose provider takes batches. Default ${DEFAULT_MODEL}.`,
    },
  }),
  kind: "read",
  deferred: true,
  authorize(_ctx, a) {
    const model = a.model ?? DEFAULT_MODEL;
    return isOpenWeight(model) ? null : `${model} isn't an open-weight model; batches run on open-weight models only.`;
  },
  async gate(ctx, a) {
    let items: Item[];
    try {
      items = await itemsOf(ctx, a);
    } catch (e) {
      return { deny: `Couldn't read the inputs: ${(e as Error).message.slice(0, 200)}` };
    }
    if (!items.length) return { deny: "There are no inputs to run." };
    if (items.length > MAX_ITEMS) return { deny: `That's ${items.length} inputs; one batch takes up to ${MAX_ITEMS}. Split it.` };
    inputCache.set(ctx.toolCallId, items);
    const model = a.model ?? DEFAULT_MODEL;
    const est = await estimate(model, items, String(a.instructions ?? ""), a.max_tokens ?? DEFAULT_MAX_TOKENS);
    if (est === null) return { deny: `${model} has no price in Otari's catalog, so it can't run.` };
    return est > config.priceCardUsd ? { ask: `This batch of ${items.length} prompts would cost at most ${usd(est)} on ${model}.` } : null;
  },
  async run(ctx, a) {
    const items = inputCache.get(ctx.toolCallId) ?? (await itemsOf(ctx, a));
    inputCache.delete(ctx.toolCallId);
    const model = a.model ?? DEFAULT_MODEL;
    const maxTokens = a.max_tokens ?? DEFAULT_MAX_TOKENS;
    const instructions = String(a.instructions ?? "").trim();
    const name = slug(String(a.name ?? "batch"));
    const requests = items.map((it) => ({
      custom_id: it.id,
      body: {
        messages: [...(instructions ? [{ role: "system", content: instructions }] : []), { role: "user", content: it.prompt }],
        max_tokens: maxTokens,
      },
    }));
    const auth = ctx.otariKey ? { auth: { authorization: `Bearer ${ctx.otariKey.secret}` } } : {};
    let r: Awaited<ReturnType<typeof otari<any>>>;
    try {
      r = await otari<any>(
        "POST",
        "/batches",
        // No `user`: /batches refuses an end-user id (403), like /images and /embeddings; the teammate's key pays.
        { model, requests, metadata: { peeblo_session: ctx.sessionId, name } },
        { ...auth, timeoutMs: 120_000, retries: 0 },
      );
    } catch (e) {
      return {
        text: `Otari didn't take the batch: ${(e as Error).message.slice(0, 300)}`,
        isError: true,
        data: { request_id: (e as OtariError).requestId },
      };
    }
    const id = String(r.data?.id ?? "");
    const provider = String(r.data?.provider ?? "");
    if (!id || !provider)
      return { text: "Otari answered without a batch id; nothing was sent.", isError: true, data: { request_id: r.requestId } };
    const results = `/workspace/batches/${name}-${id.slice(0, 8)}.results.jsonl`;
    const manifest: Manifest = {
      batch_id: id,
      provider,
      model,
      name,
      created_at: new Date().toISOString(),
      session_id: ctx.sessionId,
      max_tokens: maxTokens,
      results,
      items,
    };
    await writeFile(join(await folder(ctx), `${name}-${id.slice(0, 8)}.json`), JSON.stringify(manifest, null, 2));
    return {
      text: `Sent ${items.length} prompts to ${model} as one Otari batch (${id}, run by ${provider}). It usually finishes in minutes, at most 24 hours. Call batch_results with this id to wait for the answers; they'll be saved at ${results}.`,
      data: { batch_id: id, provider, model, count: items.length, results, request_id: r.requestId },
    };
  },
};

async function manifestOf(ctx: ToolContext, batchId: string): Promise<{ m: Manifest; file: string } | null> {
  const dir = await folder(ctx);
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    const m = JSON.parse(await readFile(join(dir, f), "utf8").catch(() => "{}")) as Manifest;
    if (m.batch_id === batchId || (batchId.length >= 8 && m.batch_id?.startsWith(batchId))) return { m, file: join(dir, f) };
  }
  return null;
}

const DONE = new Set(["completed", "failed", "expired", "cancelled"]);

export const batchResultsTool: AgentTool = {
  name: "batch_results",
  description:
    "Check on a batch from batch_run, wait for it (up to an hour per call), and save its answers to a file on your computer when it's done: one JSON line per input with id, prompt, answer and any error. Read the file with your computer tools. cancel: true stops a batch nobody needs any more.",
  input_schema: object({
    batch_id: { type: "string" },
    wait_minutes: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 60,
      description: "How long to wait for it to finish. Default 10; 0 just checks.",
    },
    cancel: { type: ["boolean", "null"] },
  }),
  kind: "read",
  deferred: true,
  async run(ctx, a) {
    const found = await manifestOf(ctx, String(a.batch_id));
    if (!found)
      return { text: `There's no batch ${a.batch_id} on this teammate's computer (batch_run saves one when it sends it).`, isError: true };
    const { m } = found;
    const auth = ctx.otariKey ? { auth: { authorization: `Bearer ${ctx.otariKey.secret}` } } : {};
    const q = `?provider=${encodeURIComponent(m.provider)}`;
    if (a.cancel) {
      await otari("POST", `/batches/${m.batch_id}/cancel${q}`, {}, { ...auth, retries: 0 });
      return { text: `Asked Otari to cancel batch ${m.batch_id}. Answers already made are still billed.` };
    }
    const until = Date.now() + (a.wait_minutes ?? 10) * 60_000;
    let b: any;
    for (;;) {
      b = (await otari<any>("GET", `/batches/${m.batch_id}${q}`, undefined, auth)).data;
      if (DONE.has(b.status) || Date.now() >= until) break;
      await new Promise((res) => setTimeout(res, Math.min(20_000, Math.max(1000, until - Date.now()))));
    }
    const counts = b.request_counts
      ? ` (${b.request_counts.completed ?? 0} done, ${b.request_counts.failed ?? 0} failed of ${b.request_counts.total ?? m.items.length})`
      : "";
    if (!DONE.has(b.status))
      return {
        text: `Batch ${m.batch_id} is still ${b.status}${counts}. Call batch_results again to keep waiting.`,
        data: { status: b.status },
      };
    if (b.status !== "completed")
      return {
        text: `Batch ${m.batch_id} ended ${b.status}${counts}${b.errors ? `: ${JSON.stringify(b.errors).slice(0, 300)}` : ""}.`,
        isError: true,
      };
    let out: any;
    try {
      out = (await otari<any>("GET", `/batches/${m.batch_id}/results${q}`, undefined, { ...auth, timeoutMs: 120_000 })).data;
    } catch (e) {
      return {
        text: `The batch finished, but Otari couldn't fetch its answers from ${m.provider}: ${(e as Error).message.slice(0, 200)}. Try again later.`,
        isError: true,
      };
    }
    const prompts = new Map(m.items.map((x) => [x.id, x.prompt]));
    let cost = 0;
    let priced = true;
    const rows = (out?.results ?? []).map((x: any) => {
      const c = x.result?.choices?.[0];
      const answer = typeof c?.message?.content === "string" ? c.message.content : null;
      const u = x.result?.usage;
      return {
        id: x.custom_id,
        prompt: prompts.get(x.custom_id) ?? null,
        answer,
        error: x.error
          ? JSON.stringify(x.error).slice(0, 300)
          : answer === null
            ? c?.finish_reason === "length"
              ? "ran out of room: raise max_tokens"
              : "no answer"
            : null,
        tokens: u ? { in: u.prompt_tokens, out: u.completion_tokens } : null,
      };
    });
    for (const r of rows) {
      const c = r.tokens ? await estimateCost(m.model, r.tokens.in ?? 0, r.tokens.out ?? 0) : null;
      if (c === null) priced = false;
      else cost += c;
    }
    const { workspaceOf } = await import("../environment/controller.ts");
    await writeFile(
      join(workspaceOf(ctx.teammate.slug), m.results.slice("/workspace/".length)),
      `${rows.map((r: unknown) => JSON.stringify(r)).join("\n")}\n`,
    );
    const failed = rows.filter((r: any) => r.error).length;
    const preview = rows
      .filter((r: any) => r.answer)
      .slice(0, 3)
      .map((r: any) => `${r.id}: ${String(r.answer).replace(/\s+/g, " ").slice(0, 160)}`)
      .join("\n");
    return {
      text: `Batch ${m.batch_id} is done: ${rows.length - failed} answers${failed ? `, ${failed} without one (see error)` : ""}${priced ? `, about ${usd(cost)} at catalog prices` : ""}. Saved at ${m.results}.${preview ? `\nFirst answers:\n${preview}` : ""}`,
      untrusted: "batch answers",
      data: { results: m.results, answered: rows.length - failed, failed, cost_usd: priced ? cost : null },
    };
  },
};
