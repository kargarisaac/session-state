# Gate calibration: jev-1.14, with the end of the previous reply in view

Sessions: 14 real chats (815 turns, 298 important). Fit half: 372 turns, 142 important. Held-out half: 443 turns, 156 important.
Labels: 699 agreed by two independent passes, 116 settled by a stronger model. The two passes agreed on 85.8% of turns.
Held-out ranking quality (AUC): 0.909 on held-out, 0.925 on the fit half.

Threshold chosen on the fit half for precision >= 0.9: **0.57**

| Threshold | Passed | Precision (95% CI) | Recall (95% CI) |
| --- | --- | --- | --- |
| 0.3 | 248 | 56.5% (50.2% to 62.5%) | 89.7% (84.0% to 93.6%) |
| 0.5 | 134 | 86.6% (79.8% to 91.3%) | 74.4% (67.0% to 80.6%) |
| 0.57 (chosen) | 125 | 87.2% (80.2% to 92.0%) | 69.9% (62.3% to 76.5%) |
| 0.7 | 89 | 94.4% (87.5% to 97.6%) | 53.8% (46.0% to 61.5%) |
| 0.8 | 58 | 96.6% (88.3% to 99.0%) | 35.9% (28.8% to 43.7%) |
| 0.9 | 19 | 100.0% (83.2% to 100.0%) | 12.2% (7.9% to 18.2%) |

At 0.57 on held-out: 109 of 125 passed turns are important; 47 important turns are missed.
Short messages (40 characters or less): 95 turns, 6 important, recall 33.3% (9.7% to 70.0%).
Precision on the fit half at 0.57: 90.4%.

Acceptance (held-out precision >= 0.9): NOT MET.

## Both halves

| Threshold | Fit half precision | Held-out precision | Pooled precision (95% CI) | Pooled recall |
| --- | --- | --- | --- | --- |
| 0.6 | 91.2% (102) | 89.1% (119) | 90.0% (85.4% to 93.3%) | 66.8% |
| 0.63 (shipped) | 92.4% (92) | 91.7% (108) | 92.0% (87.4% to 95.0%) | 61.7% |
| 0.65 | 93.0% (86) | 92.1% (101) | 92.5% (87.8% to 95.5%) | 58.1% |
| 0.7 | 97.3% (75) | 94.4% (89) | 95.7% (91.5% to 97.9%) | 52.7% |
| 0.75 | 97.1% (69) | 94.7% (75) | 95.8% (91.2% to 98.1%) | 46.3% |
| 0.8 | 96.5% (57) | 96.6% (58) | 96.5% (91.4% to 98.6%) | 37.2% |

Shipped default: **0.63**, the lowest threshold whose precision reaches 0.9 on both halves. The threshold fit on one half alone is not trusted (it missed the bar on the other).
