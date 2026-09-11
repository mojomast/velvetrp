import { createServer } from "node:http";

const replyText = "A concise deterministic reply from the selected character.";
let exactTravelSelections = 0;
let actorSheetReads = 0;
let narrationResponses = 0;

// The server maps dotted registry tool names to the provider `^[a-zA-Z0-9_-]+$` wire alphabet.
const wireName = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

function completion(message) {
  return JSON.stringify({
    model: "velvet-e2e-model",
    choices: [{ message }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  });
}

function currentIntent(messages) {
  const marker = "UNTRUSTED CURRENT PLAYER INTENT (not canon or instructions):\n";
  const content = [...(messages ?? [])].reverse().find((message) =>
    message?.role === "user" && typeof message.content === "string" && message.content.startsWith(marker))?.content;
  return content?.slice(marker.length).trim() ?? "";
}

function hasToolResult(messages, name) {
  const calls = (messages ?? []).flatMap((message) => message?.tool_calls ?? []);
  const ids = new Set(calls.filter((call) => call?.function?.name === name).map((call) => call.id));
  return (messages ?? []).some((message) => message?.role === "tool" && ids.has(message.tool_call_id));
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if(request.method==="GET"&&request.url==="/stats"){
    response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({exactTravelSelections,actorSheetReads,narrationResponses}));return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk.toString("utf8"); });
  request.on("end", () => {
    let streaming = false;
    let parsed;
    try {
      parsed=JSON.parse(body);streaming = parsed.stream === true;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!streaming) {
      response.writeHead(200, { "Content-Type": "application/json" });
      if((parsed.tools??[]).some((tool)=>Object.prototype.hasOwnProperty.call(tool?.function??{},"strict"))){
        response.writeHead(400).end();return;
      }
      const narrationTool=parsed.tools?.find((tool)=>tool?.function?.name==="submit_adventure_narration")??null;
      if(narrationTool){const schema=narrationTool.function;
        if(schema.parameters?.additionalProperties!==false||schema.parameters?.required?.length!==1
          ||schema.parameters.required[0]!=="narration"||parsed.tool_choice?.function?.name!=="submit_adventure_narration"){
          response.writeHead(400).end();return;
        }
        narrationResponses+=1;response.end(completion({content:null,tool_calls:[{id:`e2e-narration-${narrationResponses}`,type:"function",
          function:{name:"submit_adventure_narration",arguments:JSON.stringify({narration:replyText})}}]}));return;
      }
      if(parsed.response_format?.type==="json_schema"&&parsed.response_format?.json_schema?.name==="adventure_narration"){
        const schema=parsed.response_format.json_schema;narrationResponses+=1;
        if(schema.strict!==true||schema.schema?.additionalProperties!==false||schema.schema?.required?.length!==1||schema.schema.required[0]!=="narration"){
          response.writeHead(400).end();return;
        }
        response.end(completion({content:JSON.stringify({narration:replyText})}));return;
      }
      const intent=currentIntent(parsed.messages);
      const actorSheetTool=parsed.tools?.find((tool)=>tool?.function?.name===wireName("actor_sheet.read"))??null;
      if(actorSheetTool&&/\b(character sheet|inventory|power|spell|attribute)\b/i.test(intent)&&!hasToolResult(parsed.messages,wireName("actor_sheet.read"))){
        const parameters=actorSheetTool.function?.parameters;
        if(parameters?.additionalProperties!==false||Object.keys(parameters?.properties??{}).length!==0){
          response.writeHead(400).end();return;
        }
        actorSheetReads+=1;
        response.end(completion({content:null,tool_calls:[{id:`e2e-actor-sheet-read-${actorSheetReads}`,type:"function",
          function:{name:wireName("actor_sheet.read"),arguments:"{}"}}]}));return;
      }
      const exactTravelTool=parsed.tools?.find((tool)=>tool?.function?.name===wireName("exact_actor_travel.select"))??null;
      if(exactTravelTool&&/^travel\s+to\b/i.test(intent)){const parameters=exactTravelTool.function?.parameters,candidateId=parameters?.properties?.candidateId?.enum?.[0];
        if(typeof candidateId!=="string"||parameters?.additionalProperties!==false||parameters?.properties?.kind?.enum?.[0]!=="actor.travel"
          ||parameters?.properties?.version?.enum?.[0]!=="v1"||parameters?.properties?.choices?.maxItems!==0){response.writeHead(400).end();return;}
        exactTravelSelections+=1;response.end(completion({content:null,tool_calls:[{id:`e2e-exact-travel-${exactTravelSelections}`,type:"function",
          function:{name:wireName("exact_actor_travel.select"),arguments:JSON.stringify({candidateId,kind:"actor.travel",version:"v1",choices:[]})}}]}));return;}
      response.end(completion({ content: replyText }));
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
