// Lists every connector tool Peeblo treats as a write or destructive, by server (from the live catalog path).
const { pool } = await import("../../src/db.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { catalogFor, classify } = await import("../../src/connectors/mcp.ts");
const cat = await catalogFor((await getTeammate("peeblo"))!.config);
const by = new Map<string, { w: string[]; d: string[]; r: number }>();
for (const t of cat.tools) {
  const k = classify(t, {});
  const e = by.get(t.server) ?? { w: [], d: [], r: 0 };
  if (k === "read") e.r++; else (k === "write" ? e.w : e.d).push(t.tool);
  by.set(t.server, e);
}
let reads = 0, writes = 0, destr = 0;
for (const [s, e] of [...by].sort()) {
  reads += e.r; writes += e.w.length; destr += e.d.length;
  console.log(`${s}: ${e.r} reads${e.w.length ? `; writes: ${e.w.join(", ")}` : ""}${e.d.length ? `; destructive: ${e.d.join(", ")}` : ""}`);
}
console.log(`\ntotal: ${reads} reads, ${writes} writes, ${destr} destructive of ${cat.tools.length}`);
await pool.end(); process.exit(0);
