# Probe test

Questions a long-running agent must still answer after compaction, graded 0 to 5 against the chat. Mean score (probes).

| Type | summary | ledger | both | after |
| --- | --- | --- | --- | --- |
| recall | 3.00 (12) | 3.00 (12) | 4.17 (12) | 3.08 (12) |
| files | 2.08 (12) | 1.50 (12) | 2.58 (12) | 2.25 (12) |
| decision | 3.50 (12) | 2.50 (12) | 3.42 (12) | 3.58 (12) |
| continuation | 3.83 (12) | 2.08 (12) | 3.42 (12) | 3.83 (12) |
| **all** | **3.10 (48)** | **2.27 (48)** | **3.40 (48)** | **3.19 (48)** |

| Session | Turns | Summary chars | Ledger chars | Notes and learnings |
| --- | --- | --- | --- | --- |
| 7e921bbd | 37 | 9300 | 18176 | 29 |
| ac15f6b1 | 82 | 8273 | 63593 | 112 |
| 28226c90 | 154 | 10950 | 157529 | 252 |
| be6b51e5 | 314 | 12159 | 171570 | 270 |

summary: a Sonnet summary of the whole chat, a stand-in for /compact. ledger: state.md and steps.md from the replay.
both: the summary plus state.md and steps.md whole. after: the summary plus exactly what the mod injects (its
system-prompt sections and the digest), which is what the agent has after a compaction if it reads no file.
Gate: off. Each chat is cut where the 0.4 parser's 150th turn ends (the baseline's cut), so all three runs read the same chat text; the newer parser splits that text into more turns. The probes, references and grader are Sonnet; the
probe writer saw the full chat. Small sample: read the per-probe rows before trusting a difference.

The per-probe questions quote the chats, so they stay in the git-ignored `eval/data/probe/PROBES-detail.md`.
