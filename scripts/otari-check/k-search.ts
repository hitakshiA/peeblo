// Seam K: embeddings and rerank for memory recall, on a handful of real acme facts.
import { check, expect, save } from "./harness.ts";
import { cosine, embed, fuse, recall, rerank, EMBED_DIMS } from "../../src/otari/search.ts";

const S = "K";
const notes = [
  "Decision (Oct 30): annual plans can be refunded within 30 days of purchase; after that, credit only.",
  "Oct 14 incident: checkout returned 500s from 14:02 to 14:49 UTC after the v2.31.0 deploy; rolled back.",
  "Pricing page v3 shipped Nov 2. Mobile Safari signups fell from about 66% to 40% since then (sticky footer bug).",
  "Moss & Pine reported webhooks arriving 20 to 40 minutes late; tracked as SUP-4.",
  "The weekly growth update goes to #growth every Monday at 9:00, written by Maya.",
  "Northwind Trading is on the annual Shop API Pro plan with 2 extra seats invoiced.",
];
const question = "Can a customer get their money back on a yearly plan?";

await check(S, `embeddings with ${EMBED_DIMS} dimensions`, async (c) => {
  const d = await embed(notes, "document");
  const q = await embed([question], "query");
  c.ids.push(d.requestId!, q.requestId!);
  expect(d.vectors.length === notes.length && d.vectors[0].length === EMBED_DIMS, `got ${d.vectors.length}×${d.vectors[0]?.length}`);
  const best = d.vectors.map((v, i) => [i, cosine(q.vectors[0], v)] as const).sort((a, b) => b[1] - a[1])[0][0];
  c.note("nearest", notes[best].slice(0, 60));
  c.note("cost_usd", d.cost);
  expect(best === 0, `nearest note was #${best}`);
});

await check(S, "rerank puts the refund decision first", async (c) => {
  const r = await rerank(question, notes, 3);
  c.ids.push(r.requestId!);
  expect(r.results[0].index === 0, `top was #${r.results[0].index}`);
  c.note("scores", r.results.map((x) => [x.index, Number(x.score.toFixed(3))]));
  c.note("cost_usd", r.cost);
});

await check(S, "recall: fused candidates, then rerank", async (c) => {
  const keyword = [5, 0, 2]; // what a keyword search for "annual plan" would return
  const d = await embed(notes, "document");
  const q = await embed([question], "query");
  const byVector = d.vectors.map((v, i) => [i, cosine(q.vectors[0], v)] as const).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const r = await recall(question, notes, fuse([keyword, byVector]), 2);
  c.ids.push(...r.requestIds);
  expect(r.hits[0].index === 0, `top was #${r.hits[0].index}`);
  c.note("hits", r.hits.map((h) => h.text.slice(0, 50)));
});
process.exit((await save(S)) ? 0 : 1);
