// The cast of the landing page: every Open Bot Avatar is a Peeblo teammate with a job and an owner.
// People are the fictional teammates at "acme" who hired them. Photos: AI-generated, CC0 (public/people/SOURCE.txt).

export const extraPhotos = ["/people/rosa.jpg", "/people/nia.jpg", "/people/kofi.jpg", "/people/ben.jpg", "/people/tara.jpg", "/people/omar.jpg"];

export type Person = { id: string; name: string; role: string; tint: string; photo: string };

export const people: Record<string, Person> = {
  maya: { id: "maya", name: "Maya", role: "Growth", tint: "oklch(0.86 0.06 30)", photo: "/people/maya.jpg" },
  sam: { id: "sam", name: "Sam", role: "Engineering", tint: "oklch(0.86 0.05 250)", photo: "/people/sam.jpg" },
  ali: { id: "ali", name: "Ali", role: "Support", tint: "oklch(0.88 0.06 95)", photo: "/people/ali.jpg" },
  priya: { id: "priya", name: "Priya", role: "Ops", tint: "oklch(0.86 0.05 160)", photo: "/people/priya.jpg" },
  theo: { id: "theo", name: "Theo", role: "Founder", tint: "oklch(0.86 0.05 320)", photo: "/people/theo.jpg" },
  jun: { id: "jun", name: "Jun", role: "Design", tint: "oklch(0.87 0.05 200)", photo: "/people/jun.jpg" },
};

export type Agent = {
  avatar: string;
  name: string;
  job: string;
  owner: keyof typeof people;
  where: string;
  model: string;
  line: string;
};

export const crew: Agent[] = [
  { avatar: "sprout", name: "sprout", job: "Growth analyst", owner: "maya", where: "#growth", model: "deepseek-v4.1-flash", line: "Every Monday I read the dashboards and tell you what actually moved." },
  { avatar: "controller", name: "patch", job: "Flaky-test fixer", owner: "sam", where: "#eng", model: "glm-5.3", line: "Flaky test? I run it until it breaks, then show you exactly why." },
  { avatar: "shield", name: "warden", job: "Reviewer", owner: "theo", where: "any thread", model: "nemotron-3-ultra", line: "I check my teammates' work with a different model before anyone acts on it." },
  { avatar: "chat", name: "echo", job: "Support writer", owner: "ali", where: "#support", model: "minimax-m3", line: "I write the reply in your voice. You press send." },
  { avatar: "book", name: "ledger", job: "Bookkeeper", owner: "priya", where: "#finance", model: "deepseek-v4.1-flash", line: "I find the charge, the invoice and the rule, then tell you what's right." },
  { avatar: "magnifier", name: "scout", job: "Researcher", owner: "theo", where: "DMs", model: "kimi-k3", line: "Give me a question and a deadline. I come back with sources." },
  { avatar: "watering-can", name: "tend", job: "Onboarding buddy", owner: "priya", where: "#people", model: "qwen3.8-27b", line: "I get new hires through week one, one checklist at a time." },
  { avatar: "rocket", name: "ship", job: "Release-notes writer", owner: "sam", where: "#releases", model: "qwen3.8-27b", line: "I turn merged PRs into release notes people actually read." },
  { avatar: "brain", name: "recall", job: "Wiki keeper", owner: "theo", where: "#general", model: "deepseek-v4-pro", line: "When a decision changes in a thread, I fix the wiki page." },
  { avatar: "cat", name: "whisk", job: "Inbox triager", owner: "ali", where: "#support", model: "qwen3.8-27b", line: "I sort the inbox before you open it and tag the right person." },
  { avatar: "paint-brush", name: "brush", job: "Design coordinator", owner: "jun", where: "#design", model: "kimi-k3", line: "I turn \"make it pop\" into a brief a designer can use." },
  { avatar: "ghost", name: "boo", job: "Night-shift on-call", owner: "sam", where: "#oncall", model: "qwen3.8-27b", line: "I watch the alerts at 3am so you don't have to. I wake you only if it matters." },
  { avatar: "lightbulb", name: "spark", job: "Brainstorm host", owner: "jun", where: "#ideas", model: "kimi-k3", line: "I collect everyone's ideas in the thread and keep the good ones." },
  { avatar: "bull", name: "push", job: "Sales assistant", owner: "maya", where: "#sales", model: "deepseek-v4.1-flash", line: "I draft the follow-up and nudge the owner. Nothing sends without them." },
  { avatar: "camera", name: "snap", job: "QA tester", owner: "jun", where: "#qa", model: "kimi-k3", line: "I click through the page and screenshot whatever broke." },
  { avatar: "witch-hat", name: "hex", job: "Data analyst", owner: "priya", where: "#data", model: "glm-5.3", line: "Ask in plain words. I write the query and show my work." },
  { avatar: "bunny", name: "hop", job: "Standup host", owner: "theo", where: "#standup", model: "qwen3.8-27b", line: "I collect everyone's standup and post one short summary at ten." },
  { avatar: "cloud", name: "nimbus", job: "Cloud-cost watcher", owner: "sam", where: "#infra", model: "qwen3.8-27b", line: "I notice when the cloud bill jumps and tell you which service did it." },
  { avatar: "star", name: "gold", job: "Wins collector", owner: "maya", where: "#wins", model: "minimax-m3", line: "I find the wins hiding in support threads and save them for Friday." },
  { avatar: "palette", name: "swatch", job: "Brand keeper", owner: "jun", where: "#brand", model: "minimax-m3", line: "I catch the off-brand slide before the client does." },
  { avatar: "barbell", name: "rep", job: "Load tester", owner: "sam", where: "#eng", model: "glm-5.3", line: "I load-test the release before you ship it, not after." },
  { avatar: "mug", name: "brew", job: "Morning briefer", owner: "theo", where: "DMs", model: "qwen3.8-27b", line: "At eight I tell you what happened overnight. Five lines, no more." },
];

export const agentByName = (name: string) => crew.find((a) => a.name === name)!;
