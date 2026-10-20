# Gate calibration

The gate asks Jev one question per turn: did the user say something that will still matter about 50 turns later?
A turn at or above the threshold gets a full extraction; the others get a cheap summary only.

Data: 14 real chats, 815 turns, 298 important, labelled by two LLM passes with a stronger model settling the 14% they
disagreed on. No human labels. The threshold is the lowest one whose precision reaches 0.9 on both halves of the chats.

| Gate | Held-out AUC | Shipped threshold | Pooled precision (95% CI) | Pooled recall | Short-message recall |
| --- | --- | --- | --- | --- | --- |
| jev-1.13, user message and reply | 0.894 | 0.68 | 93.8% (89.2% to 96.5%) | 55.4% | 33% (2 of 6) |
| jev-1.14, user message and reply | 0.843 | 0.64 | 93.7% (89.0% to 96.4%) | 54.7% | 17% (1 of 6) |
| **jev-1.14, with the end of the previous reply (shipped)** | **0.909** | **0.63** | 92.0% (87.4% to 95.0%) | **61.7%** | 33% (2 of 6) |

Showing Jev the last 2,000 characters of the previous reply lets it read a short "yes" or "the second one" as the answer
it is. On jev-1.14 that raised held-out AUC from 0.843 to 0.909 and recall by 7 points at about the same precision.
Only 6 short messages are labelled important, so the short-message figures are too small to compare.

A missed turn is not lost: it still gets a summary step, and the user's words stay in the archive, which a later
extraction can look back at.

Full tables: [jev-1.14 with previous reply](REPORT-jev_1.14-prev.md), [jev-1.14 without](REPORT-jev_1.14-none.md),
[jev-1.13 without](REPORT-jev_1.13-none.md).

Rerun:

```bash
OPENROUTER_API_KEY=... bun eval/score.ts jev-1.14 prev   # about $0.05
bun eval/fit.ts jev-1.14 prev
```
