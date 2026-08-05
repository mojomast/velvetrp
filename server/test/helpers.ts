import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach } from "vitest";
import { closeRepo } from "../src/repo/index.js";

const tmpDirs: string[] = [];

export function makeTmpDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "velvet-test-"));
  tmpDirs.push(dir);
  process.env.VELVET_DATA_DIR = dir;
  closeRepo();
  return dir;
}

export function cleanupTmpDataDirs(): void {
  closeRepo();
  delete process.env.VELVET_DATA_DIR;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function useTmpDataDir(): void {
  beforeEach(() => {
    makeTmpDataDir();
  });
  afterEach(() => {
    cleanupTmpDataDirs();
  });
}

export interface FakeProvider {
  baseUrl: string;
  requests: Array<{ model: string; messageCount: number; lastUserContent: string | null; systemContent: string }>;
  sceneRequests: Array<{ model: string; messageCount: number; lastUserContent: string | null; systemContent: string }>;
  close: () => Promise<void>;
}

export interface FakeProviderOptions {
  replyText?: string;
  replyTexts?: string[];
  delayMs?: number;
  chunkSize?: number;
}

export async function startFakeProvider(
  replyTextOrOptions: string | FakeProviderOptions = "A warm, fictional reply between consenting adults.",
): Promise<FakeProvider> {
  const options: FakeProviderOptions =
    typeof replyTextOrOptions === "string" ? { replyText: replyTextOrOptions } : replyTextOrOptions;
  const replyText = options.replyText ?? "A warm, fictional reply between consenting adults.";
  let replyIndex = 0;
  const delayMs = options.delayMs ?? 0;
  const chunkSize = options.chunkSize ?? 7;
  const requests: FakeProvider["requests"] = [];
  const sceneRequests: FakeProvider["sceneRequests"] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        let stream = false;
        let sceneRequest = false;
        try {
          const parsed = JSON.parse(body) as {
            model?: string;
            stream?: boolean;
            messages?: Array<{ role: string; content: string }>;
          };
          const messages = parsed.messages ?? [];
          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          stream = parsed.stream === true;
          const captured = {
              model: parsed.model ?? "",
              messageCount: messages.length,
              lastUserContent: lastUser?.content ?? null,
              systemContent: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
          };
          sceneRequest = captured.systemContent.includes("SCENE STATE SYNTHESIZER");
          if (sceneRequest) sceneRequests.push(captured);
          else requests.push(captured);
        } catch {
          // ignore malformed bodies in the fake
        }
        const respond = () => {
          const currentReply = sceneRequest
            ? "Location & time:\n- Observatory at night\nParticipants:\n- Everyone is alert\nObjects & environment:\n- A brass key is present\nRelationships & knowledge:\n- none established\nActive goals & tensions:\n- Determine what the key opens"
            : options.replyTexts?.[replyIndex++] ?? replyText;
          if (!stream) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: currentReply } }] }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (let i = 0; i < currentReply.length; i += chunkSize) {
            const delta = currentReply.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ model: "fake-model", choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (delayMs > 0) {
          setTimeout(respond, delayMs);
        } else {
          respond();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    sceneRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
