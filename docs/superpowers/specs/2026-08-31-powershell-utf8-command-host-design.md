# PowerShell UTF-8 Command Host Design

## Goal

Make the PowerShell shim preserve arbitrary command grammar and provide one truthful UTF-8 contract for native stdout, native stdin, and `stdinData`, while keeping the injected host machinery out of model-visible commands, duplicate detection, and transcripts.

## Scope

This design replaces the current direct prelude concatenation in `src/lib/powershell.ts`. It covers both PowerShell spawn helpers, the sole production `stdinData` caller in `src/assistant/crypto/dpapi.ts`, run-tool prompt guidance, and regression coverage for the affected execution and recording boundaries.

The `-File` launch in `src/status-server/managed-llama.ts` remains out of scope because it does not use the command-string shim.

## Requirements

- Preserve the original PowerShell command as separately parsed script source so first-position constructs such as `param()` and `using namespace` remain valid.
- Set `[Console]::InputEncoding`, `[Console]::OutputEncoding`, and `$OutputEncoding` to the same BOM-less `[Text.UTF8Encoding]::new($false)` instance before executing user source.
- When `stdinData` is absent, invoke the user scriptblock directly.
- When `stdinData` is present, read the redirected stream once through `[Console]::In.ReadToEnd()` after setting `InputEncoding`, then pipe that single decoded string into the user scriptblock. The script consumes it through `$input`.
- Migrate the DPAPI command to the canonical `$input` contract. Remove its direct `[Console]::In` path; do not preserve both forms.
- Keep all host implementation values private to `src/lib/powershell.ts` unless an external consumer requires them.
- Preserve the original requested command in run-tool results, duplicate fingerprints, and transcripts.
- Preserve exit codes, stdout/stderr capture, timeout, abort, environment, cwd, and process-tree termination behavior.
- Do not add dependencies, compatibility branches, fallbacks, temporary files, type assertions, `any`, non-null assertions, or dynamically passed functions.
- Do not commit.

## Command Hosting

`src/lib/powershell.ts` will own one private command builder used by both spawn helpers. The builder will:

1. Escape the supplied command as a PowerShell single-quoted string by doubling embedded single quotes.
2. Append a newline plus `if (-not $?) { exit 1 }` to the supplied source, then construct a scriptblock with `[ScriptBlock]::Create(<escaped source>)`. This preserves `powershell.exe -Command` semantics: a failing final native command or non-terminating PowerShell error exits 1, while a later successful statement exits 0.
3. Execute the UTF-8 assignments before invoking that scriptblock.
4. Select the invocation suffix from the explicit `stdinData !== undefined` state:
   - no stdin: `& ([ScriptBlock]::Create(...))`
   - stdin present: `[Console]::In.ReadToEnd() | & ([ScriptBlock]::Create(...))`

The wrapper must not introduce variables visible to the user script. The scriptblock expression is therefore constructed inline rather than stored in a PowerShell variable.

Both `spawnPowerShellSync` and `spawnPowerShellAsync` pass only the builder output to the `-Command` argument. No caller, engine, transcript, or duplicate-tracking layer receives the wrapped string.

## stdinData Contract

`stdinData` is UTF-8 text delivered to the invoked PowerShell scriptblock as one pipeline object. `$input` is the supported consumer. This deliberately replaces direct user-command reads from `[Console]::In`, because the host consumes that stream to correct PowerShell 5.1's OEM-decoded automatic-input behavior.

The only production caller, DPAPI, currently sends one ASCII base64 string. Its PowerShell source will collect `$input` with `@($input) -join ''` before decoding. No compatibility path for `[Console]::In.ReadToEnd()` remains.

## Prompt and Comments

Model guidance will describe the exact supported guarantee: native command output and text piped to native commands are UTF-8, and shim-provided stdin is decoded as UTF-8 into `$input`. The CRLF-safe split idiom remains `-split "`r?`n"`, but the text will say it handles both CRLF and LF rather than claiming every native command emits CRLF.

Implementation comments will describe these same concrete boundaries and will not claim unspecified PowerShell host behavior.

## Tests

Testing follows strict red-green-refactor.

### Command-host regressions

- Add an async regression proving a command beginning with `param()` executes. It must fail against direct prelude concatenation with the current parser error.
- Add an async regression proving a command beginning with `using namespace` executes.
- Add direct sync coverage proving native UTF-8 output can be matched inside a PowerShell pipeline.

### Encoding boundaries

- Restore the stdin regression to consume `$input` and require exact Unicode output.
- Replace broad `.trim()` assertions with exact stdout assertions, including the expected PowerShell `\r\n` framing; use stdin fixtures without incidental trailing newlines.
- For the `$OutputEncoding` boundary, make the native child return the hexadecimal bytes it received and assert the exact UTF-8 bytes, including absence of a BOM.
- Mutation-check each prelude assignment independently: removing the corresponding assignment must fail its dedicated regression, then restoration must return the target to green.

### Prompt guidance

- Update the prompt regression to assert the precise three-boundary guarantee and the CRLF/LF-safe split instruction without claiming every native command emits CRLF.

### Recording invariant

- Add one run-tool integration regression that executes a command and asserts the requested/model-visible command, duplicate fingerprint input, and transcript representation contain the original command and do not contain any host prelude or scriptblock wrapper text.

### Existing behavior

- Run DPAPI tests covering encrypt/decrypt stdin transport.
- Run the PowerShell, prompt, run-tool, and runtime-planner targets.
- Run `npm run typecheck`, `npm run lint`, and the full `npm test` suite.

## Drift Resolution Mapping

1. Grammar-sensitive commands: independently parsed scriptblock host.
2. Overstated UTF-8 guarantee: canonical UTF-8 `$input` delivery plus precise guidance.
3. Untested sync helper: direct sync regression.
4. Missing red-first evidence: new failing grammar tests plus assignment mutation-red checks.
5. `trim()` masking: exact text or byte-level assertions.
6. Untested recording invariant: run-tool integration regression.
7. Unneeded export: private prelude and builder values.

## Risks

- Scriptblock invocation introduces a child PowerShell scope. The tests must protect exit status, output, timeout, and command parsing behavior that callers rely on.
- Commands using direct `[Console]::In` with `stdinData` will no longer work. Repository search found one such production caller, DPAPI, and this design migrates it completely.
- Embedding the user command as a PowerShell single-quoted string increases length only for embedded single quotes. It avoids the larger command-line expansion of Base64/`-EncodedCommand`.
- Windows PowerShell 5.1's `[Text.Encoding]::UTF8` singleton emits BOM preambles when piping to native stdin. The host must use `UTF8Encoding(false)`; the byte-level regression rejects either `efbbbf` prefix.
- `[Console]::InputEncoding` may still throw in a console-less environment. Such a failure remains loud; no fallback or swallowed exception is permitted.
