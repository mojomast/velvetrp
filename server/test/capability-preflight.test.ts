import { describe, expect, it, vi } from "vitest";
import {
  classifyProviderFailure,
  createProviderCapabilityProbeRequest,
  parseRetryAfterMs,
  recommendProviderRetry,
  runProviderCapabilityPreflight,
  type ProviderCapabilityProbeOutcome,
} from "../src/provider/capabilityPreflight.js";
import type { ProviderCompletionResult } from "../src/provider/openAiCompatibleCompletion.js";

function result(content: string | null, toolCalls?: Array<{ id: string; name: string; arguments: string }>): ProviderCompletionResult {
  return {
    message: { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) },
    usage: null,
    model: { requestedModel: "model", responseModel: "model" },
  };
}

describe("provider capability preflight", () => {
  it("builds independent function-tool and strict JSON probes", () => {
    const tools = createProviderCapabilityProbeRequest("function-tools", "model");
    const schema = createProviderCapabilityProbeRequest("strict-json-schema", "model");
    expect(tools.toolChoice).toBe("required");
    expect(tools.tools?.[0]?.parameters).toMatchObject({ additionalProperties: false });
    expect(schema.jsonSchema?.schema).toMatchObject({ additionalProperties: false });
    expect(tools.jsonSchema).toBeUndefined();
    expect(schema.tools).toBeUndefined();
  });

  it("requires semantic proof from both injected probes", async () => {
    const probe = vi.fn(async (request): Promise<ProviderCapabilityProbeOutcome> => request.capability === "function-tools"
      ? { ok: true, result: result(null, [{ id: "call-1", name: "velvet_capability_probe", arguments: '{"marker":"velvet-capability-v1"}' }]) }
      : { ok: true, result: result('{"marker":"velvet-capability-v1"}') });
    const preflight = await runProviderCapabilityPreflight({ model: "model", probe });
    expect(preflight.ok).toBe(true);
    expect(preflight).toMatchObject({dmPlayCompatible:true,campaignGenerationCompatible:true});
    expect(preflight.capabilities.map((item) => item.status)).toEqual(["supported", "supported"]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("distinguishes unsupported capabilities from transient unavailability", async () => {
    const outcomes: ProviderCapabilityProbeOutcome[] = [
      { ok: false, failure: classifyProviderFailure({ httpStatus: 400, capabilityRejected: true }) },
      { ok: false, failure: classifyProviderFailure({ httpStatus: 429, retryAfter: "2" }, 1_000) },
    ];
    const preflight = await runProviderCapabilityPreflight({ model: "model", probe: async () => outcomes.shift()! });
    expect(preflight.ok).toBe(false);
    expect(preflight).toMatchObject({dmPlayCompatible:false,campaignGenerationCompatible:false});
    expect(preflight.capabilities[0]).toMatchObject({ status: "unsupported", failure: { permanence: "permanent" } });
    expect(preflight.capabilities[1]).toMatchObject({ status: "unavailable", failure: { retryAfterMs: 2_000 } });
  });

  it("treats function-tool providers without strict JSON as DM-play compatible",async()=>{
    const preflight=await runProviderCapabilityPreflight({model:"openrouter:qwen/qwen3.7-flash",probe:async(request)=>request.capability==="function-tools"
      ?{ok:true,result:result(null,[{id:"qwen-call",name:"velvet_capability_probe",arguments:'{"marker":"velvet-capability-v1"}'}])}
      :{ok:false,failure:classifyProviderFailure({httpStatus:400,capabilityRejected:true})}});
    expect(preflight).toMatchObject({ok:false,dmPlayCompatible:true,campaignGenerationCompatible:false,capabilities:[
      {capability:"function-tools",status:"supported"},{capability:"strict-json-schema",status:"unsupported"},
    ]});
  });

  it("fails malformed successful probe responses closed", async () => {
    const preflight = await runProviderCapabilityPreflight({
      model: "model",
      capabilities: ["strict-json-schema"],
      probe: async () => ({ ok: true, result: result('{"marker":"wrong"}') }),
    });
    expect(preflight.capabilities[0]).toMatchObject({ status: "unsupported", failure: { code: "protocol" } });
  });
});

describe("provider failure and retry policy", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfterMs("1.5", 1_000)).toBe(1_500);
    expect(parseRetryAfterMs(new Date(4_000).toUTCString(), 1_000)).toBe(3_000);
    expect(parseRetryAfterMs("invalid", 1_000)).toBeNull();
  });

  it("classifies known transient statuses without retrying permanent failures", () => {
    expect(classifyProviderFailure({ httpStatus: 503 })).toMatchObject({ permanence: "transient", code: "overloaded" });
    const permanent = classifyProviderFailure({ httpStatus: 401 });
    expect(recommendProviderRetry({ failure: permanent, attempt: 1, nowMs: 0, deadlineAtMs: 10_000,
      policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 } })).toEqual({ retry: false, reason: "permanent" });
  });

  it("honors Retry-After, attempt, delay, and deadline bounds", () => {
    const failure = classifyProviderFailure({ httpStatus: 429, retryAfter: "2" }, 0);
    const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3_000 };
    expect(recommendProviderRetry({ failure, attempt: 1, nowMs: 0, deadlineAtMs: 5_000, policy }))
      .toEqual({ retry: true, delayMs: 2_000, nextAttempt: 2 });
    expect(recommendProviderRetry({ failure, attempt: 3, nowMs: 0, deadlineAtMs: 5_000, policy }))
      .toEqual({ retry: false, reason: "attempt-limit" });
    expect(recommendProviderRetry({ failure, attempt: 1, nowMs: 3_000, deadlineAtMs: 5_000, policy }))
      .toEqual({ retry: false, reason: "deadline" });
  });
});
