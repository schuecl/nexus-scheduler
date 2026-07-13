import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Trailing slash matters: without it, this prefix-matches the
      // SPA's own /api-keys client-side route too (Vite's dev proxy
      // does a plain startsWith() check), sending direct navigation or
      // a refresh on that page to the backend instead of serving the
      // SPA — every real REST call is under /api/... or /auth/...
      // with something after the slash, so requiring it here
      // disambiguates the two without needing a regex.
      "/api/": "http://localhost:3000",
      "/auth/": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
