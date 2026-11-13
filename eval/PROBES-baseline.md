# Probe test

Questions a long-running agent must still answer after compaction, graded 0 to 5 against the chat. Mean score (probes).

| Type | summary | ledger | both | after |
| --- | --- | --- | --- | --- |
| recall | 2.75 (12) | 3.08 (12) | 4.08 (12) | 2.92 (12) |
| files | 1.92 (12) | 1.42 (12) | 2.50 (12) | 2.25 (12) |
| decision | 3.42 (12) | 2.33 (12) | 4.00 (12) | 3.67 (12) |
| continuation | 3.75 (12) | 1.75 (12) | 4.17 (12) | 3.92 (12) |
| **all** | **2.96 (48)** | **2.15 (48)** | **3.69 (48)** | **3.19 (48)** |

| Session | Turns | Summary chars | Ledger chars | Notes and learnings |
| --- | --- | --- | --- | --- |
| ac15f6b1 | 9 | 8273 | 9532 | 12 |
| 7e921bbd | 37 | 9300 | 18894 | 32 |
| be6b51e5 | 150 | 12159 | 99745 | 178 |
| 28226c90 | 127 | 10950 | 132568 | 211 |

summary: a Sonnet summary of the whole chat, a stand-in for /compact. ledger: state.md and steps.md from the replay.
both: the summary plus state.md and steps.md whole. after: the summary plus exactly what the mod injects (its
system-prompt sections and the digest), which is what the agent has after a compaction if it reads no file.
Gate: off. Long chats are cut to their first 150 turns. The probes, references and grader are Sonnet; the
probe writer saw the full chat. Small sample: read the per-probe rows before trusting a difference.

The per-probe questions quote the chats, so they stay in the git-ignored `eval/data/probe/PROBES-detail.md`.
