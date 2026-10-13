"""Download only public, pinned tokenizer assets; no model weights or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

MODEL = "Qwen/Qwen3-8B"
REVISION = "b968826d9c46dd6066d109eabc6255188de91218"
TEMPLATE_URL = "https://raw.githubusercontent.com/huggingface/trl/63b7c3f547d3e06d0eae72712e36b7b64e9d5a45/trl/chat_templates/qwen3_training.jinja"
TEMPLATE_SHA = "1d944ff8f268b611abb296cdd24d0f51981eef1c8647ac321c3a0258f61eb6c9"
FILENAMES = ["tokenizer.json", "tokenizer_config.json", "config.json"]
EXPECTED_SHA256 = {
    "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
    "tokenizer_config.json": "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101",
    "config.json": "f7c4eadfbbf522470667b797a3c89be2524832d2d599797248dc304fff447c30",
    "qwen3_training.jinja": TEMPLATE_SHA,
}


def prepare(destination: Path) -> dict:
    destination.mkdir(parents=True, exist_ok=True)
    checksums = {}
    for filename in FILENAMES + ["qwen3_training.jinja"]:
        url = TEMPLATE_URL if filename.endswith(".jinja") else f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{filename}"
        with urlopen(url, timeout=120) as response:
            data = response.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest != EXPECTED_SHA256[filename]:
            raise ValueError(f"downloaded asset differs from the pinned SHA-256: {filename}")
        path = destination / filename
        if path.exists() and path.read_bytes() != data:
            raise ValueError(f"refusing to overwrite changed tokenizer asset: {filename}")
        path.write_bytes(data)
        checksums[filename] = digest
    manifest = {"modelId": MODEL, "tokenizerRevision": REVISION, "templateDigest": TEMPLATE_SHA, "files": checksums}
    (destination / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    print(json.dumps(prepare(parser.parse_args().assets), indent=2))
