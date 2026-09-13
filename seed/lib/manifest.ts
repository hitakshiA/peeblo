import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.ts";

// One manifest per app maps world keys to provider IDs, so seeding is idempotent and resettable.
// Manifests are local state (gitignored); providers stay the source of truth.
const STATE_DIR = resolve(REPO_ROOT, "seed", "state");

export class Manifest {
  readonly app: string;
  private file: string;
  private data: Record<string, Record<string, string>>;

  constructor(app: string) {
    this.app = app;
    mkdirSync(STATE_DIR, { recursive: true });
    this.file = resolve(STATE_DIR, `${app}.json`);
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
  }

  get(kind: string, key: string): string | undefined {
    return this.data[kind]?.[key];
  }

  set(kind: string, key: string, id: string): void {
    (this.data[kind] ??= {})[key] = id;
    this.save();
  }

  delete(kind: string, key: string): void {
    delete this.data[kind]?.[key];
    this.save();
  }

  all(kind: string): Record<string, string> {
    return { ...(this.data[kind] ?? {}) };
  }

  kinds(): string[] {
    return Object.keys(this.data);
  }

  // Create-or-reuse: runs create() only if the key has no recorded ID.
  async ensure(kind: string, key: string, create: () => Promise<string>): Promise<string> {
    const existing = this.get(kind, key);
    if (existing) return existing;
    const id = await create();
    this.set(kind, key, id);
    return id;
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n");
  }
}
