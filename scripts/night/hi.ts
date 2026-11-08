// One greeting to a teammate, timed (a quick check between efficiency runs).
import { turn } from "../otari-check/n-common.ts";
const t = Date.now();
const r = await turn(process.argv[2] ?? "peeblo", `hi-${Date.now().toString(36)}`, "hi", {});
console.log(r.runId, ((Date.now() - t) / 1000).toFixed(1), "s");
process.exit(0);
