# Gate calibration: jev-1.14, user message and reply only

Sessions: 14 real chats (815 turns, 298 important). Fit half: 372 turns, 142 important. Held-out half: 443 turns, 156 important.
Labels: 699 agreed by two independent passes, 116 settled by a stronger model. The two passes agreed on 85.8% of turns.
Held-out ranking quality (AUC): 0.843 on held-out, 0.898 on the fit half.

Threshold chosen on the fit half for precision >= 0.9: **0.51**

| Threshold | Passed | Precision (95% CI) | Recall (95% CI) |
| --- | --- | --- | --- |
| 0.3 | 259 | 51.7% (45.7% to 57.8%) | 85.9% (79.6% to 90.5%) |
| 0.5 | 161 | 62.7% (55.0% to 69.8%) | 64.7% (57.0% to 71.8%) |
| 0.51 (chosen) | 156 | 64.1% (56.3% to 71.2%) | 64.1% (56.3% to 71.2%) |
| 0.7 | 76 | 93.4% (85.5% to 97.2%) | 45.5% (37.9% to 53.3%) |
| 0.8 | 46 | 97.8% (88.7% to 99.6%) | 28.8% (22.3% to 36.4%) |
| 0.9 | 18 | 94.4% (74.2% to 99.0%) | 10.9% (6.9% to 16.8%) |

At 0.51 on held-out: 100 of 156 passed turns are important; 56 important turns are missed.
Short messages (40 characters or less): 95 turns, 6 important, recall 16.7% (3.0% to 56.4%).
Precision on the fit half at 0.51: 90.1%.

Acceptance (held-out precision >= 0.9): NOT MET.

## Both halves

| Threshold | Fit half precision | Held-out precision | Pooled precision (95% CI) | Pooled recall |
| --- | --- | --- | --- | --- |
| 0.6 | 96.4% (84) | 86.9% (107) | 91.1% (86.2% to 94.4%) | 58.4% |
| 0.64 (shipped) | 97.4% (77) | 90.7% (97) | 93.7% (89.0% to 96.4%) | 54.7% |
| 0.65 | 97.4% (76) | 92.4% (92) | 94.6% (90.1% to 97.2%) | 53.4% |
| 0.7 | 98.6% (69) | 93.4% (76) | 95.9% (91.3% to 98.1%) | 46.6% |
| 0.75 | 98.2% (57) | 95.0% (60) | 96.6% (91.5% to 98.7%) | 37.9% |
| 0.8 | 97.9% (48) | 97.8% (46) | 97.9% (92.6% to 99.4%) | 30.9% |

Shipped default: **0.64**, the lowest threshold whose precision reaches 0.9 on both halves. The threshold fit on one half alone is not trusted (it missed the bar on the other).
