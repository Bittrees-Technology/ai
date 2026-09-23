import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../apps/remote-web", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("../dist/remote-web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "assets/remote-[name]-[hash].js",
        assetFileNames: "assets/remote-[name]-[hash][extname]",
      },
    },
  },
});
