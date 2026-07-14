import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./app.js";
import { initOidcClient } from "./auth/oidc.js";
import { syncBootstrapAdmin } from "./bootstrapAdmin.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  await syncBootstrapAdmin(config, logger);
  await initOidcClient(config, logger);

  const app = createApp(config, logger);
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "nexus-scheduler API listening");
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error", err);
  process.exit(1);
});
