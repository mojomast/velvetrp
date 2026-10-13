"""Produce inspected runtime evidence from provider-free synthetic fixtures."""
import argparse
import importlib.metadata
import json
import platform
from pathlib import Path

from runtime import Runtime, sha, VERSIONS
from prepare import TEMPLATE_URL, MODEL, REVISION, TEMPLATE_SHA


def call(identifier="inspect-1", target="écluse 🌊", count=2):
    return {"id": identifier, "type": "function", "function": {"name": "inspect", "arguments": {"target": target, "count": count}}}


TOOLS = [{"type": "function", "function": {"name": "inspect", "description": "Inspect a public object.",
          "parameters": {"type": "object", "properties": {"target": {"type": "string"}, "count": {"type": "integer"}},
                         "required": ["target", "count"], "additionalProperties": False}}}]
CONTEXT = [{"role": "system", "content": "Narrate committed public facts. Preserve player agency."},
           {"role": "user", "content": "Le résultat est 22. Que vois-je près de l'écluse 🌊 ?"}]


def example(messages, prose, calls=None, tools=False):
    return {"family": "tool-selection" if tools else "roleplay-conversation", "messages": messages,
            "targetSelection": {"supervisedAssistantIndices": prose, "supervisedToolCallIndices": calls or []},
            **({"tools": TOOLS} if tools else {})}


def fixtures():
    assistant_call = {"role": "assistant", "content": "", "tool_calls": [call()]}
    tool = {"role": "tool", "content": "Le registre public indique 22, sans autre conséquence.", "tool_call_id": "inspect-1", "name": "inspect"}
    return [
        ("prose-french-emoji", example(CONTEXT + [{"role": "assistant", "content": "À l'écluse 🌊, le registre porte le résultat 22."}], [2])),
        ("call-only-null", example(CONTEXT + [{**assistant_call, "content": None}], [], [2], True)),
        ("tool-round-trip", example(CONTEXT + [assistant_call, tool, {"role": "assistant", "content": "Le registre de l'écluse 🌊 indique 22."}], [4], [2], True)),
        ("consecutive-tool-results", example(CONTEXT + [
            {"role": "assistant", "content": "", "tool_calls": [call(), call("inspect-2", "lanterne", 3)]},
            tool, {"role": "tool", "content": "La lanterne est allumée.", "tool_call_id": "inspect-2", "name": "inspect"},
            {"role": "assistant", "content": "Le registre indique 22; la lanterne est allumée."},
        ], [5], [2], True)),
        ("unapproved-assistant-history", example(CONTEXT + [
            {"role": "assistant", "content": "Le résultat était 99. Cette ancienne réponse est erronée."},
            {"role": "user", "content": "Corrige: le reçu public donne 22."},
            {"role": "assistant", "content": "Le résultat établi est 22."},
        ], [4])),
        ("unapproved-call-history", example(CONTEXT + [assistant_call, tool, {"role": "assistant", "content": "Le registre indique 22."}], [4], [], True)),
        ("mixed-prose-and-call", example(CONTEXT + [{"role": "assistant", "content": "Je consulte le registre de l'écluse 🌊.", "tool_calls": [call()]}], [2], [2], True)),
        ("quoted-numeric-arguments", example(CONTEXT + [{"role": "assistant", "content": "", "tool_calls": [call(target='registre "Nord"\\page 🌊', count=2220)]}], [], [2], True)),
    ]


def measure(assets: Path, output: Path):
    runtime = Runtime(assets)
    probes = [{"id": name, "example": data, "measurement": runtime.measure(data)} for name, data in fixtures()]
    # Validate behavior against the actual returned labels, not fixture labels.
    for probe in probes:
        measured = probe["measurement"]
        assert measured["supervisedTokens"] > 0
        for token, mask in zip(measured["tokens"], measured["assistantMask"], strict=True):
            assert token["label"] == -100 or mask == 1
        for region in measured["assistantRanges"]:
            if not region["selected"]:
                assert all(token["label"] == -100 for token in measured["tokens"]
                           if token["start"] < region["end"] and token["end"] > region["start"])
    assert "None" not in probes[1]["measurement"]["renderedText"]
    assert probes[3]["measurement"]["renderedText"].count("<tool_response>") == 2

    prefixes = []
    for calls in [[call()], [call(), call("inspect-2", "lanterne", 3)]]:
        messages = CONTEXT + [{"role": "assistant", "content": "", "tool_calls": calls}]
        result = {"role": "tool", "content": "Le résultat public est 22.", "tool_call_id": "inspect-1", "name": "inspect"}
        prefixes.append(runtime.prefix(messages, result, TOOLS))

    truncation_checks = []
    for role in ["user", "assistant"]:
        messages = [{"role": "user", "content": "Contexte court."}, {"role": "assistant", "content": "Réponse courte."}]
        messages[0 if role == "user" else 1]["content"] = "long " * 4200
        try:
            runtime.measure(example(messages, [1]))
        except ValueError as error:
            assert "never truncated" in str(error)
            truncation_checks.append({"region": "context" if role == "user" else "target", "repeat": 4200,
                                      "repeatedText": "long ", "maxSequenceLength": 4096, "error": str(error)})
        else:
            raise AssertionError("an overlength example was accepted")

    # Real batched collation: separate rows and -100 padding; no packing.
    features = [{"input_ids": probe["measurement"]["inputIds"], "labels": probe["measurement"]["labels"]} for probe in probes[:2]]
    collated = runtime.collator(features)
    lengths = [len(feature["input_ids"]) for feature in features]
    for row, feature in enumerate(features):
        assert collated["labels"][row, :lengths[row]].tolist() == feature["labels"]
        assert all(label == -100 for label in collated["labels"][row, lengths[row]:].tolist())
    profile = {"binding": runtime.binding, "toolCallSupervisionProbes": [segment for probe in probes for segment in probe["measurement"]["toolCallProbes"]],
               "prefixPreservation": {**runtime.binding, "samples": prefixes}}
    bundle = {"version": "qwen3-tokenizer-evidence-v1", "modelId": MODEL, "tokenizerRevision": REVISION,
              "templateDigest": TEMPLATE_SHA, "templateSource": TEMPLATE_URL, "assets": runtime.manifest,
              "runtimeVersions": runtime.versions, "pythonVersion": platform.python_version(),
              "runtimeScriptDigest": sha(Path(__file__).with_name("runtime.py").read_bytes()),
              "measurementScriptDigest": sha(Path(__file__).read_bytes()),
              "prepareScriptDigest": sha(Path(__file__).with_name("prepare.py").read_bytes()),
              "collator": "trl.trainer.sft_trainer.DataCollatorForLanguageModeling", "packing": False,
              "maxSequenceLength": 4096, "profileEvidence": profile, "probes": probes,
              "truncationChecks": truncation_checks, "paddingCheck": {"lengths": lengths, "shape": list(collated["labels"].shape),
                                                                         "labels": collated["labels"].tolist(), "attentionMask": collated["attention_mask"].tolist()}}
    output.mkdir(parents=True, exist_ok=True)
    contents = {"qwen3-8b.json": (json.dumps(bundle, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
                "qwen3_training.jinja": runtime.template.encode("utf-8")}
    manifest = {"version": "qwen3-tokenizer-evidence-v1", "files": {name: sha(data) for name, data in contents.items()}}
    for name, data in contents.items():
        (output / name).write_bytes(data)
    (output / "checksums.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"probes": [{"id": probe["id"], "totalTokens": probe["measurement"]["totalTokens"], "supervisedTokens": probe["measurement"]["supervisedTokens"]} for probe in probes],
            "prefixProbes": len(prefixes), "truncationRefusals": len(truncation_checks), "checksums": manifest}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(measure(args.assets, args.output), indent=2))
