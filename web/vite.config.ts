import { defineConfig } from "vite";

// GitHub Pages serves the site at /plinth/. Override with PLINTH_BASE for other hosts.
export default defineConfig({
  base: process.env.PLINTH_BASE ?? "/plinth/",
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
