"""Zero-shot pseudoword and tokenization controls on the frozen P12 test set."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from eval_gate import BinaryScorer, DEFAULT_MODELS, base_definition, usage_prompt  # noqa: E402


def auc(pos: list[float], neg: list[float]) -> float:
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (
        len(pos) * len(neg)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=DEFAULT_MODELS, default=DEFAULT_MODELS[0])
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()

    blob = json.loads((HERE / "p12_splits.json").read_text())
    items = blob["test"]["items"]
    scorer = BinaryScorer(args.model, args.batch_size)
    prompts, meta = [], []
    token_counts = {}
    for item in items:
        token_counts[item["id"]] = len(
            scorer.tokenizer.encode(item["word"], add_special_tokens=False)
        )
        for obs_idx, (body, label) in enumerate(item["heldout"]):
            prompts.append(usage_prompt(base_definition(item["word"]), item, body))
            meta.append((item["id"], item["type"], item["generator_seed"], obs_idx, label))
    probs = scorer.p_yes(prompts)
    records = [
        {
            "id": item_id,
            "type": item_type,
            "generator_seed": seed,
            "obs_idx": obs_idx,
            "label": label,
            "p_yes": p,
        }
        for (item_id, item_type, seed, obs_idx, label), p in zip(meta, probs)
    ]

    def summary(rows: list[dict]) -> dict:
        pos = [r["p_yes"] for r in rows if r["label"] == "Yes"]
        neg = [r["p_yes"] for r in rows if r["label"] == "No"]
        return {"n": len(rows), "auc": auc(pos, neg), "mean_positive": sum(pos) / len(pos), "mean_negative": sum(neg) / len(neg)}

    result = {
        "model": args.model,
        "n_items": len(items),
        "zero_shot": {
            "all": summary(records),
            "by_type": {
                t: summary([r for r in records if r["type"] == t])
                for t in sorted({r["type"] for r in records})
            },
            "by_seed": {
                str(seed): summary([r for r in records if int(r["generator_seed"]) == seed])
                for seed in sorted({int(r["generator_seed"]) for r in records})
            },
        },
        "tokenization": {
            "mean_tokens_per_word": sum(token_counts.values()) / len(token_counts),
            "min_tokens_per_word": min(token_counts.values()),
            "max_tokens_per_word": max(token_counts.values()),
            "single_token_rate": sum(x == 1 for x in token_counts.values()) / len(token_counts),
            "counts": token_counts,
        },
    }
    tag = args.model.split("/")[-1]
    out = HERE / f"contamination_{tag}.json"
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"model": args.model, "zero_shot": result["zero_shot"], "tokenization": {k: v for k, v in result["tokenization"].items() if k != "counts"}}, indent=2))
    print(f"[saved] {out}")


if __name__ == "__main__":
    main()
