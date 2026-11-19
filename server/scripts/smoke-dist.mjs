import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, "..");
const OUTPUT_TAIL_CHARS = 8000;

function parseArgs(argv) {
  const options = {
    entry: path.join(serverDir, "dist", "index.js"),
    timeoutMs: 30000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--entry") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--entry requires a file path");
      options.entry = path.resolve(value);
      i += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      options.timeoutMs = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthIsOk(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(2000),
  });
  if (response.status !== 200) return false;
  const body = await response.json();
  return body !== null && typeof body === "object" && body.ok === true;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(forceTimer);
      resolve();
    }
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`smoke:dist FAILED: ${error.message}\n`);
    return 1;
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), "velvet-smoke-data-"));
  let child = null;
  let output = "";
  try {
    const port = await freePort();
    child = spawn(process.execPath, [options.entry], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        VELVET_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Keep the tail of the server's output so a failed start explains itself in CI logs.
    const keep = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_TAIL_CHARS) output = output.slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });

    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      if (exited) {
        throw new Error(`server exited before health was ok (code=${exitCode}, signal=${exitSignal})`);
      }
      if (Date.now() > deadline) {
        throw new Error(`health did not answer ok within ${options.timeoutMs}ms`);
      }
      try {
        if (await healthIsOk(port)) break;
      } catch {
        // server not accepting connections yet
      }
      if (exited) {
        throw new Error(`server exited before health was ok (code=${exitCode}, signal=${exitSignal})`);
      }
      await sleep(250);
    }

    console.log("smoke:dist ok");
    return 0;
  } catch (error) {
    process.stderr.write(`smoke:dist FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    if (output.trim()) process.stderr.write(`--- server output (last ${OUTPUT_TAIL_CHARS} chars) ---\n${output}\n--- end server output ---\n`);
    return 1;
  } finally {
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
