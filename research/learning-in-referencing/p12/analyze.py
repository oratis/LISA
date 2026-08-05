"""Analyze P12 with development-only threshold selection."""

from __future__ import annotations

import argparse
from collections import defaultdict
import glob
import json
import math
from pathlib import Path
import random
import statistics as st


HERE = Path(__file__).resolve().parent
PRIMARY_TYPES = {"G1", "G2", "G3"}
PAIR_METRICS = (
    "z",
    "dnll",
    "placebo_margin",
    "g_index",
    "g_text_model",
    "g_text_fixed",
    "support",
    "semantic_entropy",
    "surprise",
    "simplicity",
)


def candidate(row: dict, name: str) -> dict:
    return next(c for c in row["candidates"] if c["name"] == name)


def text_payback_horizon(rows: list[dict]) -> dict:
    """Stationary-use extrapolation: observations needed to repay the text code."""
    horizons = []
    for row in rows:
        true = candidate(row, "M")
        if true["dnll"] > 0:
            per_observation_gain = true["dnll"] / row["n_observations"]
            horizons.append(true["l_model"] / per_observation_gain)
    if not horizons:
        return {"n_positive_gain": 0, "median": None, "q25": None, "q75": None}
    quartiles = st.quantiles(horizons, n=4)
    return {
        "n_positive_gain": len(horizons),
        "median": st.median(horizons),
        "q25": quartiles[0],
        "q75": quartiles[2],
    }


def auc(pos: list[float], neg: list[float]) -> float:
    if not pos or not neg:
        return float("nan")
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (
        len(pos) * len(neg)
    )


def sign_p(margins: list[float]) -> tuple[int, int, float]:
    margins = [x for x in margins if x != 0]
    n = len(margins)
    wins = sum(x > 0 for x in margins)
    p = sum(math.comb(n, i) for i in range(wins, n + 1)) / (2**n) if n else 1.0
    return wins, n, p


def hierarchical_ci(rows: list[dict], metric: str, n_boot: int = 2000) -> dict:
    by_seed: dict[int, list[dict]] = defaultdict(list)
    for row in rows:
        by_seed[int(row["generator_seed"])].append(row)
    seeds = sorted(by_seed)
    if len(seeds) < 2:
        return {"auc": [None, None], "margin": [None, None]}
    rng = random.Random(20260805)
    aucs, margins = [], []
    for _ in range(n_boot):
        sampled = []
        for seed in rng.choices(seeds, k=len(seeds)):
            group = by_seed[seed]
            sampled.extend(rng.choices(group, k=len(group)))
        ms = [candidate(r, "M")[metric] for r in sampled]
        ps = [candidate(r, "Mprime")[metric] for r in sampled]
        aucs.append(auc(ms, ps))
        margins.append(st.mean(a - b for a, b in zip(ms, ps)))
    aucs.sort()
    margins.sort()
    lo = int(0.025 * n_boot)
    hi = int(0.975 * n_boot) - 1
    return {"auc": [aucs[lo], aucs[hi]], "margin": [margins[lo], margins[hi]]}


def paired_summary(rows: list[dict], metric: str) -> dict:
    pos = [candidate(r, "M")[metric] for r in rows]
    neg = [candidate(r, "Mprime")[metric] for r in rows]
    margins = [a - b for a, b in zip(pos, neg)]
    wins, n, p = sign_p(margins)
    return {
        "n": len(rows),
        "wins": wins,
        "sign_n": n,
        "sign_p_one_sided": p,
        "auc": auc(pos, neg),
        "margin": st.mean(margins),
        "hierarchical_bootstrap_95ci": hierarchical_ci(rows, metric),
    }


def choose_accept_threshold(dev_rows: list[dict]) -> dict:
    pos = [candidate(r, "M")["z"] for r in dev_rows]
    neg = []
    for row in dev_rows:
        neg.extend(c["z"] for c in row["candidates"] if c["name"] != "M")
    vals = sorted(set(pos + neg))
    thresholds = [vals[0] - 1e-9] + [
        (a + b) / 2 for a, b in zip(vals, vals[1:])
    ] + [vals[-1] + 1e-9]
    feasible = []
    all_points = []
    for threshold in thresholds:
        tpr = sum(x > threshold for x in pos) / len(pos)
        fpr = sum(x > threshold for x in neg) / len(neg)
        point = {"threshold": threshold, "tpr": tpr, "fpr": fpr}
        all_points.append(point)
        if fpr <= 0.10:
            feasible.append(point)
    pool = feasible if feasible else all_points
    best = max(pool, key=lambda x: (x["tpr"], -x["fpr"], -x["threshold"]))
    return {**best, "fpr_constraint_met": bool(feasible), "n_pos": len(pos), "n_neg": len(neg)}


def choose_decidability_threshold(dev_rows: list[dict]) -> dict:
    vals = sorted(set(r["decidability"] for r in dev_rows))
    points = []
    for threshold in vals:
        kept = [r for r in dev_rows if r["decidability"] >= threshold]
        if len(kept) < math.ceil(0.5 * len(dev_rows)):
            continue
        correct = sum(candidate(r, "M")["z"] > candidate(r, "Mprime")["z"] for r in kept)
        points.append(
            {
                "threshold": threshold,
                "coverage": len(kept) / len(dev_rows),
                "pair_accuracy": correct / len(kept),
            }
        )
    return max(points, key=lambda x: (x["pair_accuracy"], x["coverage"], -x["threshold"]))


def admission_summary(rows: list[dict], threshold: float) -> dict:
    pos = [candidate(r, "M")["z"] for r in rows]
    mp = [candidate(r, "Mprime")["z"] for r in rows]
    nulls = [
        c["z"]
        for r in rows
        for c in r["candidates"]
        if c["name"].startswith("null")
    ]
    neg = mp + nulls
    return {
        "n_items": len(rows),
        "tpr_M": sum(x > threshold for x in pos) / len(pos),
        "fpr_Mprime": sum(x > threshold for x in mp) / len(mp),
        "fpr_null": sum(x > threshold for x in nulls) / len(nulls),
        "fpr_all_negative": sum(x > threshold for x in neg) / len(neg),
    }


def decidability_summary(rows: list[dict], threshold: float) -> dict:
    kept = [r for r in rows if r["decidability"] >= threshold]
    dropped = [r for r in rows if r["decidability"] < threshold]
    def accuracy(xs: list[dict]) -> float | None:
        if not xs:
            return None
        return sum(
            candidate(r, "M")["z"] > candidate(r, "Mprime")["z"] for r in xs
        ) / len(xs)
    return {
        "n": len(rows),
        "n_kept": len(kept),
        "coverage": len(kept) / len(rows),
        "kept_pair_accuracy": accuracy(kept),
        "dropped_pair_accuracy": accuracy(dropped),
    }


def filter_rows(rows: list[dict], split: str, variant: str, types: set[str]) -> list[dict]:
    return [
        r
        for r in rows
        if r["split"] == split and r["prompt_variant"] == variant and r["type"] in types
    ]


def analyze(files: list[str]) -> dict:
    models = {}
    for file in files:
        blob = json.loads(Path(file).read_text())
        if blob["n_items"] < 190:
            continue
        models[blob["model"]] = blob["rows"]
    dev_model = "Qwen/Qwen2.5-1.5B-Instruct"
    if dev_model not in models:
        raise RuntimeError(f"development model result missing; found {sorted(models)}")
    dev_primary = filter_rows(models[dev_model], "dev", "canonical", PRIMARY_TYPES)
    accept = choose_accept_threshold(dev_primary)
    decidability = choose_decidability_threshold(dev_primary)

    out = {
        "protocol": "PROTOCOL.md",
        "threshold_source": {
            "model": dev_model,
            "split": "dev",
            "prompt_variant": "canonical",
            "types": sorted(PRIMARY_TYPES),
        },
        "accept_threshold": accept,
        "decidability_threshold": decidability,
        "models": {},
    }
    for model_id, rows in models.items():
        mo = {"conditions": {}}
        for split in ("dev", "test"):
            for variant in ("canonical", "dictionary"):
                subset = filter_rows(rows, split, variant, PRIMARY_TYPES)
                if not subset:
                    continue
                key = f"{split}/{variant}/core"
                condition = {
                    "pair_scores": {m: paired_summary(subset, m) for m in PAIR_METRICS},
                    "admission": admission_summary(subset, accept["threshold"]),
                    "decidability": decidability_summary(subset, decidability["threshold"]),
                    "positive_net_gain_rate": {
                        metric: sum(candidate(r, "M")[metric] > 0 for r in subset) / len(subset)
                        for metric in ("g_index", "g_text_model", "g_text_fixed")
                    },
                    "text_payback_horizon": text_payback_horizon(subset),
                    "by_type": {
                        t: paired_summary([r for r in subset if r["type"] == t], "z")
                        for t in sorted(PRIMARY_TYPES)
                    },
                    "by_seed": {
                        str(seed): paired_summary(
                            [r for r in subset if int(r["generator_seed"]) == seed], "z"
                        )
                        for seed in sorted({int(r["generator_seed"]) for r in subset})
                    },
                }
                mo["conditions"][key] = condition
        # Declared scope diagnostics, test/canonical only.
        mo["scope_diagnostics"] = {
            t: paired_summary(
                filter_rows(rows, "test", "canonical", {t}), "z"
            )
            for t in ("G4", "G5")
        }
        out["models"][model_id] = mo
    return out


def render_markdown(result: dict) -> str:
    a = result["accept_threshold"]
    d = result["decidability_threshold"]
    lines = [
        "# P12 confirmatory results",
        "",
        "Thresholds were selected once on Qwen2.5-1.5B canonical-prompt development data.",
        f"Accept threshold z > {a['threshold']:.4f} (dev TPR {a['tpr']:.3f}, FPR {a['fpr']:.3f}).",
        f"Decidability threshold > {d['threshold']:.4f} (dev coverage {d['coverage']:.3f}).",
        "",
        "## Unseen-test primary domain (G1--G3)",
        "",
        "| model | prompt | score | AUC [95% hierarchical CI] | wins | one-sided p | margin |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    show_metrics = ("z", "dnll", "g_index", "g_text_model", "support", "semantic_entropy", "surprise")
    for model, mo in result["models"].items():
        for variant in ("canonical", "dictionary"):
            cond = mo["conditions"].get(f"test/{variant}/core")
            if not cond:
                continue
            for metric in show_metrics:
                s = cond["pair_scores"][metric]
                ci = s["hierarchical_bootstrap_95ci"]["auc"]
                ci_text = f"[{ci[0]:.3f}, {ci[1]:.3f}]" if ci[0] is not None else "n/a"
                lines.append(
                    f"| {model.split('/')[-1]} | {variant} | {metric} | "
                    f"{s['auc']:.3f} {ci_text} | {s['wins']}/{s['sign_n']} | "
                    f"{s['sign_p_one_sided']:.2e} | {s['margin']:+.3f} |"
                )
    lines.extend(
        [
            "",
            "## Frozen-threshold admission on unseen test",
            "",
            "| model | prompt | M TPR | M-prime FPR | null FPR | all-negative FPR | coverage | kept pair accuracy |",
            "|---|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for model, mo in result["models"].items():
        for variant in ("canonical", "dictionary"):
            cond = mo["conditions"].get(f"test/{variant}/core")
            if not cond:
                continue
            adm, dec = cond["admission"], cond["decidability"]
            lines.append(
                f"| {model.split('/')[-1]} | {variant} | {adm['tpr_M']:.3f} | "
                f"{adm['fpr_Mprime']:.3f} | {adm['fpr_null']:.3f} | "
                f"{adm['fpr_all_negative']:.3f} | {dec['coverage']:.3f} | "
                f"{dec['kept_pair_accuracy'] if dec['kept_pair_accuracy'] is not None else float('nan'):.3f} |"
            )
    lines.extend(["", "## Positive net-gain rate for the true candidate", "", "| model | prompt | index code | model text code | fixed-width text code |", "|---|---|---:|---:|---:|"])
    for model, mo in result["models"].items():
        for variant in ("canonical", "dictionary"):
            cond = mo["conditions"].get(f"test/{variant}/core")
            if not cond:
                continue
            g = cond["positive_net_gain_rate"]
            lines.append(
                f"| {model.split('/')[-1]} | {variant} | {g['g_index']:.3f} | "
                f"{g['g_text_model']:.3f} | {g['g_text_fixed']:.3f} |"
            )
    lines.extend(
        [
            "",
            "## Text-code payback horizon (stationary-use extrapolation)",
            "",
            "Computed only for true candidates with positive predictive gain. The horizon is not an observed result; it assumes future uses have the same mean gain as the six held-out observations.",
            "",
            "| model | prompt | positive-gain items | median observations [IQR] |",
            "|---|---|---:|---:|",
        ]
    )
    for model, mo in result["models"].items():
        for variant in ("canonical", "dictionary"):
            cond = mo["conditions"].get(f"test/{variant}/core")
            if not cond:
                continue
            h = cond["text_payback_horizon"]
            lines.append(
                f"| {model.split('/')[-1]} | {variant} | {h['n_positive_gain']} | "
                f"{h['median']:.1f} [{h['q25']:.1f}, {h['q75']:.1f}] |"
            )
    if result.get("contamination_controls"):
        lines.extend(
            [
                "",
                "## Pseudoword contamination control",
                "",
                "Zero-shot AUC is measured before any teaching examples or definitions. AUC near 0.5 rules out a pre-existing association that already separates the constructed labels.",
                "",
                "| model | all AUC | G1 | G2 | G3 | single-token rate |",
                "|---|---:|---:|---:|---:|---:|",
            ]
        )
        for control in result["contamination_controls"]:
            z = control["zero_shot"]
            by = z["by_type"]
            lines.append(
                f"| {control['model'].split('/')[-1]} | {z['all']['auc']:.3f} | "
                f"{by['G1']['auc']:.3f} | {by['G2']['auc']:.3f} | "
                f"{by['G3']['auc']:.3f} | {control['tokenization']['single_token_rate']:.3f} |"
            )
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--glob", default=str(HERE / "p12_*-Instruct.json"))
    args = parser.parse_args()
    files = sorted(glob.glob(args.glob))
    result = analyze(files)
    result["contamination_controls"] = [
        json.loads(Path(path).read_text())
        for path in sorted(glob.glob(str(HERE / "contamination_*.json")))
    ]
    (HERE / "p12_analysis.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    )
    report = render_markdown(result)
    (HERE / "RESULTS.md").write_text(report)
    print(report)


if __name__ == "__main__":
    main()
