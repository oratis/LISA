# ICLR 2027 submission plan

Updated 2026-08-05. Official deadlines: abstract registration 2026-09-18
AoE; full paper 2026-09-25 AoE. The official template imposes a strict
9-page initial-submission main-text limit; references and appendices follow.

## Current decision

Submit to ICLR 2027 after the confirmatory package is complete. The paper is
now framed around placebo-calibrated predictive compression, not immediate
two-part MDL consolidation. On current evidence it is a credible borderline
accept rather than the earlier weak reject: the held-out split, direct
ConsistencyGate-style baseline, hierarchical intervals, contamination control,
and generated-candidate loop resolve the largest evaluation objections.

## Non-negotiable claims

- Primary evidence is the frozen P12 G1--G3 test: 90 pairs over five unseen
  generation seeds.
- `z` is a calibrated predictive-compression signal, not a two-part MDL score.
- Full textual descriptions do not repay their code cost in six observations.
- The 1.5B development threshold transfers across unseen items and prompt
  phrasings, but not unchanged across model scales.
- G4 is a failed scope diagnostic and remains reported.
- P13 is a templated interface stress test, not a natural-conversation result.
- The first P13 decoding seed is frozen; later seeds are explicitly post-hoc.

## Completion gates

- [x] Frozen development/test protocol committed before confirmatory runs.
- [x] Qwen2.5-1.5B and 3B confirmatory runs.
- [x] Direct support, entropy, surprise, simplicity, and raw-gain baselines.
- [x] Hierarchical bootstrap, paired sign tests, and all-negative FPR.
- [x] Pseudoword zero-shot contamination controls on Qwen models.
- [x] Natural-utterance extraction and generated-candidate admission loop.
- [x] Two post-hoc decoding-seed robustness checks.
- [x] SmolLM2-1.7B held-out-family run and contamination control.
- [x] Remove every pending placeholder after the SmolLM run.
- [x] Regenerate figures and result tables from raw JSON.
- [ ] Rebuild and visually inspect every final PDF page.
- [ ] Independent human audit of citations, code, and LLM disclosure.
- [ ] Confirm every author has a current OpenReview profile before abstract
  registration; freeze title, abstract, author list, and order.

## Main reviewer risks and responses

| risk | evidence now in the paper | still needed |
|---|---|---|
| synthetic benchmark | construction isolates confident misreading; five unseen seeds; generated-candidate loop | one real or naturally sourced user-convention benchmark would materially strengthen the paper |
| only one model family | two Qwen scales plus frozen SmolLM2 family | report SmolLM regardless of outcome |
| baseline fairness | same candidate pairs; direct support probability; entropy, surprise, simplicity | avoid claiming an exact reimplementation when a released baseline detail differs |
| MDL overclaim | explicit code-length experiment and zero text-code payback | keep title/abstract free of immediate MDL language |
| threshold overfitting | dev-only threshold; unseen FPR; no test ranks | require per-model calibration in deployment claims |
| weak end-to-end induction | write-all is harmful; gate yields positive admitted gain | preserve low coverage and malformed examples; do not cherry-pick generations |

## Schedule

- By 2026-08-08: finish cross-family run, regenerate all results, and close
  numerical placeholders.
- By 2026-08-15: complete a human citation/method audit and decide whether a
  naturally sourced convention dataset can be added without changing the
  confirmatory claim.
- By 2026-08-29: external mock reviews, ablation requests, and one response
  cycle; freeze the experiment suite afterward.
- By 2026-09-12: final anonymous PDF, repository snapshot, and OpenReview
  metadata rehearsal.
- 2026-09-18 AoE: submit genuine abstract and final author metadata.
- 2026-09-25 AoE: submit paper and supplement at least 24 hours early.
