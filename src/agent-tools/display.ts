// show_data: a sortable table, a chart, or a KPI strip in the reply (NIGHT_PLAN_NOV9 §6.5). The agent gives the
// numbers; code draws Slack's own blocks (data_table, data_visualization, layout) and the view puts them in the
// reply's message, after the answer and before the receipt. How to choose and label a chart is in the
// visualizing-data skill.
import { appendEvent } from "../store/events.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

// Cut at a word boundary with an ellipsis, never mid-word.
const cut = (s: unknown, n: number) => { const t = String(s ?? "").trim(); if (t.length <= n) return t; const w = t.slice(0, n - 1).replace(/\s+\S*$/, ""); return `${w || t.slice(0, n - 1)}…`; };
// Record ids mean nothing to a reader: "Atlas Skate Co (id 364419, Felix)" → "Atlas Skate Co (Felix)".
const noIds = (v: unknown) => String(v).replace(/\bid[:#]?\s*\d{5,}\b,?\s*/gi, "").replace(/\(\s*\)/g, "").replace(/\(\s*,\s*/g, "(").replace(/\s{2,}/g, " ").trim();
const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, "")));

function table(a: any): any[] | string {
  const cols: string[] = (a.columns ?? []).map((c: unknown) => cut(c, 60));
  const rows: unknown[][] = a.rows ?? [];
  // Slack's thread pane is narrow: three short columns fit, more get clipped.
  if (!cols.length || cols.length > 3) return "A table here fits at most 3 short columns (the thread pane is narrow). Merge or drop columns: put the name first, then the one or two numbers or dates that matter.";
  if (!rows.length || rows.length > 200) return "A table needs 1 to 200 rows (split a longer list, or summarise it).";
  if (rows.some((r) => !Array.isArray(r) || r.length !== cols.length)) return `Every row needs exactly ${cols.length} cells, one per column.`;
  // A column is numeric (sorts by value) when every cell in it is a number.
  const numeric = cols.map((_, i) => rows.every((r) => typeof r[i] === "number"));
  const cell = (v: unknown, i: number) => (numeric[i] ? { type: "raw_number", value: v as number, text: (v as number).toLocaleString("en-US") } : { type: "raw_text", text: cut(v === null || v === "" ? "–" : noIds(v), cols.length > 2 ? 28 : 40) });
  return [{ type: "data_table", caption: cut(a.title || "Table", 150), page_size: Math.min(Math.max(rows.length, 1), rows.length > 10 ? 10 : rows.length),
    rows: [cols.map((c) => ({ type: "raw_text", text: cut(c, 20) || "–" })), ...rows.map((r) => r.map(cell))] }];
}

function chart(a: any): any[] | string {
  const type = a.chart_type ?? "bar";
  if (!["bar", "line", "area", "pie"].includes(type)) return "chart_type is bar, line, area or pie.";
  const cats: string[] = (a.categories ?? []).map((c: unknown) => cut(c, 20));
  const series: { name: string; values: unknown[] }[] = a.series ?? [];
  if (!cats.length || cats.length > 20) return "A chart needs 1 to 20 categories (labels of 20 characters at most).";
  if (!series.length || series.length > 12) return "A chart needs 1 to 12 series.";
  if (series.some((s) => (s.values ?? []).length !== cats.length)) return `Every series needs exactly one value per category (${cats.length}).`;
  if (type === "pie") {
    const vals = series[0].values.map(num);
    if (vals.some((v) => !(v > 0))) return "Pie values must all be above zero.";
    return [{ type: "data_visualization", title: cut(a.title, 50), chart: { type: "pie", segments: cats.map((c, i) => ({ label: c, value: vals[i] })) } }];
  }
  const names = new Set<string>();
  const out = series.map((s) => {
    let name = cut(s.name || "Value", 20);
    while (names.has(name)) name = cut(`${name}′`, 20);
    names.add(name);
    return { name, data: cats.map((c, i) => ({ label: c, value: num(s.values[i]) })) };
  });
  if (out.some((s) => s.data.some((d) => !Number.isFinite(d.value)))) return "Every chart value must be a number.";
  return [{ type: "data_visualization", title: cut(a.title, 50), chart: { type, series: out, axis_config: { categories: cats, ...(a.x_label ? { x_label: cut(a.x_label, 50) } : {}), ...(a.y_label ? { y_label: cut(a.y_label, 50) } : {}) } } }];
}

function kpis(a: any): any[] | string {
  const items: { label: string; value: string; note?: string | null }[] = a.kpis ?? [];
  if (!items.length || items.length > 6) return "A KPI strip has 1 to 6 numbers.";
  const text = (k: (typeof items)[number]) => `*${cut(k.value, 30)}*\n${cut(k.label, 40)}${k.note ? `\n_${cut(k.note, 60)}_` : ""}`;
  const rows: any[] = [];
  for (let i = 0; i < items.length; i += 3) rows.push({ items: items.slice(i, i + 3).map((k) => ({ block: { type: "section", text: { type: "mrkdwn", text: text(k) } } })) });
  return [{ type: "layout", label: cut(a.title || "Key numbers", 150), is_label_visible: Boolean(a.title), rows, grid_lines: "none",
    fallback: [{ type: "context", elements: [{ type: "mrkdwn", text: items.map((k) => `*${cut(k.value, 30)}* ${cut(k.label, 40)}`).join(" · ").slice(0, 2900) }] }] }];
}

export const showDataTool: AgentTool = {
  name: "show_data",
  description: "Show numbers in your reply as Slack draws them: a sortable table (7+ records, or anything people will compare), a chart (bar, line, area or pie; a trend or a comparison), or a KPI strip (2–6 headline numbers). Give the data; Peeblo draws it under your answer. The visualizing-data skill says which to pick.",
  input_schema: object({
    kind: { type: "string", enum: ["table", "chart", "kpis"] },
    title: { type: "string", description: "A short title (a chart's is at most 50 characters)." },
    columns: { type: ["array", "null"], items: { type: "string" }, description: "Table: the column names." },
    rows: { type: ["array", "null"], items: { type: "array", items: { type: ["string", "number", "null"] } }, description: "Table: one array per row, one cell per column; use numbers for numeric cells so they sort." },
    chart_type: { type: ["string", "null"], enum: ["bar", "line", "area", "pie", null] },
    categories: { type: ["array", "null"], items: { type: "string" }, description: "Chart: the x-axis labels (or pie slices), at most 20 characters each." },
    series: { type: ["array", "null"], items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"], additionalProperties: false }, description: "Chart: 1–12 series, each with one value per category (a pie uses the first)." },
    x_label: { type: ["string", "null"] },
    y_label: { type: ["string", "null"] },
    kpis: { type: ["array", "null"], items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, note: { type: ["string", "null"] } }, required: ["label", "value", "note"], additionalProperties: false }, description: "KPI strip: 'MRR', '$12.4k', 'up 4% on October'." },
  }),
  kind: "read", // it only adds to the reply in this conversation
  async run(ctx, a) {
    const blocks = a.kind === "table" ? table(a) : a.kind === "chart" ? chart(a) : kpis(a);
    if (typeof blocks === "string") return { text: blocks, isError: true };
    await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.display", data: { kind: a.kind, title: a.title ?? null, blocks } });
    return { text: `Shown under your answer: ${a.kind === "table" ? `a table of ${(a.rows ?? []).length} rows` : a.kind === "chart" ? `a ${a.chart_type ?? "bar"} chart` : `${(a.kpis ?? []).length} key numbers`}. Don't repeat the numbers in your text; say what they mean.` };
  },
};
