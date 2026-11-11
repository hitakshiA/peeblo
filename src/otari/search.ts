// Search for memory recall: Otari embeddings and Otari rerank (Cohere's shape). Otari has no vector
// store, so callers keep their own vectors; this module only turns text into vectors and orders
// candidates. Measured on real notes, keyword candidates + rerank came within a hair of embeddings +
// rerank at half the latency, so rerank is the part that matters and embeddings are optional.
import { config } from "../config.ts";
import { otari } from "./client.ts";

// No `user` on these calls: with a service key, Otari answers 403 "'user' field does not match the authenticated
// API key's user" on /embeddings and /rerank (chat accepts it). endUser stays in the signatures for when it does.

const EMBED_MODEL = config.embedModel;
const RERANK_MODEL = config.rerankModel;
const EMBED_DIMS = config.embedDims;
// Qwen3 embeddings expect an instruction on queries (not on documents).
const QUERY_INSTRUCTION = "Instruct: Given a question from a teammate, find the notes that answer it\nQuery: ";

// _endUser is accepted but not sent: Otari refuses an end-user id on /embeddings and /rerank.
export async function embed(texts: string[], kind: "query" | "document", _endUser?: string): Promise<{ vectors: number[][]; requestId: string | null; cost: number | null }> {
  const input = kind === "query" && EMBED_MODEL.includes("qwen3-embedding") ? texts.map((t) => QUERY_INSTRUCTION + t) : texts;
  const { data, requestId } = await otari<{ data: { index: number; embedding: number[] }[]; usage?: { cost_usd?: string | number } }>("POST", "/embeddings", {
    model: EMBED_MODEL, input, dimensions: EMBED_DIMS,
  });
  const vectors = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return { vectors, requestId, cost: data.usage?.cost_usd === undefined ? null : Number(data.usage.cost_usd) };
}

type Ranked = { index: number; score: number };
async function rerank(query: string, documents: string[], topN = 5, _endUser?: string): Promise<{ results: Ranked[]; requestId: string | null; cost: number | null }> {
  if (!documents.length) return { results: [], requestId: null, cost: 0 };
  const { data, requestId } = await otari<{ results: { index: number; relevance_score: number }[]; usage?: { cost_usd?: string | number } }>("POST", "/rerank", {
    model: RERANK_MODEL, query, documents: documents.map((d) => d.slice(0, 4000)), top_n: Math.min(topN, documents.length),
  });
  return { results: data.results.map((r) => ({ index: r.index, score: r.relevance_score })), requestId, cost: data.usage?.cost_usd === undefined ? null : Number(data.usage.cost_usd) };
}

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

// Reciprocal rank fusion of several candidate lists (indexes into the same documents), k = 60.
export function fuse(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const l of lists) l.forEach((idx, rank) => { score.set(idx, (score.get(idx) ?? 0) + 1 / (k + rank + 1)); });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

// The last step of a search: Otari rerank over the top candidates the caller found (keyword, vectors or both).
export async function recall(query: string, documents: string[], candidates: number[], topN = 5, endUser?: string): Promise<{ hits: { index: number; score: number; text: string }[]; requestIds: string[]; cost: number; reranked: boolean }> {
  const pool = candidates.slice(0, 20);
  // When Otari's rerank is unavailable, the fused candidate order stands (still keyword + vector), marked as such.
  const r = await rerank(query, pool.map((i) => documents[i]), topN, endUser).catch(() => null);
  if (!r) return { hits: pool.slice(0, topN).map((i, n) => ({ index: i, score: 1 / (n + 1), text: documents[i] })), requestIds: [], cost: 0, reranked: false };
  return { hits: r.results.map((x) => ({ index: pool[x.index], score: x.score, text: documents[pool[x.index]] })), requestIds: r.requestId ? [r.requestId] : [], cost: r.cost ?? 0, reranked: true };
}
