// `peeblo image`: builds the teammate VM images for this host's architecture (or PEEBLO_VM_ARCH): the small
// tier's image, and the large tier's, which adds a headless browser (Chromium). `peeblo image small` builds one.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { imagePath } from "./controller.ts";

export async function buildImage(only?: string): Promise<void> {
  for (const size of (only ? [only] : ["small", "large"]) as ("small" | "large")[]) {
    const out = imagePath(size);
    await mkdir(dirname(out), { recursive: true });
    const cfg = join(import.meta.dirname, "..", "..", "images", `teammate-${size === "large" ? "browser-" : ""}${config.vmArch}.json`);
    const bin = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "gondolin");
    console.log(`building the ${size} ${config.vmArch} image into ${out}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, ["build", "--config", cfg, "--output", out], { stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`gondolin build exited ${code}`))));
    });
  }
}
