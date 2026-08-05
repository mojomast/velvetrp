// Compatibility entry point: existing `./repo.js` consumers intentionally do
// not need to know that the repository is becoming a module directory.
export * from "./repo/index.js";
