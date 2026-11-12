import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// GitHub Pages serves the site at /plinth/. Override with PLINTH_BASE for other hosts.
// Several pages: Home, the app (funds and launch), the verifier, how it works, security.
export default defineConfig({
  base: process.env.PLINTH_BASE ?? "/plinth/",
  server: { fs: { allow: [".."] } },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: page("./index.html"),
        app: page("./app/index.html"),
        launch: page("./app/launch/index.html"),
        verify: page("./verify/index.html"),
        how: page("./how/index.html"),
        security: page("./security/index.html"),
      },
    },
  },
});
