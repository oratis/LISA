# Rêve live model evaluation

See [the report](../../docs/REVE_LIVE_EVAL_2026-11-07.md) for methodology, limitations, fixes and UI verification.

- `cases.ts`: 12 synthetic cases; examines persisted memory, not model claims.
- `run.ts`: real configured Anthropic provider, isolated homes, frozen baseline reflector/writer, no fallback, usage recorded for every call including retries. Running it incurs real API usage.
- `summarize.ts`: regrades all retained outputs using the final rubric and the explicitly recorded manual audit findings. No network calls.
- `results/initial.json`: original baseline and first optimized implementation, 24 samples per arm.
- `results/refined.json`: intermediate fixes, 24 samples.
- `results/final.json`: final model/prompt validation, 24 samples.
- `results/summary.json`: consistent grades and all four token categories. Early `passed` values in raw files are intentionally retained and superseded by this regrading.
- `results/reve-*.png`: screenshots of the actual UI with synthetic, persisted test data. These figures are illustrative UI data, not the live-model evaluation metrics.

Run with `node --import tsx research/reve-memory-eval/run.ts --label=my-run --arms=baseline,current --repetitions=2`; choose a new label to preserve earlier evidence. The default summarizer reads the three retained runs listed above, not arbitrary new labels. Test homes are removed when a run completes.

The retained trials used commit `972b097`. For fresh runs the default baseline reads these exact two blobs from common ancestor `4115c1a`, available in a full clone of `main`. Specify `--baseline=<sha>` to compare a different revision.
