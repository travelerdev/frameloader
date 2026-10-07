import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Served from the root of www.frameloader.com; absolute URLs keep the 404 page working at any depth.
  base: "/",
  server: { port: 5180 },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
        notFound: resolve(import.meta.dirname, "404.html"),
      },
    },
  },
});
