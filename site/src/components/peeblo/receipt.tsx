// The receipt that ends a teammate's answer: model logo and name, provider, calls, fallback, cost.
// Takes the compact text form used in the page data ("receipt · kimi-k3 · via together · 5 calls ·
// no fallback · $0.0063", or just "kimi-k3 · together · $0.0063") so data files stay simple.

import { models } from "@/content/models";
import { cn } from "@/lib/utils";

const providers: Record<string, string> = {
  deepinfra: "DeepInfra",
  together: "Together",
  fireworks: "Fireworks",
  nebius: "Nebius",
  novita: "Novita",
  mistral: "Mistral",
  bedrock: "Bedrock",
};

const findModel = (token: string) =>
  models.find((m) => {
    const short = m.id.split("/")[1];
    return short === token || short.startsWith(token) || token.startsWith(short) || m.name.toLowerCase() === token.toLowerCase();
  });

type Parsed = { model?: (typeof models)[number]; modelText: string; provider?: string; calls?: string; fellBack?: string; cost?: string };

function parse(text: string): Parsed {
  const parts = text.split("·").map((p) => p.trim()).filter((p) => p && p !== "receipt");
  const out: Parsed = { modelText: "" };
  for (const p of parts) {
    if (p.startsWith("$") || p.startsWith("≈")) out.cost = p;
    else if (/^\d+ calls?$/.test(p)) out.calls = p;
    else if (p === "no fallback") continue;
    else if (/fell back|fallback/i.test(p)) out.fellBack = p;
    else if (p.startsWith("via ")) out.provider = p.slice(4);
    else if (!out.modelText) {
      out.modelText = p;
      out.model = findModel(p);
    } else if (!out.provider) out.provider = p;
  }
  return out;
}

export function Receipt({ text, tone = "light", className }: { text: string; tone?: "light" | "dark"; className?: string }) {
  const r = parse(text);
  const provider = r.provider ? (providers[r.provider.toLowerCase()] ?? r.provider) : null;
  return (
    <span className={cn("pb-rc", tone === "dark" && "pb-rc--dark", className)} aria-label={`Receipt: ${text.replace(/^receipt · /, "")}`}>
      {r.model && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="pb-rc__logo" src={r.model.logo} alt="" width={14} height={14} />
      )}
      <b className="pb-rc__model">{r.model?.name ?? r.modelText}</b>
      {provider && <span className="pb-rc__dim">via {provider}</span>}
      {r.calls && <span className="pb-rc__dim">{r.calls}</span>}
      {r.fellBack && <span className="pb-rc__fb">{r.fellBack}</span>}
      {r.cost && <span className="pb-rc__cost">{r.cost}</span>}
    </span>
  );
}
