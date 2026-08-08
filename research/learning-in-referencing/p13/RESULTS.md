# P13 end-to-end results

The first row is the frozen primary run. Later rows are explicitly post-hoc
decoding-seed robustness checks; they do not alter any threshold.

| seed | status | coverage | beneficial precision | write-all gain | admitted gain | regret |
|---:|---|---:|---:|---:|---:|---:|
| 20260805 | frozen primary | 0.278 [0.189, 0.367] | 0.920 [0.800, 1.000] | -2.278 [-2.877, -1.701] | +1.441 [+0.935, +2.017] | 0.000 [0.000, 0.000] |
| 20260806 | post-hoc robustness | 0.322 [0.222, 0.422] | 0.931 [0.826, 1.000] | -2.136 [-2.709, -1.566] | +1.818 [+1.359, +2.266] | 0.001 [0.000, 0.003] |
| 20260807 | post-hoc robustness | 0.356 [0.256, 0.456] | 0.875 [0.750, 0.972] | -2.069 [-2.698, -1.457] | +1.510 [+1.054, +1.968] | 0.000 [0.000, 0.000] |

## Natural-utterance usage extraction

The development-selected threshold was 0.7731. On 480 unseen utterances: AUC 1.0000, accuracy 0.9938, sensitivity 1.0000, and specificity 0.9875.
