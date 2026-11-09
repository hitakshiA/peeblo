// Files a text-only teammate can't read itself, understood through Otari: a voice note is transcribed, a PDF or an
// image is read, by the best open-weight model Otari's catalog lists for that kind of input (input_modalities), with
// the next one as a fallback. Optional: the agent calls it when a file in the conversation matters to the answer.
// The teammate's computer does what it is good at first (turning an m4a into a wav with ffmpeg); Otari does the
// understanding. Spreadsheets, CSVs and Word files stay with the computer or run_code, which read them exactly.
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { otari, OtariError } from "../otari/client.ts";
import { isOpenWeight, tierOf } from "../otari/catalog.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

type Kind = "audio" | "pdf" | "image";
const KINDS: Record<string, Kind> = {
  wav: "audio", mp3: "audio", m4a: "audio", mp4a: "audio", aac: "audio", ogg: "audio", oga: "audio", opus: "audio", webm: "audio", flac: "audio",
  pdf: "pdf", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
};
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
// Measured on Otari (Nov 2026): first choices per kind. Everything else the catalog lists for the kind follows,
// best quality tier first. MiMo V2.6 Flash lists audio but answers it with empty text, so it comes last.
const PREFERRED: Record<Kind, string[]> = {
  audio: ["xiaomi/mimo-v2.6-pro"],
  pdf: ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "mistralai/mistral-small-latest"],
  image: ["deepseek/deepseek-v4.1-flash", "moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3-flash"],
};
const LAST = new Set(["xiaomi/mimo-v2.6-flash"]);
const MAX_BYTES = 20 * 1024 * 1024;

// Otari's catalog, every page, cached for an hour: which models take which inputs.
let catalog: { at: number; models: { id: string; input_modalities?: string[]; deprecated?: boolean }[] } | null = null;
async function catalogModels() {
  if (catalog && Date.now() - catalog.at < 3_600_000) return catalog.models;
  const models: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r: { data: any } = await otari<any>("GET", `/catalog/models?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    models.push(...(r.data?.data ?? r.data?.models ?? []));
    cursor = r.data?.next_cursor ?? null;
    if (!cursor || !r.data?.has_more) break;
  }
  catalog = { at: Date.now(), models };
  return models;
}
export async function modelsFor(kind: Kind): Promise<string[]> {
  const rank = (id: string) => "SABCDE".indexOf(tierOf(id)?.tier ?? "E");
  const able = (await catalogModels()).filter((m) => !m.deprecated && isOpenWeight(m.id) && (m.input_modalities ?? []).includes(kind)).map((m) => m.id);
  const rest = able.filter((id) => !PREFERRED[kind].includes(id) && !LAST.has(id)).sort((a, b) => rank(a) - rank(b));
  return [...PREFERRED[kind].filter((id) => able.includes(id) || kind === "pdf"), ...rest, ...able.filter((id) => LAST.has(id))].slice(0, 4);
}

// A file on the teammate's computer: the shared /workspace folder is read directly; anything else (e.g. a saved
// connector result under /work) is read from the computer.
export async function readComputerFile(ctx: ToolContext, path: string): Promise<Buffer> {
  const p = normalize(path);
  if (p.startsWith("/workspace/")) {
    const { workspaceOf } = await import("../environment/controller.ts");
    return readFile(join(workspaceOf(ctx.teammate.slug), p.slice("/workspace/".length)));
  }
  const { exec } = await import("../environment/controller.ts");
  const r = await exec(ctx.teammate.id, ["/bin/sh", "-c", `[ $(stat -c %s "$1") -le ${MAX_BYTES} ] && base64 -w0 "$1"`, "sh", p], { sessionId: ctx.sessionId, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `couldn't read ${p} (missing, or over 20 MB)`);
  return Buffer.from(r.stdout, "base64");
}

// Voice notes come as m4a, ogg or webm; Otari takes wav or mp3. The computer converts (ffmpeg), the file stays there.
async function asWav(ctx: ToolContext, path: string): Promise<Buffer> {
  const { exec } = await import("../environment/controller.ts");
  const out = `/tmp/peeblo-audio-${Date.now()}.wav`;
  const r = await exec(ctx.teammate.id, ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", out], { sessionId: ctx.sessionId, timeoutMs: 120_000 });
  if (r.exitCode !== 0) throw new Error(`the computer couldn't convert the audio: ${r.stderr.slice(0, 200)}`);
  return readComputerFile(ctx, out);
}

export const understandFileTool: AgentTool = {
  name: "understand_file",
  description: "Have Otari's best model for the job read a file you can't read yourself: transcribe a voice note or audio clip, read a PDF (text, tables, scans), or look at an image or screenshot. Give the file's path (files people share are saved on your computer) and what you need from it. Use it only when the file matters to the answer. CSVs, spreadsheets and Word files are better read exactly on your computer or with run_code.",
  input_schema: object({
    path: { type: "string", description: "The file's path on your computer, e.g. /workspace/sessions/…/files/note.m4a" },
    question: { type: "string", description: "What you need: \"transcribe it\", \"the total and due date\", \"what does the error say\"." },
  }),
  kind: "read",
  async run(ctx, a) {
    const ext = String(a.path).split(".").pop()?.toLowerCase() ?? "";
    const kind = KINDS[ext];
    if (!kind) return { text: `${ext ? `.${ext}` : "That"} isn't a voice note, PDF or image. Read it on your computer (or with run_code for tables).`, isError: true };
    let bytes: Buffer;
    try { bytes = kind === "audio" && ext !== "wav" && ext !== "mp3" ? await asWav(ctx, a.path) : await readComputerFile(ctx, a.path); }
    catch (e) { return { text: `Couldn't open ${a.path}: ${(e as Error).message}`, isError: true }; }
    if (bytes.length > MAX_BYTES) return { text: "That file is over 20 MB; ask for a shorter clip or fewer pages.", isError: true };
    const b64 = bytes.toString("base64");
    const part = kind === "audio" ? { type: "input_audio", input_audio: { data: b64, format: ext === "mp3" ? "mp3" : "wav" } }
      : kind === "pdf" ? { type: "file", file: { filename: String(a.path).split("/").pop(), file_data: `data:application/pdf;base64,${b64}` } }
      : { type: "image_url", image_url: { url: `data:${MIME[ext]};base64,${b64}` } };
    // Names the transcriber would otherwise mishear ("Rivet" as "Ravi"): the crew and the people Peeblo knows.
    const names = kind === "audio" ? await knownNames().catch(() => "") : "";
    const ask = kind === "audio" && /transcri/i.test(a.question) ? `Transcribe this word for word. Reply with the transcript only.${names ? ` Names you may hear: ${names}.` : ""}` : `${a.question}${names ? `\nNames you may hear: ${names}.` : ""}\nAnswer from the file only; say plainly if it doesn't show it.`;
    const auth = ctx.otariKey ? { auth: { authorization: `Bearer ${ctx.otariKey.secret}` } } : {};
    const tried: string[] = [];
    for (const model of await modelsFor(kind).catch(() => PREFERRED[kind])) {
      tried.push(model);
      try {
        const r = await otari<any>("POST", "/chat/completions", { model, max_tokens: 1500, temperature: 0, ...(ctx.endUser ? { user: ctx.endUser } : {}), messages: [{ role: "user", content: [{ type: "text", text: ask }, part] }] }, { ...auth, timeoutMs: 90_000, retries: 0 });
        const text = String(r.data?.choices?.[0]?.message?.content ?? "").trim();
        if (!text) continue;   // an empty answer is a failure: try the next model
        return { text: `${kind === "audio" ? "Transcript" : "From the file"} (read by ${model} through Otari):\n${text.slice(0, 8000)}`, untrusted: `file:${kind}`, data: { model, request_id: r.requestId, cost_usd: r.data?.usage?.cost_usd ?? null, tried } };
      } catch (e) { if ((e as OtariError).status === 403) return { text: `Otari refused: ${(e as Error).message.slice(0, 200)}`, isError: true }; }
    }
    return { text: `No model could read it (tried ${tried.join(", ")}). Say so plainly${kind === "audio" ? " and ask them to type the gist" : ""}.`, isError: true, data: { tried } };
  },
};

async function knownNames(): Promise<string> {
  const { listTeammates } = await import("../store/teammates.ts");
  const { pool } = await import("../db.ts");
  const crew = (await listTeammates()).filter((t) => !(t as any).hidden).map((t) => t.config.name);
  const people = (await pool.query<{ display_name: string }>("SELECT DISTINCT display_name FROM people WHERE display_name IS NOT NULL LIMIT 40")).rows.map((r) => r.display_name.split(" ")[0]);
  return [...new Set([...crew, ...people])].slice(0, 40).join(", ");
}
