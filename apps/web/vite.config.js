import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Relative asset URLs so the built site works from any path (GitHub Pages, a subfolder, a file share).
  base: "./",
  server: { port: 5180 },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
      },
    },
  },
});
