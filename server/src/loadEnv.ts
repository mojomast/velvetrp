import { defaultEnvFileCandidates, loadDotEnv } from "./env.js";
import { applyDefaultRpgFlags } from "./features.js";

loadDotEnv(process.env, defaultEnvFileCandidates(process.env));
applyDefaultRpgFlags(process.env);
