import { createServer } from "node:http";

const replyText = "A concise deterministic reply from the selected character.";
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk.toString("utf8"); });
  request.on("end", () => {
    let streaming = false;
    try {
      streaming = JSON.parse(body).stream === true;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!streaming) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: "velvet-e2e-model",
        choices: [{ message: { content: replyText } }],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let offset = 0; offset < replyText.length; offset += 8) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText.slice(offset, offset + 8) } }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ model: "velvet-e2e-model", choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});

server.listen(18788, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
