// Faces and ID cards. A teammate's face is an Open Bot Avatar (a shape and a color); its ID card is the lanyard
// from the landing page (face, name, role, who hired it, model, budget, an ID and a barcode), rendered as a PNG for
// Slack and uploaded as a Slack file (no public URL needed).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { renderAvatarSvg } from "open-bot-avatar";
import type { Teammate } from "../store/teammates.ts";
import { slack } from "./api.ts";

const DIR = join(import.meta.dirname, "..", "..", "assets", "avatars");
export const SHAPES = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
export const COLORS = ["#2E7D5B", "#3B6FB6", "#B5582A", "#7A4FB0", "#C2412D", "#1F8A8A", "#A6782B", "#4A5A6A"];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function pickFace(seed: string, shape?: string | null, color?: string | null): { shape: string; color: string } {
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { shape: shape && SHAPES.includes(shape) ? shape : SHAPES[h % SHAPES.length], color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : COLORS[h % COLORS.length] };
}

export async function facePng(face: { shape: string; color: string }, size = 512): Promise<Buffer> {
  const inner = Math.round(size * 0.78);
  const svg = renderAvatarSvg(JSON.parse(readFileSync(join(DIR, `${face.shape}.json`), "utf8")), { color: face.color, size: inner });
  const bot = await sharp(Buffer.from(svg)).resize(inner).png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: "#F4EFE6" } }).composite([{ input: bot, top: pad, left: pad }]).png().toBuffer();
}

// The role on up to two lines, broken at words (never cut mid-word).
function roleLines(role: string, width = 40): string[] {
  const words = role.split(/\s+/);
  const lines: string[] = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + " " + w).trim().length <= width) lines[lines.length - 1] = (cur + " " + w).trim();
    else if (lines.length < 2) lines.push(w);
    else { lines[1] = `${lines[1].replace(/[.,;:]?$/, "")}…`; break; }
  }
  return lines;
}

// The ID card as a card block's hero image: centred on a wide canvas, so Slack's crop never cuts the card.
export async function idCardHeroPng(card: Buffer): Promise<Buffer> {
  const inner = await sharp(card).resize({ width: 760 }).png().toBuffer();
  const meta = await sharp(inner).metadata();
  const W = 1200, H = 600;
  return sharp({ create: { width: W, height: H, channels: 4, background: "#F4EFE6" } })
    .composite([{ input: inner, left: Math.round((W - (meta.width ?? 760)) / 2), top: Math.round((H - (meta.height ?? 440)) / 2) }]).png().toBuffer();
}

export async function idCardPng(tm: Teammate, face: { shape: string; color: string }, hiredBy: string): Promise<Buffer> {
  const W = 900, H = 520;
  const avatar = (await facePng(face, 300)).toString("base64");
  const c = tm.config;
  const { modelLabel } = await import("./look.ts");
  const model = await modelLabel(c.model.default);
  // The ID is the teammate's slug: the same on the card before and after the hire (never a preview id).
  const id = tm.slug.toUpperCase().slice(0, 16);
  const bars = [...id].map((ch, i) => `<rect x="${600 + i * 18}" y="430" width="${(ch.charCodeAt(0) % 3) + 3}" height="50" fill="#1d1c1d"/>`).join("");
  const line = (y: number, k: string, v: string) => `<text x="380" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#6b6b6b">${esc(k)}</text><text x="520" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#1d1c1d">${esc(v.slice(0, 34))}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="28" fill="#FFFDF8" stroke="#1d1c1d" stroke-width="3"/>
    <rect x="10" y="10" width="${W - 20}" height="70" rx="28" fill="${face.color}"/><rect x="10" y="50" width="${W - 20}" height="30" fill="${face.color}"/>
    <text x="40" y="58" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#FFFDF8">PEEBLO · TEAMMATE ID</text>
    <image x="40" y="110" width="300" height="300" href="data:image/png;base64,${avatar}"/>
    <text x="380" y="160" font-family="Helvetica, Arial, sans-serif" font-size="48" font-weight="700" fill="#1d1c1d">${esc(c.name)}</text>
    ${roleLines(c.role).map((l, i) => `<text x="380" y="${196 + i * 28}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#3a3a3a">${esc(l)}</text>`).join("")}
    ${line(280, "Hired by", hiredBy)}${line(318, "Model", model)}${line(356, "Budget", `$${c.budget.monthly_usd}/month`)}${line(394, "Approvals", `${c.mode} mode`)}
    <text x="40" y="465" font-family="Courier, monospace" font-size="22" fill="#1d1c1d">ID ${esc(id)}</text>${bars}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Uploads a PNG to Slack as a file (not shared to any channel) and returns its id for image blocks.
export async function uploadPng(appId: string, png: Buffer, name: string): Promise<string> {
  const u = await slack(appId, "files.getUploadURLExternal", { filename: name, length: png.length });
  const up = await fetch(u.upload_url, { method: "POST", body: new Uint8Array(png) });
  if (!up.ok) throw new Error(`file upload failed (${up.status})`);
  await slack(appId, "files.completeUploadExternal", { files: [{ id: u.file_id, title: name }] });
  return u.file_id;
}

// A card image Slack can fetch by URL: saved under an unguessable id and served at /cards/<id>.png on the public
// ingress (an image block with a private Slack file is refused).
export async function publishCard(png: Buffer): Promise<string | null> {
  const { config } = await import("../config.ts");
  if (!config.publicUrl) return null;
  const { randomBytes } = await import("node:crypto");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const id = randomBytes(16).toString("hex");
  const dir = join(config.dataDir, "cards");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.png`), png);
  return `${config.publicUrl}/cards/${id}.png`;
}
