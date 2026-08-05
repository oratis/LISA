"""P13 natural usage extraction plus generated-candidate admission."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys

import torch


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
P12 = ROOT / "p12"
sys.path.insert(0, str(P12))

from eval_gate import BinaryScorer, base_definition, definition, question, usage_prompt  # noqa: E402


MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
ACCEPT_Z = 1.1428607599918683
SEED = 20260805
POSITIVE_TEMPLATES = (
    'Looking at {body}, Tovi says, "That is definitely {word}."',
    'Tovi points to {body} and calls it "{word}."',
)
NEGATIVE_TEMPLATES = (
    'Looking at {body}, Tovi says, "I would not call that {word}."',
    'Asked about {body}, Tovi replies, "No, that is not {word}."',
)


def auc(pos: list[float], neg: list[float]) -> float:
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (
        len(pos) * len(neg)
    )


def extraction_prompt(item: dict, body: str, label: str, template_index: int) -> tuple[str, str]:
    templates = POSITIVE_TEMPLATES if label == "Yes" else NEGATIVE_TEMPLATES
    utterance = templates[template_index % len(templates)].format(
        body=body, word=item["word"]
    )
    prompt = (
        f'Speaker utterance: {utterance}\nDoes Tovi apply the word "{item["word"]}" '
        "to the described object or situation? Answer Yes or No.\nAnswer:"
    )
    return utterance, prompt


def choose_extraction_threshold(records: list[dict]) -> dict:
    vals = sorted(set(r["p_apply"] for r in records))
    candidates = [vals[0] - 1e-9] + [
        (a + b) / 2 for a, b in zip(vals, vals[1:])
    ] + [vals[-1] + 1e-9]
    best = None
    for threshold in candidates:
        accuracy = sum((r["p_apply"] > threshold) == (r["label"] == "Yes") for r in records) / len(records)
        point = (accuracy, -abs(threshold - 0.5), -threshold)
        if best is None or point > best[0]:
            best = (point, threshold, accuracy)
    assert best is not None
    return {"threshold": best[1], "dev_accuracy": best[2]}


def extraction_metrics(records: list[dict], threshold: float) -> dict:
    pos = [r["p_apply"] for r in records if r["label"] == "Yes"]
    neg = [r["p_apply"] for r in records if r["label"] == "No"]
    tp = sum(x > threshold for x in pos)
    tn = sum(x <= threshold for x in neg)
    return {
        "n": len(records),
        "auc": auc(pos, neg),
        "accuracy": (tp + tn) / len(records),
        "sensitivity": tp / len(pos),
        "specificity": tn / len(neg),
    }


def induction_prompt(item: dict) -> str:
    examples = "\n".join(
        f"- {question(item, body)} -> Tovi answers {label}"
        for body, label in item["teaching"]
    )
    return (
        f'Tovi introduced the unfamiliar word "{item["word"]}".\n'
        f"Teaching examples:\n{examples}\n"
        "Infer one concise dictionary-style meaning that is consistent with every example. "
        "Several meanings may be possible. Output only the meaning phrase, without explanation.\n"
        "Meaning:"
    )


def clean_candidate(text: str, word: str) -> str:
    text = text.strip().splitlines()[0] if text.strip() else ""
    text = re.sub(r"^(meaning|definition)\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"^[-*\d.)\s]+", "", text)
    if " means " in text.lower():
        text = re.split(r"\s+means\s+", text, maxsplit=1, flags=re.I)[1]
    text = text.strip(" \t\"'`.*")
    if text.lower().startswith(word.lower()):
        text = text[len(word):].lstrip(" :-")
    words = text.split()
    if len(words) > 14:
        text = " ".join(words[:14])
    return text or "a thing"


@torch.inference_mode()
def generate_candidates(
    scorer: BinaryScorer, items: list[dict], seed: int
) -> dict[str, list[str]]:
    torch.manual_seed(seed)
    output: dict[str, list[str]] = {}
    scorer.tokenizer.padding_side = "left"
    prompts = [induction_prompt(item) for item in items]
    batch_size = 8
    for start in range(0, len(items), batch_size):
        batch_items = items[start : start + batch_size]
        batch_prompts = prompts[start : start + batch_size]
        enc = scorer.tokenizer(batch_prompts, padding=True, return_tensors="pt")
        enc = {k: v.to(scorer.device) for k, v in enc.items()}
        generated = scorer.model.generate(
            **enc,
            do_sample=True,
            temperature=0.8,
            top_p=0.9,
            max_new_tokens=18,
            num_return_sequences=4,
            pad_token_id=scorer.tokenizer.pad_token_id,
        )
        prefix_len = enc["input_ids"].shape[1]
        decoded = scorer.tokenizer.batch_decode(generated[:, prefix_len:], skip_special_tokens=True)
        for j, item in enumerate(batch_items):
            vals = []
            for text in decoded[j * 4 : (j + 1) * 4]:
                c = clean_candidate(text, item["word"])
                if c not in vals:
                    vals.append(c)
            for fallback in ("a thing", "red", "wooden", "large"):
                if len(vals) >= 4:
                    break
                if fallback not in vals:
                    vals.append(fallback)
            output[item["id"]] = vals[:4]
        print(f"[generate] {min(start + batch_size, len(items))}/{len(items)}", flush=True)
    return output


def nll(probs: list[float], labels: list[str]) -> float:
    total = 0.0
    for p, label in zip(probs, labels):
        p = min(max(p, 1e-9), 1 - 1e-9)
        total += -math.log(p if label == "Yes" else 1 - p)
    return total


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    split_blob = json.loads((P12 / "p12_splits.json").read_text())
    all_items = split_blob["dev"]["items"] + split_blob["test"]["items"]
    core_test = [r for r in split_blob["test"]["items"] if r["type"] in {"G1", "G2", "G3"}]
    scorer = BinaryScorer(args.model, batch_size=args.batch_size)
    print(f"[load] {args.model} device={scorer.device}", flush=True)

    extraction_records = []
    extraction_prompts = []
    for item in all_items:
        if item["type"] not in {"G1", "G2", "G3"}:
            continue
        for obs_idx, (body, label) in enumerate(item["heldout"]):
            utterance, prompt = extraction_prompt(item, body, label, obs_idx)
            extraction_records.append(
                {
                    "id": item["id"],
                    "split": item["split"],
                    "obs_idx": obs_idx,
                    "label": label,
                    "utterance": utterance,
                }
            )
            extraction_prompts.append(prompt)
    for record, p in zip(extraction_records, scorer.p_yes(extraction_prompts)):
        record["p_apply"] = p
    dev_extract = [r for r in extraction_records if r["split"] == "dev"]
    test_extract = [r for r in extraction_records if r["split"] == "test"]
    threshold = choose_extraction_threshold(dev_extract)
    extract_result = {
        "threshold_selection": threshold,
        "dev": extraction_metrics(dev_extract, threshold["threshold"]),
        "test": extraction_metrics(test_extract, threshold["threshold"]),
    }
    extracted_labels = {
        (r["id"], r["obs_idx"]): (
            "Yes" if r["p_apply"] > threshold["threshold"] else "No"
        )
        for r in extraction_records
    }
    print(f"[extract] {extract_result}", flush=True)

    generated = generate_candidates(scorer, core_test, args.seed)
    prompt_meta = []
    prompts = []
    item_candidates = {}
    for item in core_test:
        cands = generated[item["id"]]
        first = cands[0]
        nulls = [
            f"{first} and shiny",
            f"{first} and small",
            "red",
            "wooden",
            "a thing",
            f"not {first}",
        ]
        item_candidates[item["id"]] = {"generated": cands, "nulls": nulls}
        entries = [(f"candidate{i}", c) for i, c in enumerate(cands)]
        entries += [(f"null{i}", c) for i, c in enumerate(nulls)]
        entries += [("base", None)]
        for name, meaning in entries:
            prefix = base_definition(item["word"]) if meaning is None else definition(item["word"], meaning, "canonical")
            for obs_idx, (body, _label) in enumerate(item["heldout"]):
                prompt_meta.append((item["id"], name, obs_idx))
                prompts.append(usage_prompt(prefix, item, body))
    probabilities = scorer.p_yes(prompts)
    scored = {}
    grouped = {}
    for meta, p in zip(prompt_meta, probabilities):
        grouped.setdefault(meta[:2], []).append((meta[2], p))
    by_id = {item["id"]: item for item in core_test}
    for item_id, pools in item_candidates.items():
        item = by_id[item_id]
        true_labels = [label for _body, label in item["heldout"]]
        extracted = [extracted_labels[(item_id, i)] for i in range(len(true_labels))]
        base_probs = [p for _i, p in sorted(grouped[(item_id, "base")])]
        base_true = nll(base_probs, true_labels)
        base_extracted = nll(base_probs, extracted)
        records = []
        entries = [(f"candidate{i}", c) for i, c in enumerate(pools["generated"])]
        entries += [(f"null{i}", c) for i, c in enumerate(pools["nulls"])]
        for name, meaning in entries:
            ps = [p for _i, p in sorted(grouped[(item_id, name)])]
            records.append(
                {
                    "name": name,
                    "meaning": meaning,
                    "dnll_true": base_true - nll(ps, true_labels),
                    "dnll_extracted": base_extracted - nll(ps, extracted),
                }
            )
        null_values = [r["dnll_extracted"] for r in records if r["name"].startswith("null")]
        mu = sum(null_values) / len(null_values)
        sd = math.sqrt(sum((x - mu) ** 2 for x in null_values) / (len(null_values) - 1)) or 1e-9
        for rec in records:
            rec["z_extracted"] = (rec["dnll_extracted"] - mu) / sd
        generated_records = [r for r in records if r["name"].startswith("candidate")]
        selected = max(generated_records, key=lambda r: r["z_extracted"])
        oracle = max(generated_records, key=lambda r: r["dnll_true"])
        scored[item_id] = {
            "type": item["type"],
            "generated": generated_records,
            "selected": selected,
            "oracle": oracle,
            "admitted": selected["z_extracted"] > ACCEPT_Z,
            "first_true_gain": generated_records[0]["dnll_true"],
            "selection_regret": oracle["dnll_true"] - selected["dnll_true"],
        }

    values = list(scored.values())
    admitted = [r for r in values if r["admitted"]]
    summary = {
        "n_items": len(values),
        "coverage": len(admitted) / len(values),
        "beneficial_admission_precision": (
            sum(r["selected"]["dnll_true"] > 0 for r in admitted) / len(admitted)
            if admitted else None
        ),
        "mean_true_gain_first_write_all": sum(r["first_true_gain"] for r in values) / len(values),
        "mean_true_gain_selected_all": sum(r["selected"]["dnll_true"] for r in values) / len(values),
        "mean_true_gain_selected_admitted": (
            sum(r["selected"]["dnll_true"] for r in admitted) / len(admitted)
            if admitted else None
        ),
        "mean_true_gain_oracle": sum(r["oracle"]["dnll_true"] for r in values) / len(values),
        "mean_selection_regret": sum(r["selection_regret"] for r in values) / len(values),
    }
    payload = {
        "model": args.model,
        "generation_seed": args.seed,
        "protocol": "PROTOCOL.md",
        "accept_z_from_p12": ACCEPT_Z,
        "extraction": extract_result,
        "candidate_loop": summary,
        "items": scored,
        "extraction_records": extraction_records,
    }
    out = args.output or HERE / "p13_Qwen2.5-1.5B-Instruct.json"
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"[candidate-loop] {summary}", flush=True)
    print(f"[saved] {out}", flush=True)


if __name__ == "__main__":
    main()
