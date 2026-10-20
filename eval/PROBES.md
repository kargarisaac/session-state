# Probe test

Questions a long-running agent must still answer after compaction, graded 0 to 5 against the chat. Mean score (probes).

| Type | summary | ledger | both |
| --- | --- | --- | --- |
| recall | 2.17 (6) | 3.67 (6) | 3.83 (6) |
| files | 3.33 (6) | 2.00 (6) | 3.83 (6) |
| decision | 1.33 (6) | 1.33 (6) | 2.17 (6) |
| continuation | 4.50 (6) | 1.33 (6) | 4.33 (6) |
| **all** | **2.83 (24)** | **2.08 (24)** | **3.54 (24)** |

| Session | Turns | Summary chars | Ledger chars | Notes and learnings |
| --- | --- | --- | --- | --- |
| 7e921bbd | 37 | 8128 | 13722 | 16 |
| e46f9786 | 38 | 9262 | 30011 | 43 |

summary: a Sonnet summary of the whole chat, a stand-in for /compact. ledger: state.md and steps.md from the replay.
both: what the agent has after a compaction with the mod on. The probes, references and grader are Sonnet; the
probe writer saw the full chat. Small sample: read the per-probe rows before trusting a difference.

The per-probe questions quote the chats, so they stay in the git-ignored `eval/data/probe/PROBES-detail.md`.
