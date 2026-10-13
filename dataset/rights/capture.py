"""Capture public upstream terms as exact bytes; no API calls or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

SOURCES = [
    ("deepseek-open-platform-terms.html", "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html"),
    ("deepseek-terms-of-use.html", "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html"),
]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    files = []
    for name, url in SOURCES:
        with urlopen(url, timeout=60) as response:
            data = response.read()
        if b"training other models" not in data or b"model distillation" not in data:
            raise ValueError("fetched terms lack the inspected output-training permission; review the changed source")
        (args.output / name).write_bytes(data)
        files.append({"file": name, "url": url, "sha256": hashlib.sha256(data).hexdigest()})
    print(json.dumps({"files": files}, indent=2))
