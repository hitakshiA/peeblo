// What a job's ask reads as for people (console, App Home): a person's words, or a plain name for an event Peeblo
// started itself (a welcome, a schedule), never the prompt it was given.
export function askedLabel(text: string | null): string {
  const t = String(text ?? "");
  const ev = /^<peeblo_event>\s*([^:.\n]+)/.exec(t);
  if (!ev) return t;
  const kind = ev[1].trim();
  return /first contact/.test(kind) ? "Welcome message (first contact)" : `${kind[0].toUpperCase()}${kind.slice(1)} (started by Peeblo)`;
}
