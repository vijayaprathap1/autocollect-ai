import { buildApp } from "./app.js";
import { startDunningScheduler, stopDunningScheduler } from "./modules/workflows/scheduler.js";
import { closeDb } from "./lib/db.js";
import { config } from "./config.js";

const app = buildApp();
const shutdown = async () => {
  app.log.info("Shutting down");
  stopDunningScheduler();
  await closeDb();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen({ port: config.port, host: "0.0.0.0" }).then(async () => {
  if (config.nodeEnv === "production" && config.devAuthEnabled) {
    app.log.fatal(
      "Refusing to start in production without CLERK_SECRET_KEY — dev auth must never run in production",
    );
    process.exit(1);
  }
  if (config.nodeEnv !== "test") {
    await startDunningScheduler(app);
    app.log.info("Dunning scheduler started");
  }
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});