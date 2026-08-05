# P12: frozen confirmatory protocol

Frozen on 2026-08-05 before running P12 models. This experiment replaces the
post-hoc threshold and two-scale analyses in P0g/P0j for the ICLR submission.

## Data

- Development set: the existing P1 set (seed 11, 8 items per ambiguity type).
- Test set: five unseen generator seeds (101, 211, 307, 401, 503), with six
  items per type and seed: 150 test items total, 90 in the primary G1--G3
  domain.
- The primary domain is fixed to G1--G3 because the pre-P12 experiments found
  that the base model did not reliably apply G4 definitions and sometimes
  overrode G5 definitions. G4 and G5 remain in the test set as declared scope
  diagnostics, not as exclusions chosen after seeing P12.
- All examples, labels, and placebo candidates are generated without model
  calls. Test examples are not inspected when choosing thresholds.

## Models and prompts

- Development model: `Qwen/Qwen2.5-1.5B-Instruct`.
- Confirmatory models: the development model, `Qwen/Qwen2.5-3B-Instruct`, and
  `HuggingFaceTB/SmolLM2-1.7B-Instruct` (a held-out model family).
- Two definition phrasings are fixed in advance: `canonical` and `dictionary`.
  The canonical phrasing is primary; the dictionary phrasing is a prompt
  robustness test.

## Candidate scores

For each item and candidate, compute:

1. `dnll`: held-out binary-usage NLL without the candidate minus NLL with it.
2. `z`: per-item standardisation of `dnll` against the six generated placebo
   candidates.
3. `placebo_margin`: `dnll` minus the best placebo `dnll`.
4. `g_index`: `dnll - log(K)`, where K is the shared finite candidate pool.
5. `g_text_model`: `dnll` minus the candidate statement's reference-model NLL.
6. `g_text_fixed`: `dnll` minus a fixed-width tokenizer code length.
7. `support`: a ConsistencyGate-style single-pass support probability using
   only the teaching examples. This is the released paper's latency-oriented
   log-probability form, not a sampled imitation of it.
8. `semantic_entropy`: negative mean Bernoulli entropy of usage predictions.
9. `surprise`: mean Bernoulli KL from the no-definition predictions.
10. `simplicity`: negative reference-model description length.

The paper must not call `z` or `dnll` a two-part MDL score. A positive
two-part-code claim is allowed only for `g_index`, `g_text_model`, or
`g_text_fixed`, with the corresponding code stated explicitly.

## Primary tests

1. On unseen G1--G3 items, compare M with M-prime using paired win rate,
   one-sided sign test (direction fixed here), pooled AUC, and a 95% bootstrap
   CI that resamples generation seeds and then items within seed.
2. Compare `z` against `support`, `semantic_entropy`, `surprise`, and
   `simplicity` on exactly the same candidate pairs.
3. Choose an absolute admission threshold on development candidates only,
   constraining false admission of M-prime and placebos to at most 10% when
   possible. Freeze it, then report test TPR/FPR without retuning.
4. Choose a decidability threshold on development data only. Report coverage
   and accuracy on the unseen test set. Do not use within-test-set ranks.
5. Report performance separately for every generator seed, ambiguity family,
   prompt phrasing, and model. No failed model or prompt may be dropped.
6. Report the all-negative false-admission rate using M-prime and placebo
   candidates. This guards against relative rankings that always admit a
   winner.

## Interpretation rules

- If text-code gains are negative while `z` works, reframe the method as a
  placebo-calibrated predictive-compression criterion; do not claim that the
  concept paid for its textual description.
- If only Qwen succeeds, remove cross-family language from the paper.
- If a development threshold fails on test, retain AUC as a diagnostic result
  and remove the deployable fixed-threshold claim.
- G4/G5 failures limit scope; they do not invalidate the preregistered G1--G3
  primary test.

