import { createServer } from "node:http";

const replyText = "A concise deterministic reply from the selected character.";
let exactTravelSelections = 0;
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if(request.method==="GET"&&request.url==="/stats"){
    response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({exactTravelSelections}));return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk.toString("utf8"); });
  request.on("end", () => {
    let streaming = false;
    let exactTravelTool = null;
    try {
      const parsed=JSON.parse(body);streaming = parsed.stream === true;
      exactTravelTool=parsed.tools?.find((tool)=>tool?.function?.name==="exact_actor_travel.select")??null;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!streaming) {
      response.writeHead(200, { "Content-Type": "application/json" });
      if(exactTravelTool){const parameters=exactTravelTool.function?.parameters,candidateId=parameters?.properties?.candidateId?.enum?.[0];
        if(typeof candidateId!=="string"||parameters?.additionalProperties!==false||parameters?.properties?.kind?.enum?.[0]!=="actor.travel"
          ||parameters?.properties?.version?.enum?.[0]!=="v1"||parameters?.properties?.choices?.maxItems!==0){response.writeHead(400).end();return;}
        exactTravelSelections+=1;response.end(JSON.stringify({model:"velvet-e2e-model",choices:[{message:{content:null,tool_calls:[{id:"e2e-exact-travel-first",type:"function",
          function:{name:"exact_actor_travel.select",arguments:JSON.stringify({candidateId,kind:"actor.travel",version:"v1",choices:[]})}}]}}],
          usage:{prompt_tokens:40,completion_tokens:12,total_tokens:52}}));return;}
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
