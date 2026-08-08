# P12 confirmatory results

Thresholds were selected once on Qwen2.5-1.5B canonical-prompt development data.
Accept threshold z > 1.1429 (dev TPR 0.500, FPR 0.095).
Decidability threshold > 0.3987 (dev coverage 0.708).

## Unseen-test primary domain (G1--G3)

| model | prompt | score | AUC [95% hierarchical CI] | wins | one-sided p | margin |
|---|---|---:|---:|---:|---:|---:|
| Qwen2.5-1.5B-Instruct | canonical | z | 0.949 [0.916, 0.977] | 87/90 | 9.82e-23 | +1.731 |
| Qwen2.5-1.5B-Instruct | canonical | dnll | 0.874 [0.836, 0.917] | 87/90 | 9.82e-23 | +4.137 |
| Qwen2.5-1.5B-Instruct | canonical | g_index | 0.874 [0.836, 0.917] | 87/90 | 9.82e-23 | +4.137 |
| Qwen2.5-1.5B-Instruct | canonical | g_text_model | 0.918 [0.878, 0.958] | 89/90 | 7.35e-26 | +9.624 |
| Qwen2.5-1.5B-Instruct | canonical | support | 0.370 [0.299, 0.444] | 35/88 | 9.79e-01 | -0.041 |
| Qwen2.5-1.5B-Instruct | canonical | semantic_entropy | 0.230 [0.164, 0.301] | 18/90 | 1.00e+00 | -0.098 |
| Qwen2.5-1.5B-Instruct | canonical | surprise | 0.526 [0.405, 0.667] | 51/90 | 1.23e-01 | +0.005 |
| Qwen2.5-1.5B-Instruct | dictionary | z | 0.968 [0.929, 0.995] | 89/90 | 7.35e-26 | +1.762 |
| Qwen2.5-1.5B-Instruct | dictionary | dnll | 0.924 [0.883, 0.966] | 89/90 | 7.35e-26 | +4.379 |
| Qwen2.5-1.5B-Instruct | dictionary | g_index | 0.924 [0.883, 0.966] | 89/90 | 7.35e-26 | +4.379 |
| Qwen2.5-1.5B-Instruct | dictionary | g_text_model | 0.875 [0.835, 0.919] | 88/90 | 3.31e-24 | +8.867 |
| Qwen2.5-1.5B-Instruct | dictionary | support | 0.579 [0.519, 0.637] | 46/73 | 1.72e-02 | +0.015 |
| Qwen2.5-1.5B-Instruct | dictionary | semantic_entropy | 0.235 [0.157, 0.329] | 24/90 | 1.00e+00 | -0.101 |
| Qwen2.5-1.5B-Instruct | dictionary | surprise | 0.575 [0.455, 0.712] | 55/90 | 2.23e-02 | +0.006 |
| Qwen2.5-3B-Instruct | canonical | z | 0.909 [0.860, 0.955] | 80/90 | 5.26e-15 | +1.954 |
| Qwen2.5-3B-Instruct | canonical | dnll | 0.851 [0.795, 0.898] | 80/90 | 5.26e-15 | +5.977 |
| Qwen2.5-3B-Instruct | canonical | g_index | 0.851 [0.795, 0.898] | 80/90 | 5.26e-15 | +5.977 |
| Qwen2.5-3B-Instruct | canonical | g_text_model | 0.882 [0.836, 0.931] | 86/90 | 2.16e-21 | +12.110 |
| Qwen2.5-3B-Instruct | canonical | support | 0.440 [0.353, 0.526] | 43/89 | 6.64e-01 | -0.000 |
| Qwen2.5-3B-Instruct | canonical | semantic_entropy | 0.249 [0.190, 0.306] | 13/90 | 1.00e+00 | +0.001 |
| Qwen2.5-3B-Instruct | canonical | surprise | 0.732 [0.661, 0.800] | 68/90 | 6.25e-07 | -0.004 |
| Qwen2.5-3B-Instruct | dictionary | z | 0.893 [0.831, 0.943] | 80/90 | 5.26e-15 | +1.841 |
| Qwen2.5-3B-Instruct | dictionary | dnll | 0.880 [0.823, 0.930] | 80/90 | 5.26e-15 | +10.352 |
| Qwen2.5-3B-Instruct | dictionary | g_index | 0.880 [0.823, 0.930] | 80/90 | 5.26e-15 | +10.352 |
| Qwen2.5-3B-Instruct | dictionary | g_text_model | 0.951 [0.918, 0.978] | 87/90 | 9.82e-23 | +15.061 |
| Qwen2.5-3B-Instruct | dictionary | support | 0.228 [0.154, 0.311] | 23/89 | 1.00e+00 | -0.014 |
| Qwen2.5-3B-Instruct | dictionary | semantic_entropy | 0.176 [0.097, 0.259] | 19/90 | 1.00e+00 | -0.017 |
| Qwen2.5-3B-Instruct | dictionary | surprise | 0.823 [0.738, 0.904] | 73/90 | 9.74e-10 | +0.244 |
| SmolLM2-1.7B-Instruct | canonical | z | 0.811 [0.740, 0.878] | 74/90 | 2.19e-10 | +0.984 |
| SmolLM2-1.7B-Instruct | canonical | dnll | 0.662 [0.602, 0.735] | 74/90 | 2.19e-10 | +0.449 |
| SmolLM2-1.7B-Instruct | canonical | g_index | 0.662 [0.602, 0.735] | 74/90 | 2.19e-10 | +0.449 |
| SmolLM2-1.7B-Instruct | canonical | g_text_model | 0.758 [0.699, 0.823] | 76/90 | 8.89e-12 | +6.147 |
| SmolLM2-1.7B-Instruct | canonical | support | 0.581 [0.518, 0.646] | 43/76 | 1.51e-01 | +0.008 |
| SmolLM2-1.7B-Instruct | canonical | semantic_entropy | 0.439 [0.373, 0.497] | 29/90 | 1.00e+00 | -0.012 |
| SmolLM2-1.7B-Instruct | canonical | surprise | 0.580 [0.483, 0.697] | 57/90 | 7.43e-03 | +0.001 |
| SmolLM2-1.7B-Instruct | dictionary | z | 0.912 [0.828, 0.973] | 84/90 | 5.41e-19 | +1.991 |
| SmolLM2-1.7B-Instruct | dictionary | dnll | 0.755 [0.684, 0.835] | 84/90 | 5.41e-19 | +0.823 |
| SmolLM2-1.7B-Instruct | dictionary | g_index | 0.755 [0.684, 0.835] | 84/90 | 5.41e-19 | +0.823 |
| SmolLM2-1.7B-Instruct | dictionary | g_text_model | 0.715 [0.649, 0.782] | 66/90 | 5.45e-06 | +5.163 |
| SmolLM2-1.7B-Instruct | dictionary | support | 0.542 [0.478, 0.608] | 46/73 | 1.72e-02 | +0.004 |
| SmolLM2-1.7B-Instruct | dictionary | semantic_entropy | 0.333 [0.256, 0.419] | 28/90 | 1.00e+00 | -0.034 |
| SmolLM2-1.7B-Instruct | dictionary | surprise | 0.644 [0.561, 0.729] | 60/90 | 1.03e-03 | +0.007 |

## Frozen-threshold admission on unseen test

| model | prompt | M TPR | M-prime FPR | null FPR | all-negative FPR | coverage | kept pair accuracy |
|---|---|---:|---:|---:|---:|---:|---:|
| Qwen2.5-1.5B-Instruct | canonical | 0.556 | 0.033 | 0.106 | 0.095 | 0.678 | 0.984 |
| Qwen2.5-1.5B-Instruct | dictionary | 0.478 | 0.033 | 0.098 | 0.089 | 0.722 | 1.000 |
| Qwen2.5-3B-Instruct | canonical | 0.400 | 0.000 | 0.144 | 0.124 | 0.000 | nan |
| Qwen2.5-3B-Instruct | dictionary | 0.456 | 0.011 | 0.146 | 0.127 | 0.000 | nan |
| SmolLM2-1.7B-Instruct | canonical | 0.289 | 0.056 | 0.104 | 0.097 | 0.000 | nan |
| SmolLM2-1.7B-Instruct | dictionary | 0.578 | 0.022 | 0.100 | 0.089 | 0.000 | nan |

## Positive net-gain rate for the true candidate

| model | prompt | index code | model text code | fixed-width text code |
|---|---|---:|---:|---:|
| Qwen2.5-1.5B-Instruct | canonical | 0.478 | 0.000 | 0.000 |
| Qwen2.5-1.5B-Instruct | dictionary | 0.544 | 0.000 | 0.000 |
| Qwen2.5-3B-Instruct | canonical | 0.656 | 0.000 | 0.000 |
| Qwen2.5-3B-Instruct | dictionary | 1.000 | 0.000 | 0.000 |
| SmolLM2-1.7B-Instruct | canonical | 0.022 | 0.000 | 0.000 |
| SmolLM2-1.7B-Instruct | dictionary | 0.100 | 0.000 | 0.000 |

## Text-code payback horizon (stationary-use extrapolation)

Computed only for true candidates with positive predictive gain. The horizon is not an observed result; it assumes future uses have the same mean gain as the six held-out observations.

| model | prompt | positive-gain items | median observations [IQR] |
|---|---|---:|---:|
| Qwen2.5-1.5B-Instruct | canonical | 78 | 84.3 [60.3, 132.7] |
| Qwen2.5-1.5B-Instruct | dictionary | 76 | 124.9 [95.5, 218.8] |
| Qwen2.5-3B-Instruct | canonical | 76 | 38.6 [19.6, 105.4] |
| Qwen2.5-3B-Instruct | dictionary | 90 | 21.2 [13.0, 32.6] |
| SmolLM2-1.7B-Instruct | canonical | 64 | 339.5 [187.9, 558.4] |
| SmolLM2-1.7B-Instruct | dictionary | 85 | 308.0 [200.6, 443.9] |

## Pseudoword contamination control

Zero-shot AUC is measured before any teaching examples or definitions. AUC near 0.5 rules out a pre-existing association that already separates the constructed labels.

| model | all AUC | G1 | G2 | G3 | single-token rate |
|---|---:|---:|---:|---:|---:|
| Qwen2.5-1.5B-Instruct | 0.548 | 0.516 | 0.533 | 0.511 | 0.033 |
| Qwen2.5-3B-Instruct | 0.449 | 0.531 | 0.454 | 0.492 | 0.033 |
| SmolLM2-1.7B-Instruct | 0.536 | 0.500 | 0.508 | 0.502 | 0.007 |
