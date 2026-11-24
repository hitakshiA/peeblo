// A failed model call, said plainly for the reply in Slack. Otari's own words are kept: since 0.55 it says which
// providers failed and how when routing gives up, why the backups weren't tried, and the reason when every model
// rejected the request alike. Pi hands the error on as text, often "<status> <Otari's JSON body>".
export function explainError(raw: string): string {
  const text = raw.replace(/^(model error:\s*)+/i, "").trim();
  const status = Number(/\b([45]\d\d)\b/.exec(text)?.[1] ?? 0);
  const detail = otariDetail(text);
  if (!detail) return text.slice(0, 300) || "unknown error";
  const said = detail.replace(/\s+/g, " ").trim().slice(0, 400);
  if (status === 504 || /timed out/i.test(said)) return `Otari couldn't get an answer in time. ${said}`;
  if (status === 401) return `Otari didn't accept the key this call went out on. ${said}`;
  if (status === 402) return `The Otari account paying for this call has no credit left. ${said}`;
  if (status === 429) return `Otari is rate-limiting these calls right now. ${said}`;
  if (status >= 500 || status === 424) return `The model providers behind Otari failed. ${said}`;
  return `Otari refused the call. ${said}`;
}

// Otari's detail from a body: {"detail": "..."}, {"detail": {"message": "..."}} or {"error": {"message": "..."}}.
export function otariDetail(text: string): string | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try {
    const j = JSON.parse(text.slice(from, to + 1));
    const d = j?.detail ?? j?.error ?? j?.message;
    if (typeof d === "string") return d;
    if (typeof d?.message === "string") return d.message;
    if (Array.isArray(d) && typeof d[0]?.msg === "string") return d[0].msg;
    return null;
  } catch {
    return null;
  }
}
