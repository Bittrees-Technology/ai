import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: "apps/site",
  build: {
    outDir: "../../dist/site",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve("apps/site/index.html"),
        workflows: resolve("apps/site/workflows/index.html"),
      },
    },
  },
});
