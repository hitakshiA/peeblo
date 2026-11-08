// Post or read in Slack as one of the test people (a real human message through their own user token).
//   node scripts/night/as-person.ts post <person> <channel> "<text>" [thread_ts]   → prints the message ts
//   node scripts/night/as-person.ts read <person> <channel> <thread_ts>            → prints the thread as JSON
//   node scripts/night/as-person.ts delete <person> <channel> <ts>                 → deletes that person's own message
//   node scripts/night/as-person.ts open <person> <bot_user_id>                    → prints the DM channel with that app
// <person> is hitakshi, maya or jun. Tokens are read here only and never printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = process.env.PEEBLO_SLACK_USERS ?? join(import.meta.dirname, "..", "..", "..", "peeblo", "local", "secrets", "slack-users.json");
const users = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, { name: string; token: string }>;
const [cmd, who, channel, arg, thread] = process.argv.slice(2);
const user = Object.values(users).find((u) => u.name.toLowerCase().startsWith(String(who).toLowerCase()));
if (!user) throw new Error(`no test person called ${who}`);

async function call(method: string, body: Record<string, unknown>): Promise<any> {
  const form = new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${user!.token}`, "content-type": "application/x-www-form-urlencoded" }, body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
}

if (cmd === "post") console.log((await call("chat.postMessage", { channel, text: arg, thread_ts: thread })).ts);
else if (cmd === "read") console.log(JSON.stringify((await call("conversations.replies", { channel, ts: arg, limit: 50 })).messages, null, 1));
else if (cmd === "open") console.log((await call("conversations.open", { users: channel })).channel.id); // channel = a bot user id
else if (cmd === "delete") console.log((await call("chat.delete", { channel, ts: arg })).ok);
else throw new Error("post | read | delete");
