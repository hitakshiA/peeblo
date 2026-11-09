// What a job's ask reads as for people (console, App Home): a person's words, or a plain name for what started it
// (a welcome, a schedule, another teammate), never the prompt it was given or raw Slack ids.
export function askedLabel(text: string | null): string {
  const t = String(text ?? "");
  const ev = /^<peeblo_event>\s*([^:.\n]+)/.exec(t);
  if (ev) {
    const kind = ev[1].trim();
    return /first contact/.test(kind) ? "Welcome message (first contact)" : `${kind[0].toUpperCase()}${kind.slice(1)} (started by Peeblo)`;
  }
  // A handoff: "Tally asks (for Maya):\n<question>" reads as "From Tally: <question>".
  const hand = /^(.+?) asks \(for [^)]*\):\s*\n?([\s\S]*)$/.exec(t);
  const body = hand ? `From ${hand[1]}: ${hand[2].split("\nAnswer as:")[0]}` : t;
  return body.replace(/\s*\((?:U|W)[A-Z0-9]{6,}\)/g, "").replace(/<@[A-Z0-9]+>/g, "someone").replace(/\nReply with slack_post in this thread\.?/g, "");
}

// Short text cut at a word, with an ellipsis, never mid-word.
export function cutWords(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
}
