// Strict JSON schemas for Peeblo's own tools, and the harness-side check of every call's arguments (K7d).
// Schemas stay flat and strict (every property required, optional ones nullable, no extra keys), the shape
// open models handle best and providers can enforce.
export type Schema = {
  type: string | string[]; description?: string; properties?: Record<string, Schema>; required?: string[];
  enum?: unknown[]; minimum?: number; maximum?: number; additionalProperties?: boolean; items?: Schema; maxItems?: number;
};

export function object(properties: Record<string, Schema>): Schema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

// Returns the first problem, phrased so a model can fix its next call, or null.
export function validate(s: Schema, v: unknown, path = "arguments"): string | null {
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
  if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return `${path} must be ${types.join(" or ")}, got ${t}`;
  if (s.enum && !s.enum.includes(v)) return `${path} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) return `${path} must be at least ${s.minimum}`;
  if (typeof v === "number" && s.maximum !== undefined && v > s.maximum) return `${path} must be at most ${s.maximum}`;
  if (t === "array" && s.items) {
    const a = v as unknown[];
    if (s.maxItems !== undefined && a.length > s.maxItems) return `${path} can have at most ${s.maxItems} items`;
    for (let i = 0; i < a.length; i++) { const e = validate(s.items, a[i], `${path}[${i}]`); if (e) return e; }
  }
  if (t === "object" && s.properties) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) return `${path}.${r} is missing (send null if you have no value)`;
    if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in s.properties)) return `${path}.${k} is not a field of this tool`;
    for (const [k, sub] of Object.entries(s.properties)) if (k in o) { const e = validate(sub, o[k], `${path}.${k}`); if (e) return e; }
  }
  return null;
}
