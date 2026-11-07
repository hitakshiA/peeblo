// `peeblo image`: builds the teammate VM image for this host's architecture (or PEEBLO_VM_ARCH).
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { imagePath } from "./controller.ts";

export async function buildImage(): Promise<void> {
  const out = imagePath();
  await mkdir(dirname(out), { recursive: true });
  const cfg = join(import.meta.dirname, "..", "..", "images", `teammate-${config.vmArch}.json`);
  const bin = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "gondolin");
  console.log(`building ${config.vmArch} image into ${out}`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, ["build", "--config", cfg, "--output", out], { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`gondolin build exited ${code}`))));
  });
}
