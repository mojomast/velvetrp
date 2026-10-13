"""Real CPU integration tests; no fake tokenizer, provider, weights or training."""
import json
import os
import unittest
from pathlib import Path

from runtime import Runtime
from measure import fixtures, example, CONTEXT, call


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = Runtime(Path(os.environ.get("FOUNDRY_TOKENIZER_ASSETS", ".dataset/tokenizer/qwen3-8b")))

    def test_recorded_traces_reproduce_exactly(self):
        bundle = json.loads(Path(__file__).with_name("evidence").joinpath("qwen3-8b.json").read_text(encoding="utf-8"))
        for probe in bundle["probes"]:
            with self.subTest(probe=probe["id"]):
                measured = self.runtime.measure(probe["example"])
                self.assertEqual(measured, probe["measurement"])

    def test_history_is_not_blanket_assistant_loss(self):
        data = dict(fixtures())["unapproved-assistant-history"]
        measured = self.runtime.measure(data)
        old = measured["assistantRanges"][0]
        indices = [index for index, token in enumerate(measured["tokens"]) if token["start"] < old["end"] and token["end"] > old["start"]]
        self.assertTrue(any(measured["assistantMask"][index] for index in indices))
        self.assertTrue(all(measured["labels"][index] == -100 for index in indices))

    def test_mixed_targets_cannot_drop_prose_or_calls(self):
        data = dict(fixtures())["mixed-prose-and-call"]
        for selection in [{"supervisedAssistantIndices": [2], "supervisedToolCallIndices": []},
                          {"supervisedAssistantIndices": [], "supervisedToolCallIndices": [2]}]:
            with self.assertRaisesRegex(ValueError, "omits .* supervision"):
                self.runtime.measure({**data, "targetSelection": selection})

    def test_invalid_targets_and_string_arguments_refuse(self):
        data = dict(fixtures())["tool-round-trip"]
        for selection in [{"supervisedAssistantIndices": [3], "supervisedToolCallIndices": []},
                          {"supervisedAssistantIndices": [4, 4], "supervisedToolCallIndices": []},
                          {"supervisedAssistantIndices": [True], "supervisedToolCallIndices": []}]:
            with self.assertRaises(ValueError):
                self.runtime.measure({**data, "targetSelection": selection})
        bad_call = call()
        bad_call["function"]["arguments"] = '{"target":"ledger"}'
        with self.assertRaisesRegex(ValueError, "arguments must be objects"):
            self.runtime.measure(example(CONTEXT + [{"role": "assistant", "content": "", "tool_calls": [bad_call]}], [], [2], True))

    def test_no_selected_target_means_zero_training_tokens(self):
        data = example([{ "role": "user", "content": "Context"}, {"role": "assistant", "content": "History only"}], [])
        measured = self.runtime.measure(data)
        self.assertEqual(measured["supervisedTokens"], 0)
        self.assertTrue(all(label == -100 for label in measured["labels"]))

    def test_context_and_target_overflow_refuse_without_truncation(self):
        for index in [0, 1]:
            messages = [{"role": "user", "content": "Context"}, {"role": "assistant", "content": "Target"}]
            messages[index]["content"] = "long " * 4200
            with self.assertRaisesRegex(ValueError, "never truncated"):
                self.runtime.measure(example(messages, [1]))

    def test_nonempty_reasoning_refuses_in_disabled_thinking_mode(self):
        with self.assertRaisesRegex(ValueError, "thinking/control content"):
            self.runtime.measure(example([{ "role": "assistant", "content": "<think>secret</think>answer"}], [0]))

    def test_batched_collation_keeps_rows_and_masks_padding(self):
        measured = [self.runtime.measure(data) for _, data in fixtures()[:2]]
        features = [{"input_ids": data["inputIds"], "labels": data["labels"]} for data in measured]
        batch = self.runtime.collator(features)
        self.assertEqual(batch["labels"].shape[0], 2)
        for row, feature in enumerate(features):
            length = len(feature["input_ids"])
            self.assertEqual(batch["labels"][row, :length].tolist(), feature["labels"])
            self.assertTrue(all(label == -100 for label in batch["labels"][row, length:].tolist()))
            self.assertTrue(all(mask == 0 for mask in batch["attention_mask"][row, length:].tolist()))


if __name__ == "__main__":
    unittest.main()
