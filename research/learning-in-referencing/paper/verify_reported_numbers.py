"""Fail if headline manuscript numbers drift from generated analyses."""

from __future__ import annotations

import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TEX_RAW = (HERE / "main.tex").read_text()
TEX = " ".join(TEX_RAW.split())
P12 = json.loads((ROOT / "p12" / "p12_analysis.json").read_text())
P13 = json.loads((ROOT / "p13" / "p13_analysis.json").read_text())


def short(value: float) -> str:
    return f"{value:.3f}".removeprefix("0")


def require(fragment: str) -> None:
    fragment = " ".join(fragment.split())
    if fragment not in TEX:
        raise AssertionError(f"manuscript fragment missing or stale: {fragment}")


def main() -> None:
    models = {
        "Qwen2.5-1.5B": "Qwen/Qwen2.5-1.5B-Instruct",
        "Qwen2.5-3B": "Qwen/Qwen2.5-3B-Instruct",
        "SmolLM2-1.7B": "HuggingFaceTB/SmolLM2-1.7B-Instruct",
    }
    for label, model in models.items():
        cond = P12["models"][model]["conditions"]["test/canonical/core"]
        z = cond["pair_scores"]["z"]
        ci = z["hierarchical_bootstrap_95ci"]["auc"]
        row = (
            f"{label} & \\textbf{{{short(z['auc'])}}} "
            f"[{short(ci[0])},{short(ci[1])}] & "
            f"{short(cond['pair_scores']['dnll']['auc'])} & "
            f"{short(cond['pair_scores']['support']['auc'])} & "
            f"{short(cond['pair_scores']['semantic_entropy']['auc'])} & "
            f"{short(cond['pair_scores']['surprise']['auc'])}"
        )
        require(row)

        adm = cond["admission"]
        require(
            f"{label} & canonical & {short(adm['tpr_M'])} & "
            f"{short(adm['fpr_Mprime'])} & {short(adm['fpr_null'])} & "
            f"{short(adm['fpr_all_negative'])}"
        )

    run = P13["runs"][0]
    m, ci = run["metrics"], run["bootstrap_95"]
    require(
        f"${abs(m['gain_write_all']):.3f}$ nats on average "
        f"(95\\% item-bootstrap CI $[{ci['gain_write_all'][0]:.3f},"
        f"{ci['gain_write_all'][1]:.3f}]$)"
    )
    if "pending frozen run" in TEX_RAW or "TBD" in TEX_RAW:
        raise AssertionError("manuscript still contains a result placeholder")
    print("reported-number checks passed")


if __name__ == "__main__":
    main()
