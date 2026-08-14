import { configureRepositoryDatabase } from "./repoContext.js";
import { getDb } from "./db/connection.js";

configureRepositoryDatabase(getDb);

export { closeRepo, openRepositoryDatabase, resolveDataDir } from "./db/connection.js";
