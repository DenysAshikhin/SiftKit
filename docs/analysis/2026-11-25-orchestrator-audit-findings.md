# Orchestrator audit run bdaa258c: findings, and two bugs in the run itself

Audit of 2026-11-24, checked against the code on 2026-11-25 by reading the cited lines. Nothing below was rerun, so "valid"
means the code does what the finding says. The audit itself reports reproducing seven: CLI-1, CLI-2, CLI-3, AGT-2, AST-1, PKG-1, PKG-3.
Full text: `.scratch/audit/REPORT.md` (git-ignored).

## Bugs in the run itself

**No final answer on the page.** The parent's finish summary is parsed and then dropped: `src/orchestrator/run.ts:897` keeps only
`{ status: 'completed' }`, and the run state has no field for it. The live pane is memory only, so a restart empties it. The one copy of
bdaa258c's summary is in `run_logs` of parent run c264dcf7, which is pruned after 7 days (about 2026-12-02). Fixed 2026-11-25 (schema 101; bdaa258c recovered).

**Run used a different folder from the one typed.** `dashboard/src/tabs/ChatTab.tsx:258` takes the session's saved folder, and
`startOrchestratorRun` sends it, ignoring the typed folder unless "Directory" was pressed first. Every other mode uses
`resolveRepoRoot(planRepoRootInput, planRepoRoot)`. A new session's saved folder is the server's own folder. The stored request for
bdaa258c has the SiftKit path; what was typed is not recorded, so this being the reported case is inferred. Fixed 2026-11-25.

## Verdicts

| ID | Verdict | Note |
|---|---|---|
| REM-1 | Fixed 2026-11-25 | `0.0.0.0` passes the private-address check, so web_fetch can reach local services; `0.0.0.0/8`, `.local`, `.internal` and a trailing dot are now refused |
| AST-1 | Fixed 2026-11-25 | A deleted blob is reused, so the new record is unreadable; a reused hash now revives the deleted row |
| AST-4 | Fixed 2026-11-25 | Unmerge moves every alias of the target; `movedAliasIds` is written and never read; merge and unmerge now move only the recorded aliases |
| DSH-1 | Fixed 2026-11-25 | An unsaved note is lost when its tab is switched; the draft now lives in its tab and survives a conflict |
| SHM-2 | Fixed 2026-11-25 | `%errorlevel%` is expanded before PowerShell runs, so a failure exits 0; the shim now exits with the CLI's code (reinstall to update an installed copy) |
| ORC-1 | Valid | The folder lease is not released if anything throws before `superviseChild` starts |
| ORC-3 | Valid | A plan may name a temporary path that cleanup later refuses |
| HTTP-1 | Valid | A queue timeout resolves the lock to null without answering, and the handler just returns |
| AST-3 | Valid | Job terminal writes do not check the lease owner |
| INF-2 | Valid | Each engine stop can block the server up to 5 s |
| INF-3 | Valid | A stop failure replaces the original startup error |
| CLI-2, CLI-3, SHM-3, SHM-4, DSH-2 | Valid | For CLI-2, the caller's stdin value was not traced; SHM-3's argument mangling was not rerun |
| PKG-1, PKG-2, PKG-4, C1, C2, C3, C4 | Valid | Docs and tooling that no longer match the code |
| PKG-3 | Valid, small | The lint rule is missing; a search found one use, `src/repo-search/prompts.ts:133` (the audit cites 131) |
| CLI-1, AGT-1, HTTP-2, REM-2, STS-3, STS-4, TST-1 | Valid, low | Rare, internal or short-lived |
| INF-1 | Overstated | Needs a process that stays alive; the suggested fix could load the model twice |
| AST-2 | Overstated | The order is wrong; "destroyed forever" is probably not true while the shell holds the key |
| STS-1, STS-2 | Overstated | The 32,766-row limit is out of reach with 7-day retention; STS-1's delete order is a real fault |
| AGT-2 | Doubtful | Reproduced for output kept from its end; a successful read is kept from its start |
| ORC-2 | Not valid as written | The child's first wait sees the stop already requested and aborts the child |
| SHM-1 | Untested | Depends on what PowerShell reports for an installed module |
| Q1, Q2 | Not bugs | Open questions (npm publish contents, a POSIX-only check) |
