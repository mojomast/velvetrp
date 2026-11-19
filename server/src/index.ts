import "./loadEnv.js";
import { buildApp } from "./app.js";
import { getDb } from "./repo/db/connection.js";
import { registerClientApp } from "./static.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp();

try {
  getDb();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await registerClientApp(app);

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`listening on http://${host}:${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
