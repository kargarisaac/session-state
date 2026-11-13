# Probe test

Questions a long-running agent must still answer after compaction, graded 0 to 5 against the chat. Mean score (probes).

| Type | summary | ledger | both | after |
| --- | --- | --- | --- | --- |
| recall | 3.00 (12) | 2.83 (12) | 4.00 (12) | 3.33 (12) |
| files | 1.83 (12) | 1.67 (12) | 2.92 (12) | 2.25 (12) |
| decision | 3.42 (12) | 2.67 (12) | 3.67 (12) | 3.25 (12) |
| continuation | 4.08 (12) | 1.83 (12) | 3.33 (12) | 3.75 (12) |
| **all** | **3.08 (48)** | **2.25 (48)** | **3.48 (48)** | **3.15 (48)** |

| Session | Turns | Summary chars | Ledger chars | Notes and learnings | Haiku calls | Input tokens | Output tokens | Seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7e921bbd | 37 | 9300 | 16998 | 23 | 38 | 286305 | 81506 | 566.7 |
| ac15f6b1 | 82 | 8273 | 53296 | 78 | 83 | 842306 | 178477 | 1441.8 |
| 28226c90 | 154 | 10950 | 148924 | 214 | 155 | 2764941 | 388900 | 3100.5 |
| be6b51e5 | 314 | 12159 | 152170 | 205 | 315 | 6419360 | 614220 | 4723.9 |
| **Total** | 587 | – | – | – | 591 | 10312912 | 1263103 | 9833.0 |

Haiku input includes cache reads and writes; seconds sum the CLI duration for replay and consolidation calls.
summary: a Sonnet summary of the whole chat, a stand-in for /compact. ledger: state.md and steps.md from the replay.
both: the summary plus state.md and steps.md whole. after: the summary plus exactly what the mod injects (its
system-prompt sections and the digest), which is what the agent has after a compaction if it reads no file.
Gate: off. Each chat is cut where the 0.4 parser's 150th turn ends (the baseline's cut), so all three runs read the same chat text; the newer parser splits that text into more turns. The probes, references and grader are Sonnet; the
probe writer saw the full chat. Small sample: read the per-probe rows before trusting a difference.

The per-probe questions quote the chats, so they stay in the git-ignored `eval/data/probe/PROBES-detail.md`.
