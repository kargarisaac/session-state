# Gate calibration: jev-1.13

Sessions: 14 real chats (815 turns, 298 important). Fit half: 372 turns, 142 important. Held-out half: 443 turns, 156 important.
Labels: 699 agreed by two independent passes, 116 settled by a stronger model. The two passes agreed on 85.8% of turns.
Held-out ranking quality (AUC): 0.894 on held-out, 0.905 on the fit half.

Threshold chosen on the fit half for precision >= 0.9: **0.59**

| Threshold | Passed | Precision (95% CI) | Recall (95% CI) |
| --- | --- | --- | --- |
| 0.3 | 270 | 50.7% (44.8% to 56.7%) | 87.8% (81.8% to 92.1%) |
| 0.5 | 139 | 82.7% (75.6% to 88.1%) | 73.7% (66.3% to 80.0%) |
| 0.59 (chosen) | 121 | 87.6% (80.6% to 92.3%) | 67.9% (60.3% to 74.8%) |
| 0.7 | 88 | 93.2% (85.9% to 96.8%) | 52.6% (44.8% to 60.2%) |
| 0.8 | 53 | 96.2% (87.2% to 99.0%) | 32.7% (25.8% to 40.4%) |
| 0.9 | 14 | 100.0% (78.5% to 100.0%) | 9.0% (5.4% to 14.5%) |

At 0.59 on held-out: 106 of 121 passed turns are important; 50 important turns are missed.
Short messages (40 characters or less): 95 turns, 6 important, recall 33.3% (9.7% to 70.0%).
Precision on the fit half at 0.59: 90.2%.

Acceptance (held-out precision >= 0.9): NOT MET.

## Both halves

| Threshold | Fit half precision | Held-out precision | Pooled precision (95% CI) | Pooled recall |
| --- | --- | --- | --- | --- |
| 0.6 | 91.1% (101) | 87.6% (121) | 89.2% (84.4% to 92.6%) | 66.4% |
| 0.65 | 96.6% (89) | 89.8% (108) | 92.9% (88.4% to 95.7%) | 61.4% |
| 0.68 (shipped) | 96.3% (82) | 91.5% (94) | 93.8% (89.2% to 96.5%) | 55.4% |
| 0.7 | 96.2% (79) | 93.2% (88) | 94.6% (90.1% to 97.1%) | 53.0% |
| 0.75 | 98.5% (67) | 93.3% (75) | 95.8% (91.1% to 98.0%) | 45.6% |
| 0.8 | 98.1% (54) | 96.2% (53) | 97.2% (92.1% to 99.0%) | 34.9% |

Shipped default: **0.68**, the lowest threshold whose precision reaches 0.9 on both halves. The threshold fit on one half alone is not trusted (it missed the bar on the other).
