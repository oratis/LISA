# ICLR 2027 pre-submission checklist

Updated 2026-08-05 for the confirmatory manuscript. Every prohibition below
comes from an observed failure, a direct precedent, or the frozen P12
interpretation rules.

## Claim boundaries

- [x] Do not claim novelty for having a ground-truth-free inference-time write
  gate; ConsistencyGate occupies that locus.
- [x] Claim only the criterion: compression of the interlocutor's later usage
  relative to item-matched placebos.
- [x] Call `dnll` predictive code savings and `z` a calibrated admission
  signal. Neither is a two-part MDL score.
- [x] State that model-text and fixed-width text codes have zero positive
  payback on the six-use primary test.
- [x] Do not claim a universal cross-model threshold. Report Qwen 3B and
  SmolLM coverage/error rates without retuning.
- [x] Keep G1--G3 as the predeclared primary domain and report failed G4 and
  contaminated/inverted SmolLM G5 diagnostics.
- [x] Describe P13 as a templated interface stress test, not natural
  conversation or open-domain semantic parsing.
- [x] Mark the first P13 generation seed as frozen and the other two as
  post-hoc robustness checks.
- [x] Keep parameter-delta storage results in the appendix and call the
  strongest result a word-independent object bias, not learned word meaning.

## Evidence and statistics

- [x] Test data use five unseen generator seeds; no test-set ranks or threshold
  tuning.
- [x] Direct support, entropy, surprise, simplicity, and raw-gain baselines use
  the same candidate pairs.
- [x] Intervals resample generator seeds and then items within seed.
- [x] All-negative FPR pools the tempting misreading and all six placebos.
- [x] Pseudoword zero-shot and tokenizer controls are reported for all three
  models.
- [x] Every failed model, prompt, ambiguity family, and generation seed remains
  in raw JSON and analysis output.
- [x] `verify_reported_numbers.py` passes against regenerated P12/P13 analyses.

## Reproducibility and format

- [x] Official `iclr2027_conference.sty` and `.bst` are used without edits.
- [x] Anonymous submission mode; no acknowledgements or identifying metadata.
- [x] Main text ends on page 7, within the strict 9-page initial limit;
  references and appendices follow.
- [x] LLM usage disclosure and reproducibility statement appear before
  references.
- [x] `p1/test_p1.py`, Python compilation, `git diff --check`, BibTeX, and
  Tectonic compilation pass.
- [x] All 10 PDF pages have been rendered and visually inspected.

## Commands

```bash
python p1/test_p1.py
python p12/generate_splits.py
python p12/analyze.py
python p13/analyze.py
python paper/verify_reported_numbers.py
python -m py_compile p12/*.py p13/*.py paper/*.py paper/figures/*.py
cd paper && tectonic -X compile main.tex --outdir output/pdf
```

## Human-only gates before upload

- [ ] Independently inspect every citation and the complete diff.
- [ ] Confirm all authors' OpenReview profiles, author order, title, and
  genuine abstract before the abstract deadline.
- [ ] Run a final September literature search for admission gates and
  predictive/rate-distortion memory work.
- [ ] Have at least two external readers produce mock ICLR reviews.
- [ ] Submit the PDF and supplement at least 24 hours before the deadline.
