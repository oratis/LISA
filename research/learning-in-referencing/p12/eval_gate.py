"""Run the frozen P12 candidate-score evaluation.

The script intentionally computes every score from the same cached binary
predictions. It never chooses a threshold and never reads evaluation labels
other than the speaker's observed usage decisions needed by predictive gain.
Threshold selection and statistical testing live in analyze.py.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
from typing import Iterable

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


HERE = Path(__file__).resolve().parent
DEFAULT_MODELS = (
    "Qwen/Qwen2.5-1.5B-Instruct",
    "Qwen/Qwen2.5-3B-Instruct",
    "HuggingFaceTB/SmolLM2-1.7B-Instruct",
)
PROMPT_VARIANTS = ("canonical", "dictionary")
YES_FORMS = (" Yes", " yes", "Yes", "yes")
NO_FORMS = (" No", " no", "No", "no")


def chunks(xs: list, n: int) -> Iterable[list]:
    for i in range(0, len(xs), n):
        yield xs[i : i + n]


def entropy(p: float) -> float:
    p = min(max(p, 1e-9), 1 - 1e-9)
    return -(p * math.log(p) + (1 - p) * math.log(1 - p))


def bernoulli_kl(p: float, q: float) -> float:
    p = min(max(p, 1e-9), 1 - 1e-9)
    q = min(max(q, 1e-9), 1 - 1e-9)
    return p * math.log(p / q) + (1 - p) * math.log((1 - p) / (1 - q))


def definition(word: str, meaning: str, variant: str) -> str:
    if variant == "canonical":
        return f"{word} means {meaning}."
    if variant == "dictionary":
        return f'In Tovi\'s language, "{word}" applies exactly to {meaning}.'
    raise ValueError(variant)


def base_definition(word: str) -> str:
    return f"{word} is an unfamiliar word in Tovi's language."


def question(item: dict, body: str) -> str:
    if item["type"] == "G4":
        return body
    return f"Is {body} {item['word']}?"


def usage_prompt(prefix: str, item: dict, body: str) -> str:
    return f"{prefix}\nQuestion: {question(item, body)} Answer Yes or No.\nAnswer:"


def support_prompt(item: dict, candidate_statement: str) -> str:
    examples = "\n".join(
        f"- {question(item, body)} -> {label}" for body, label in item["teaching"]
    )
    return (
        "A speaker introduced an unfamiliar word. Here are all teaching examples:\n"
        f"{examples}\nCandidate definition: {candidate_statement}\n"
        "Is the candidate definition fully supported by and consistent with the teaching examples? "
        "Answer Yes or No.\nAnswer:"
    )


class BinaryScorer:
    def __init__(self, model_id: str, batch_size: int) -> None:
        self.model_id = model_id
        self.batch_size = batch_size
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.tokenizer = AutoTokenizer.from_pretrained(model_id, local_files_only=True)
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "left"
        self.model = AutoModelForCausalLM.from_pretrained(
            model_id, dtype=torch.bfloat16, local_files_only=True
        ).to(self.device).eval()
        self.yes_ids = self._first_ids(YES_FORMS)
        self.no_ids = self._first_ids(NO_FORMS)

    def _first_ids(self, forms: tuple[str, ...]) -> list[int]:
        ids = []
        for form in forms:
            enc = self.tokenizer.encode(form, add_special_tokens=False)
            if enc and enc[0] not in ids:
                ids.append(enc[0])
        if not ids:
            raise RuntimeError(f"no token ids for {forms}")
        return ids

    @torch.inference_mode()
    def p_yes(self, prompts: list[str]) -> list[float]:
        out: list[float] = []
        for batch in chunks(prompts, self.batch_size):
            enc = self.tokenizer(batch, padding=True, return_tensors="pt")
            enc = {k: v.to(self.device) for k, v in enc.items()}
            logits = self.model(**enc).logits[:, -1, :].float()
            logp = torch.log_softmax(logits, dim=-1)
            y = logp[:, self.yes_ids].max(dim=-1).values
            n = logp[:, self.no_ids].max(dim=-1).values
            py = torch.softmax(torch.stack((y, n), dim=-1), dim=-1)[:, 0]
            out.extend(float(x) for x in py.cpu())
        return out

    @torch.inference_mode()
    def model_code_lengths(self, statements: list[str]) -> list[float]:
        """Reference-model NLL of each statement after a fixed neutral header."""
        header = "Notes about Tovi's language:\n"
        full_texts = [header + s for s in statements]
        starts = []
        header_ids = self.tokenizer.encode(header, add_special_tokens=True)
        for text in full_texts:
            full_ids = self.tokenizer.encode(text, add_special_tokens=True)
            common = 0
            for a, b in zip(header_ids, full_ids):
                if a != b:
                    break
                common += 1
            starts.append(max(1, common))

        old_side = self.tokenizer.padding_side
        self.tokenizer.padding_side = "right"
        values: list[float] = []
        cursor = 0
        for batch in chunks(full_texts, self.batch_size):
            enc = self.tokenizer(batch, padding=True, return_tensors="pt")
            input_ids = enc["input_ids"].to(self.device)
            attention = enc["attention_mask"].to(self.device)
            logits = self.model(input_ids=input_ids, attention_mask=attention).logits.float()
            logp = torch.log_softmax(logits, dim=-1)
            for j in range(len(batch)):
                length = int(attention[j].sum().item())
                start = starts[cursor + j]
                total = 0.0
                for pos in range(start, length):
                    total += -float(logp[j, pos - 1, input_ids[j, pos]].item())
                values.append(total)
            cursor += len(batch)
        self.tokenizer.padding_side = old_side
        return values


def candidates(item: dict) -> list[tuple[str, str, str]]:
    rows = [("M", item["M"], "true"), ("Mprime", item["Mprime"], "misreading")]
    rows.extend((f"null{i}", meaning, kind) for i, (meaning, kind) in enumerate(item["nulls"]))
    return rows


def load_items(max_items: int | None) -> list[dict]:
    blob = json.loads((HERE / "p12_splits.json").read_text())
    rows = blob["dev"]["items"] + blob["test"]["items"]
    if max_items is not None:
        rows = rows[:max_items]
    return rows


def run(model_id: str, batch_size: int, max_items: int | None) -> Path:
    items = load_items(max_items)
    scorer = BinaryScorer(model_id, batch_size)
    print(
        f"[load] {model_id} device={scorer.device} items={len(items)} "
        f"yes_ids={scorer.yes_ids} no_ids={scorer.no_ids}",
        flush=True,
    )

    usage_meta: list[tuple[str, str, str, str, int, str]] = []
    usage_prompts: list[str] = []
    support_meta: list[tuple[str, str, str]] = []
    support_prompts: list[str] = []
    code_meta: list[tuple[str, str, str]] = []
    code_statements: list[str] = []

    by_id = {item["id"]: item for item in items}
    for item in items:
        for variant in PROMPT_VARIANTS:
            prefixes = [("base", base_definition(item["word"]))]
            prefixes.extend(
                (name, definition(item["word"], meaning, variant))
                for name, meaning, _ in candidates(item)
            )
            for name, prefix in prefixes:
                for obs_idx, (body, label) in enumerate(item["heldout"]):
                    usage_meta.append((item["id"], item["split"], variant, name, obs_idx, label))
                    usage_prompts.append(usage_prompt(prefix, item, body))

            for name, meaning, _ in candidates(item):
                statement = definition(item["word"], meaning, variant)
                support_meta.append((item["id"], variant, name))
                support_prompts.append(support_prompt(item, statement))
                code_meta.append((item["id"], variant, name))
                code_statements.append(statement)

    print(f"[score] usage prompts={len(usage_prompts)}", flush=True)
    usage_probs = scorer.p_yes(usage_prompts)
    print(f"[score] support prompts={len(support_prompts)}", flush=True)
    support_probs = scorer.p_yes(support_prompts)
    print(f"[score] code statements={len(code_statements)}", flush=True)
    code_lengths = scorer.model_code_lengths(code_statements)

    usage: dict[tuple[str, str, str], list[tuple[int, str, float]]] = defaultdict(list)
    for meta, p in zip(usage_meta, usage_probs):
        item_id, _split, variant, name, obs_idx, label = meta
        usage[(item_id, variant, name)].append((obs_idx, label, p))
    support = {meta: p for meta, p in zip(support_meta, support_probs)}
    model_codes = {meta: v for meta, v in zip(code_meta, code_lengths)}

    rows = []
    vocab_nats = math.log(len(scorer.tokenizer))
    for item in items:
        for variant in PROMPT_VARIANTS:
            base_obs = sorted(usage[(item["id"], variant, "base")])
            base_nll = 0.0
            base_ent = 0.0
            base_ps = []
            for _idx, label, p in base_obs:
                p = min(max(p, 1e-9), 1 - 1e-9)
                base_nll += -math.log(p if label == "Yes" else 1 - p)
                base_ent += entropy(p)
                base_ps.append(p)
            base_ent /= len(base_obs)

            cand_rows = []
            for name, meaning, kind in candidates(item):
                obs = sorted(usage[(item["id"], variant, name)])
                nll = 0.0
                ent = 0.0
                surprise = 0.0
                for j, (_idx, label, p) in enumerate(obs):
                    p = min(max(p, 1e-9), 1 - 1e-9)
                    nll += -math.log(p if label == "Yes" else 1 - p)
                    ent += entropy(p)
                    surprise += bernoulli_kl(p, base_ps[j])
                ent /= len(obs)
                surprise /= len(obs)
                statement = definition(item["word"], meaning, variant)
                l_model = model_codes[(item["id"], variant, name)]
                l_fixed = len(
                    scorer.tokenizer.encode(statement, add_special_tokens=False)
                ) * vocab_nats
                cand_rows.append(
                    {
                        "name": name,
                        "kind": kind,
                        "meaning": meaning,
                        "statement": statement,
                        "nll": nll,
                        "dnll": base_nll - nll,
                        "semantic_entropy": -ent,
                        "surprise": surprise,
                        "support": support[(item["id"], variant, name)],
                        "l_model": l_model,
                        "l_fixed": l_fixed,
                        "simplicity": -l_model,
                    }
                )

            null_scores = [r["dnll"] for r in cand_rows if r["name"].startswith("null")]
            mu = sum(null_scores) / len(null_scores)
            sd = math.sqrt(
                sum((x - mu) ** 2 for x in null_scores) / (len(null_scores) - 1)
            ) or 1e-9
            best_null = max(null_scores)
            pool_cost = math.log(len(cand_rows))
            for rec in cand_rows:
                rec["z"] = (rec["dnll"] - mu) / sd
                rec["placebo_margin"] = rec["dnll"] - best_null
                rec["g_index"] = rec["dnll"] - pool_cost
                rec["g_text_model"] = rec["dnll"] - rec["l_model"]
                rec["g_text_fixed"] = rec["dnll"] - rec["l_fixed"]

            rows.append(
                {
                    "id": item["id"],
                    "source_id": item["source_id"],
                    "split": item["split"],
                    "generator_seed": item["generator_seed"],
                    "type": item["type"],
                    "word": item["word"],
                    "prompt_variant": variant,
                    "n_observations": len(base_obs),
                    "base_nll": base_nll,
                    "base_entropy": base_ent,
                    "null_mu": mu,
                    "null_sd": sd,
                    "decidability": sd / (abs(base_nll) + 1e-9),
                    "candidates": cand_rows,
                }
            )

    tag = model_id.split("/")[-1]
    suffix = "_smoke" if max_items is not None else ""
    out = HERE / f"p12_{tag}{suffix}.json"
    payload = {
        "model": model_id,
        "device": scorer.device,
        "dtype": "torch.bfloat16",
        "protocol": "PROTOCOL.md",
        "prompt_variants": list(PROMPT_VARIANTS),
        "n_items": len(items),
        "rows": rows,
    }
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"[saved] {out} rows={len(rows)}", flush=True)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=DEFAULT_MODELS, default=DEFAULT_MODELS[0])
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--max-items", type=int)
    args = parser.parse_args()
    run(args.model, args.batch_size, args.max_items)


if __name__ == "__main__":
    main()

