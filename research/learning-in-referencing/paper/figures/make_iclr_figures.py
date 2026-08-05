"""Make the confirmatory-result figure from committed P12/P13 analyses."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
P12 = json.loads((ROOT / "p12" / "p12_analysis.json").read_text())
P13 = json.loads((ROOT / "p13" / "p13_analysis.json").read_text())

COLORS = {
    "z": "#0072B2",
    "dnll": "#56B4E9",
    "support": "#E69F00",
    "semantic_entropy": "#CC79A7",
    "surprise": "#009E73",
    "write_all": "#D55E00",
    "admitted": "#0072B2",
}


def short_model(name: str) -> str:
    if "SmolLM" in name:
        return "SmolLM2\n1.7B"
    if "1.5B" in name:
        return "Qwen2.5\n1.5B"
    if "3B" in name:
        return "Qwen2.5\n3B"
    return name.split("/")[-1]


def main() -> None:
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 8,
            "axes.titlesize": 9,
            "axes.labelsize": 8,
            "legend.fontsize": 7,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )
    fig, axes = plt.subplots(1, 3, figsize=(7.05, 2.25), constrained_layout=True)

    # A: direct baseline comparison on the canonical unseen test.
    metrics = ["z", "dnll", "support", "semantic_entropy", "surprise"]
    labels = ["placebo-$z$", "raw gain", "support", "sem. entropy", "surprise"]
    models = list(P12["models"])
    x = np.arange(len(models))
    width = 0.15
    for i, (metric, label) in enumerate(zip(metrics, labels)):
        vals = [
            P12["models"][m]["conditions"]["test/canonical/core"]["pair_scores"][metric]["auc"]
            for m in models
        ]
        axes[0].bar(
            x + (i - 2) * width,
            vals,
            width,
            label=label,
            color=COLORS[metric],
            edgecolor="white",
            linewidth=0.3,
        )
    axes[0].axhline(0.5, color="0.35", linestyle="--", linewidth=0.8)
    axes[0].set_ylim(0, 1.03)
    axes[0].set_ylabel("AUC: true vs. misreading")
    axes[0].set_xticks(x, [short_model(m) for m in models])
    axes[0].set_title("(a) Admission signal")
    axes[0].legend(ncols=2, frameon=False, loc="lower left", handlelength=1.2)

    # B: operation of the single development-frozen threshold.
    true_rates = []
    false_rates = []
    for model in models:
        adm = P12["models"][model]["conditions"]["test/canonical/core"]["admission"]
        true_rates.append(adm["tpr_M"])
        false_rates.append(adm["fpr_all_negative"])
    axes[1].bar(x - 0.17, true_rates, 0.34, color="#0072B2", label="true concept")
    axes[1].bar(x + 0.17, false_rates, 0.34, color="#999999", label="misreadings + nulls")
    axes[1].axhline(0.10, color="#D55E00", linestyle=":", linewidth=0.9, label="10% dev target")
    axes[1].set_ylim(0, 0.72)
    axes[1].set_ylabel("Admission rate")
    axes[1].set_xticks(x, [short_model(m) for m in models])
    axes[1].set_title("(b) Frozen threshold")
    axes[1].legend(frameon=False, loc="upper right")

    # C: generated candidates, primary plus post-hoc decoding seeds.
    runs = P13["runs"]
    sx = np.arange(len(runs))
    for key, label, offset in (
        ("gain_write_all", "write first", -0.10),
        ("gain_admitted", "admit after gate", 0.10),
    ):
        means = np.array([r["metrics"][key] for r in runs])
        ci = np.array([r["bootstrap_95"][key] for r in runs])
        axes[2].errorbar(
            sx + offset,
            means,
            yerr=np.vstack([means - ci[:, 0], ci[:, 1] - means]),
            fmt="o",
            capsize=2,
            markersize=4,
            linewidth=1,
            color=COLORS["write_all" if key == "gain_write_all" else "admitted"],
            label=label,
        )
    axes[2].axhline(0, color="0.35", linewidth=0.8)
    axes[2].set_xticks(sx, ["primary", "seed +1", "seed +2"])
    axes[2].set_ylabel("Held-out gain (nats)")
    axes[2].set_title("(c) Generated candidates")
    axes[2].legend(frameon=False, loc="lower right")

    for ax in axes:
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", color="0.9", linewidth=0.5, zorder=0)
        ax.set_axisbelow(True)

    for ext in ("pdf", "png"):
        out = HERE / f"fig_confirmatory.{ext}"
        fig.savefig(out, dpi=240, bbox_inches="tight")
        print(f"[saved] {out}")


if __name__ == "__main__":
    main()
