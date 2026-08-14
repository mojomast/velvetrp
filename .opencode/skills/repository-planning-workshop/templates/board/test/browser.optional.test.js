"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createServer } = require("../server.js");

function run(browser, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, arguments_, { stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk)); child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

test("optional Chromium loads the actual served board at 320px", async (context) => {
  const candidates = [process.env.CHROME_BIN, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  const browser = candidates.find((candidate) => fs.existsSync(candidate));
  if (!browser) { context.skip("SKIP: no installed Chromium/Chrome; deterministic tests covered pure transitions/helpers and static controller wiring only"); return; }
  const root = path.resolve(__dirname, ".."); const directory = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "repoworkshop-browser-test-")); const capability = "Browser_Test_Capability_0123456789abcdef";
  const config = { bind: "127.0.0.1", port: 0, capability, manifestPath: path.join(root, "manifest.example.json"), stateDir: directory, readOnly: false }; const server = createServer(config);
  try {
    await new Promise((resolve) => server.listen(0, config.bind, resolve)); config.port = server.address().port; const url = `http://${config.bind}:${config.port}/${capability}/`;
    const initial = await fetch(url); assertResponse(initial, 200); if (!initial.headers.get("content-security-policy")?.includes("default-src 'none'")) throw new Error("served board omitted CSP"); assertResponse(await fetch(`http://${config.bind}:${config.port}/wrong/`), 404);
    const result = await run(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--virtual-time-budget=3000", "--window-size=320,800", "--dump-dom", url]);
    if (result.status !== 0) throw new Error(`installed browser board smoke failed: ${result.stderr.slice(0, 500)}`);
    for (const expected of ["Repository Planning Workshop", "epic-row", "decision-row", "readiness-link", "data-horizontal-overflow=\"false\"", "Custom answer for How should the first delivery be sequenced?"]) if (!result.stdout.includes(expected)) throw new Error(`actual board DOM omitted ${expected}`);
    console.log(`Optional browser smoke ran actual served capability-path board with ${browser}; 320px DOM reported no horizontal overflow.`);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});

function assertResponse(response, expected) { if (response.status !== expected) throw new Error(`expected HTTP ${expected}, received ${response.status}`); }
