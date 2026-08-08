"""Summarize the frozen P13 run and post-hoc decoding-seed replications."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
PRIMARY = "p13_Qwen2.5-1.5B-Instruct.json"
N_BOOT = 10_000
BOOT_SEED = 20260805


def metrics(rows: list[dict]) -> dict[str, float | None]:
    admitted = [r for r in rows if r["admitted"]]
    return {
        "coverage": len(admitted) / len(rows),
        "beneficial_precision": (
            sum(r["selected"]["dnll_true"] > 0 for r in admitted) / len(admitted)
            if admitted
            else None
        ),
        "gain_write_all": float(np.mean([r["first_true_gain"] for r in rows])),
        "gain_selected_all": float(
            np.mean([r["selected"]["dnll_true"] for r in rows])
        ),
        "gain_admitted": (
            float(np.mean([r["selected"]["dnll_true"] for r in admitted]))
            if admitted
            else None
        ),
        "selection_regret": float(np.mean([r["selection_regret"] for r in rows])),
    }


def bootstrap(rows: list[dict]) -> dict[str, list[float]]:
    rng = np.random.default_rng(BOOT_SEED)
    samples: dict[str, list[float]] = {k: [] for k in metrics(rows)}
    n = len(rows)
    for _ in range(N_BOOT):
        draw = [rows[i] for i in rng.integers(0, n, size=n)]
        for key, value in metrics(draw).items():
            if value is not None:
                samples[key].append(value)
    return {
        key: [float(x) for x in np.quantile(values, [0.025, 0.975])]
        for key, values in samples.items()
    }


def main() -> None:
    paths = [HERE / PRIMARY] + sorted(
        p for p in HERE.glob("p13_*_seed*.json") if p.name != PRIMARY
    )
    runs = []
    for path in paths:
        payload = json.loads(path.read_text())
        rows = list(payload["items"].values())
        runs.append(
            {
                "file": path.name,
                "seed": payload.get("generation_seed", 20260805),
                "primary": path.name == PRIMARY,
                "extraction": payload["extraction"],
                "metrics": metrics(rows),
                "bootstrap_95": bootstrap(rows),
                "n_items": len(rows),
            }
        )

    (HERE / "p13_analysis.json").write_text(
        json.dumps({"n_boot": N_BOOT, "runs": runs}, indent=2) + "\n"
    )

    lines = [
        "# P13 end-to-end results",
        "",
        "The first row is the frozen primary run. Later rows are explicitly post-hoc",
        "decoding-seed robustness checks; they do not alter any threshold.",
        "",
        "| seed | status | coverage | beneficial precision | write-all gain | admitted gain | regret |",
        "|---:|---|---:|---:|---:|---:|---:|",
    ]
    for run in runs:
        m = run["metrics"]
        ci = run["bootstrap_95"]
        status = "frozen primary" if run["primary"] else "post-hoc robustness"
        lines.append(
            f'| {run["seed"]} | {status} | '
            f'{m["coverage"]:.3f} [{ci["coverage"][0]:.3f}, {ci["coverage"][1]:.3f}] | '
            f'{m["beneficial_precision"]:.3f} [{ci["beneficial_precision"][0]:.3f}, {ci["beneficial_precision"][1]:.3f}] | '
            f'{m["gain_write_all"]:+.3f} [{ci["gain_write_all"][0]:+.3f}, {ci["gain_write_all"][1]:+.3f}] | '
            f'{m["gain_admitted"]:+.3f} [{ci["gain_admitted"][0]:+.3f}, {ci["gain_admitted"][1]:+.3f}] | '
            f'{m["selection_regret"]:.3f} [{ci["selection_regret"][0]:.3f}, {ci["selection_regret"][1]:.3f}] |'
        )
    first = runs[0]["extraction"]
    lines += [
        "",
        "## Natural-utterance usage extraction",
        "",
        f'The development-selected threshold was {first["threshold_selection"]["threshold"]:.4f}. '
        f'On {first["test"]["n"]} unseen utterances: AUC '
        f'{first["test"]["auc"]:.4f}, accuracy {first["test"]["accuracy"]:.4f}, '
        f'sensitivity {first["test"]["sensitivity"]:.4f}, and specificity '
        f'{first["test"]["specificity"]:.4f}.',
        "",
    ]
    (HERE / "RESULTS.md").write_text("\n".join(lines))
    print(f"[saved] {HERE / 'p13_analysis.json'}")
    print(f"[saved] {HERE / 'RESULTS.md'}")


if __name__ == "__main__":
    main()
