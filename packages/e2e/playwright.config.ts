import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// E2E smoke against the real stack (issue #48): the api/worker/pdf
// containers from docker-compose.smoke.yml + docker-compose.e2e.yml
// must already be up (CI starts them in a prior step); the BUILT
// frontend is served by `vite preview`, whose proxy (inherited from
// vite.config.ts's server.proxy) forwards /api/ and /auth/ to the api
// container on localhost:3000.
export default defineConfig({
  testDir: "./src",
  timeout: 120_000,
  // One retry in CI: the stack is real (containers, queue, DB), so a
  // transient hiccup shouldn't fail the build — a genuine regression
  // still fails both attempts.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run preview --workspace=packages/frontend -- --port 4173 --strictPort",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
