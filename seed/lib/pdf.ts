// Tiny dependency-free PDF writer: Letter size, Helvetica, word-wrapped, multi-page, real text.

const W = 612, H = 792, MARGIN = 72, SIZE = 10.5, LEAD = 14, TITLE_SIZE = 15;
const MAX_CHARS = 92; // conservative for Helvetica 10.5pt across 468pt

const MAP: Record<string, string> = {
  "—": "--", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "-",
  "×": "x", "≥": ">=", "≤": "<=", "…": "...", " ": " ", "→": "->", "·": "-",
};

export function ascii(s: string): string {
  return s
    .replace(/[^\x20-\x7e\n]/g, (c) => MAP[c] ?? (c.normalize("NFKD").replace(/[^\x20-\x7e]/g, "") || "?"));
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const indent = raw.match(/^\s*/)![0];
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = indent;
    for (const w of words) {
      if (line.trim() && (line + " " + w).length > max) { out.push(line); line = indent + "  "; }
      line += (line.trim() ? " " : "") + w;
      while (line.length > max) { out.push(line.slice(0, max)); line = indent + "  " + line.slice(max); }
    }
    out.push(line);
  }
  return out;
}

export function renderPdf(title: string, paragraphs: string[]): Uint8Array {
  type Item = { text: string; size: number; bold?: boolean; gap?: number };
  const items: Item[] = [];
  for (const l of wrap(ascii(title), 60)) items.push({ text: l, size: TITLE_SIZE, bold: true });
  items[items.length - 1].gap = 10;
  for (const p of paragraphs) {
    const lines = wrap(ascii(p), MAX_CHARS);
    lines.forEach((l, i) => items.push({ text: l, size: SIZE, gap: i === lines.length - 1 ? 6 : 0 }));
  }

  // Paginate.
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = H - MARGIN - 20;
  const bottom = MARGIN;
  for (const it of items) {
    const lh = it.size === TITLE_SIZE ? 19 : LEAD;
    if (y - lh < bottom) { pages.push(ops); ops = []; y = H - MARGIN - 20; }
    y -= lh;
    ops.push(`BT /${it.bold ? "F2" : "F1"} ${it.size} Tf ${MARGIN} ${y.toFixed(1)} Td (${esc(it.text)}) Tj ET`);
    y -= it.gap ?? 0;
  }
  pages.push(ops);

  const n = pages.length;
  const streams = pages.map((p, i) => [
    `BT /F2 9 Tf ${MARGIN} ${H - 45} Td (Miny Labs, Inc.) Tj ET`,
    `0.5 w ${MARGIN} ${H - 52} m ${W - MARGIN} ${H - 52} l S`,
    ...p,
    `BT /F1 8 Tf ${W / 2 - 22} 40 Td (Page ${i + 1} of ${n}) Tj ET`,
  ].join("\n"));

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs.
  const objs: string[] = [];
  const kids = streams.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  streams.forEach((s, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (${esc(ascii(title))}) /Producer (Miny Labs) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // all ASCII, so byte length == string length
}
