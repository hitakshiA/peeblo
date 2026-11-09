import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by core at /console/ on the private API port; in dev, API calls go to core.
export default defineConfig({
  base: "/console/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/v1": "http://127.0.0.1:7340", "/healthz": "http://127.0.0.1:7340" } },
});
