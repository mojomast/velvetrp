"""Real HF rendering/masks with target-selection overlay and an actual TRL collator.

JSON stdin/stdout protocol. All assets load locally; this runtime never downloads
weights, calls a teacher or trains. Assistant masks are eligibility, not blanket
approval of assistant history. Empty thinking scaffolding is a generation prefix,
so it is excluded from visible-target loss even though the upstream template marks
it as generation. Final labels, not provider usage, determine training-token cost.
"""
import argparse
import hashlib
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

from prepare import EXPECTED_SHA256, MODEL, REVISION, TEMPLATE_SHA, TEMPLATE_URL

VERSIONS = {"transformers": "5.19.0", "trl": "1.15.0", "tokenizers": "0.23.3", "torch": "2.14.1+cpu", "Jinja2": "3.1.6"}
THINK_PREFIX = "<think>\n\n</think>\n\n"
TERMINATOR = "<|im_end|>"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utf16_index(text: str, index: int) -> int:
    return len(text[:index].encode("utf-16-le")) // 2


class Runtime:
    def __init__(self, assets: Path):
        self.versions = {name: importlib.metadata.version(name) for name in VERSIONS}
        if self.versions != VERSIONS:
            raise ValueError("installed tokenizer runtime does not match pinned package versions")
        manifest = json.loads((assets / "assets.json").read_text(encoding="utf-8"))
        if manifest != {"modelId": MODEL, "tokenizerRevision": REVISION, "templateDigest": TEMPLATE_SHA, "files": EXPECTED_SHA256}:
            raise ValueError("asset manifest does not match immutable tokenizer pins")
        for filename, digest in EXPECTED_SHA256.items():
            if sha((assets / filename).read_bytes()) != digest:
                raise ValueError(f"tokenizer asset checksum mismatch: {filename}")
        self.manifest = manifest
        self.template = (assets / "qwen3_training.jinja").read_text(encoding="utf-8")
        from transformers import AutoTokenizer
        from trl.trainer.sft_trainer import DataCollatorForLanguageModeling
        self.tokenizer = AutoTokenizer.from_pretrained(assets, local_files_only=True, trust_remote_code=False)
        if self.tokenizer.convert_tokens_to_ids(TERMINATOR) != 151645:
            raise ValueError("incorrect Qwen3 end-of-turn token ID")
        self.collator = DataCollatorForLanguageModeling(pad_token_id=self.tokenizer.pad_token_id, padding_free=False)
        self.binding = {"templateDigest": TEMPLATE_SHA, "tokenizerRevision": REVISION,
                        "trlVersion": VERSIONS["trl"], "transformersVersion": VERSIONS["transformers"], "thinkingMode": "disabled"}

    def render(self, messages, tools=None, generation_prompt=False):
        return self.tokenizer.apply_chat_template(messages, tools=tools, chat_template=self.template,
                                                 tokenize=False, add_generation_prompt=generation_prompt, enable_thinking=False)

    def measure(self, example: dict, maximum: int = 4096) -> dict:
        from transformers.utils.chat_template_utils import render_jinja_template
        if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
            raise ValueError("sequence limit must be a positive integer")
        messages = example.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("a nonempty message list is required")
        # Normalize the production call-only null once; the runtime never renders
        # the Python spelling 'None' as assistant content.
        messages = [dict(message) for message in messages]
        for message in messages:
            if message.get("role") not in {"system", "user", "assistant", "tool"}:
                raise ValueError("unsupported message role")
            if message.get("content") is None and message["role"] == "assistant" and message.get("tool_calls"):
                message["content"] = ""
            if not isinstance(message.get("content"), str):
                raise ValueError("message content must be a string")
            if message["role"] == "assistant":
                if message.get("reasoning_content") or any(tag in message["content"] for tag in ["<think>", "</think>", "<|im_start|>", TERMINATOR]):
                    raise ValueError("thinking/control content is unsupported in the disabled-thinking target")
                for call in message.get("tool_calls", []):
                    function = call.get("function", {})
                    if not isinstance(function.get("arguments"), dict) or not isinstance(function.get("name"), str):
                        raise ValueError("tool arguments must be objects and tool names must be strings")
        selection = example.get("targetSelection", {})
        chosen = set()
        for key, content_key in [("supervisedAssistantIndices", "content"), ("supervisedToolCallIndices", "tool_calls")]:
            indices = selection.get(key)
            if not isinstance(indices, list) or len(set(indices)) != len(indices):
                raise ValueError("target selection must contain unique index arrays")
            for index in indices:
                if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(messages):
                    raise ValueError("invalid target index")
                if messages[index]["role"] != "assistant" or not messages[index].get(content_key):
                    raise ValueError("target index does not select assistant output")
                chosen.add(index)
        for index in chosen:
            if messages[index]["content"].strip() and index not in selection["supervisedAssistantIndices"]:
                raise ValueError("selected mixed response omits prose supervision")
            if messages[index].get("tool_calls") and index not in selection["supervisedToolCallIndices"]:
                raise ValueError("selected mixed response omits tool-call supervision")

        tools = example.get("tools")
        rendered = self.render(messages, tools)
        encoding = self.tokenizer.apply_chat_template(
            messages, tools=tools, chat_template=self.template, tokenize=True, return_dict=True,
            return_assistant_tokens_mask=True, add_generation_prompt=False, enable_thinking=False,
            truncation=False, tokenizer_kwargs={"return_offsets_mapping": True},
        )
        ids = encoding["input_ids"]
        if len(ids) > maximum:
            raise ValueError(f"sequence has {len(ids)} tokens, exceeding {maximum}; required context and targets are never truncated")
        texts, tracked = render_jinja_template(
            [messages], tools=tools, chat_template=self.template, return_assistant_tokens_mask=True,
            add_generation_prompt=False, enable_thinking=False, **self.tokenizer.special_tokens_map,
        )
        if texts != [rendered] or self.tokenizer.decode(ids, skip_special_tokens=False) != rendered:
            raise ValueError("rendered text and token decoding differ")
        assistants = [(index, message) for index, message in enumerate(messages) if message["role"] == "assistant"]
        if len(tracked[0]) != len(assistants):
            raise ValueError("generation ranges do not match assistant turns")
        ranges = []
        calls = []
        assistant_ranges = []
        for (index, message), (start, end) in zip(assistants, tracked[0], strict=True):
            segment = rendered[start:end]
            if not segment.startswith(THINK_PREFIX) or not segment.endswith(TERMINATOR + "\n"):
                raise ValueError("unexpected Qwen3 assistant generation structure")
            body_start = start + len(THINK_PREFIX)
            body_end = end - len(TERMINATOR + "\n")
            visible = message["content"].lstrip("\n")
            if rendered[body_start:body_start + len(visible)] != visible:
                raise ValueError("rendered visible assistant content differs from the input")
            cursor = body_start + len(visible)
            for call in message.get("tool_calls", []):
                if rendered[cursor:cursor + 1] == "\n":
                    cursor += 1
                call_start = cursor
                opener = "<tool_call>\n"
                if not rendered[cursor:].startswith(opener):
                    raise ValueError("missing serialized tool-call opening")
                cursor += len(opener)
                parsed, consumed = json.JSONDecoder().raw_decode(rendered[cursor:])
                cursor += consumed
                closer = "\n</tool_call>"
                if not rendered[cursor:].startswith(closer) or parsed != call["function"]:
                    raise ValueError("serialized tool-call name/arguments/closing syntax differ")
                cursor += len(closer)
                calls.append({"messageIndex": index, "call": call["function"], "start": call_start, "end": cursor,
                              "terminatorStart": body_end, "terminatorEnd": body_end + len(TERMINATOR)})
            if cursor != body_end:
                raise ValueError("unaccounted assistant output outside prose and tool calls")
            assistant_ranges.append({"messageIndex": index, "start": utf16_index(rendered, start), "end": utf16_index(rendered, end),
                                     "selected": index in chosen, "targetStart": utf16_index(rendered, body_start),
                                     "targetEnd": utf16_index(rendered, body_end + len(TERMINATOR))})
            if index in chosen:
                ranges.append((body_start, body_end + len(TERMINATOR)))

        labels = []
        tokens = []
        for token_id, (start, end), assistant_mask in zip(ids, encoding["offset_mapping"], encoding["assistant_masks"], strict=True):
            contained = any(start >= left and end <= right for left, right in ranges)
            overlaps = any(start < right and end > left for left, right in ranges)
            if overlaps and not contained:
                raise ValueError("token crosses a selected-target boundary; refusing a partial loss label")
            if contained and not assistant_mask:
                raise ValueError("target token is outside the measured Transformers assistant mask")
            label = token_id if contained and end > start else -100
            labels.append(label)
            tokens.append({"start": utf16_index(rendered, start), "end": utf16_index(rendered, end), "tokenId": token_id, "label": label})
        # Current TRL accepts explicit labels. The overlay is applied before
        # collation, then measured against the ACTUAL CPU collator output.
        batch = self.collator([{"input_ids": ids, "labels": labels}])
        final_labels = batch["labels"][0].tolist()
        if final_labels != labels or batch["input_ids"][0].tolist() != ids:
            raise ValueError("TRL collation changed measured tokens or selective labels")
        probes = [{**self.binding, "renderedText": rendered, "call": call["call"],
                   "serializedCall": {"start": utf16_index(rendered, call["start"]), "end": utf16_index(rendered, call["end"])},
                   "turnTerminator": {"start": utf16_index(rendered, call["terminatorStart"]), "end": utf16_index(rendered, call["terminatorEnd"])},
                   "tokens": tokens} for call in calls if call["messageIndex"] in chosen]
        return {"binding": self.binding, "renderedText": rendered, "inputIds": ids, "labels": final_labels,
                "assistantMask": encoding["assistant_masks"], "tokens": tokens, "assistantRanges": assistant_ranges,
                "toolCallProbes": probes, "supervisedTokens": sum(label != -100 for label in final_labels),
                "totalTokens": len(ids), "maxSequenceLength": maximum}

    def prefix(self, messages, result, tools):
        before = self.render(messages, tools)
        after = self.render(messages + [result], tools)
        before_ids = self.tokenizer(before, add_special_tokens=False)["input_ids"]
        after_ids = self.tokenizer(after, add_special_tokens=False)["input_ids"]
        if not after.startswith(before) or after_ids[:len(before_ids)] != before_ids:
            raise ValueError("appending a tool result changed prior assistant text or tokens")
        return {"messages": messages, "appendedToolMessage": result, "before": before, "after": after,
                "beforeTokenIds": before_ids, "afterTokenIds": after_ids}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read()
        request = json.loads(raw)
        runtime = Runtime(args.assets)
        measured = runtime.measure(request["example"], request.get("maxSequenceLength", 4096))
        measured["requestDigest"] = sha(raw)
        measured["runtimeVersions"] = runtime.versions
        measured["runtimeScriptDigest"] = sha(Path(__file__).read_bytes())
        print(json.dumps(measured, ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
