"""Generate the frozen P12 development/test split without model calls."""

from __future__ import annotations

import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
P1 = ROOT / "p1"
sys.path.insert(0, str(P1))

from gavagai import make_items  # noqa: E402
from lexicon import make_lexicon  # noqa: E402


TEST_SEEDS = (101, 211, 307, 401, 503)
PER_TYPE = 6


def tag_rows(rows: list[dict], split: str, seed: int) -> list[dict]:
    tagged = []
    for row in rows:
        row = dict(row)
        row["generator_seed"] = seed
        row["split"] = split
        row["source_id"] = row["id"]
        row["id"] = f"S{seed}-{row['id']}"
        tagged.append(row)
    return tagged


def main() -> None:
    dev_blob = json.loads((P1 / "items_p1.json").read_text())
    dev = tag_rows(dev_blob["items"], "dev", int(dev_blob["meta"]["seed"]))

    test: list[dict] = []
    seed_meta = []
    for seed in TEST_SEEDS:
        words, meta = make_lexicon(PER_TYPE * 5, seed=seed)
        rows = tag_rows(make_items(words, per_type=PER_TYPE, seed=seed), "test", seed)
        test.extend(rows)
        seed_meta.append(meta)

    out = {
        "protocol": "PROTOCOL.md",
        "dev": {"n": len(dev), "seeds": [11], "items": dev},
        "test": {"n": len(test), "seeds": list(TEST_SEEDS), "items": test},
        "test_lexicon_meta": seed_meta,
    }
    path = HERE / "p12_splits.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {path}: dev={len(dev)}, test={len(test)}")


if __name__ == "__main__":
    main()

