# dsh-cadence-standard

[中文说明](./README.zh-CN.md)

An experimental [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
agent preset that paces the model's thinking budget across a session —
**Cadence Standard v4.12** (thinking-budget pacing).

This is a community project. It is not an official DeepSeek preset and is not
affiliated with or endorsed by DeepSeek.

## Attribution

This preset references prior open work:

- [`yjh051108/dsh-router-standard`](https://github.com/yjh051108/dsh-router-standard)
  (MIT) — preset structure, first-turn anchoring mechanism, agent-visible
  tuning approach.
- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
  (MIT) — the first-turn anchoring mechanism (zero-tool warm-up turn, narrow
  first request) builds on its bootstrap filter.

See [NOTICE](./NOTICE).

## Features

Cadence Standard injects static, idempotent guidance into the agent pre-step
waterfall and exposes two read-only diagnostic tools (`trace_status`,
`trace_style`) plus a budget-only tuning tool (`trace_tune`). It registers **no
fs/shell/permission tools** of its own.

| Mechanism | Description |
|---|---|
| **Anchored first turn** | A zero-tool, low-budget warm-up turn ("Cadence 热身") eliminates the turn-1 thinking stall before the real task begins. |
| **Budget awareness** | A constant neutral budget section plus band messages (`small` 2048 / `medium` 4096 / `large` roomy) injected when the band changes — the model knows its output cap *before* it starts thinking. |
| **Truncation recovery** | A step that burns its whole cap truncates; the next request's budget is released and a recovery message is injected. |
| **Monotonic classification** | Simple by default; the first user message sets the class, later complex messages upgrade permanently. Batch-aware at pre-step. |
| **Platform profiles** | PowerShell guidance on win32 plus shell-syntax-error detection; `auto \| win32 \| posix` override for testing. |
| **Plan-forward utilization** | Slow progress steers the model to move planned, independent verification work earlier — never new actions. |
| **Verified deadlock ladder** | Suspicion (L1) → fingerprint-verified (L2) → pause-and-ask-user via `ask_user_question` (L3) → bounded reminder (L3b) → optional escalation (L4, plan-mode-safe, cancel without directive). |
| **Delegation advisor** | Complex code-fixing sessions get one suggestion to delegate an independent review to a subagent (read-only discipline; targeted numeric-review variant). |
| **Subagent timeout reminder** | Settled-aware reminder when a delegated subagent runs too long (default 15 min). |
| **Todo-sync advisor** | Keeps the UI todo list honest when long parallel work stalls the model's own `todo_write` cadence. |
| **Visual-depth deepening** | Gentle steering toward screenshot + `read_image` verification when vision-relevant work is detected. |
| **Trajectory diagnostics** | `trace_status` / `trace_style` for cadence state and trajectory-style indicators; `trace_tune` adjusts the output budget only. |

All injections are static texts, idempotent (durable markers), and routed
through the `agent/pre-step` waterfall (strip first, inject second). The full
Standard tool catalog is exposed after the session records its first durable
promotion signal (`promoteOn: either` — first tool call or first
assistant message).

## Installation

DSH loads presets from `~/.dsh/.agent-presets/<name>/`. Copy this repo's
`preset/` directory contents there:

```powershell
# Windows (PowerShell)
$dst = "$env:USERPROFILE\.dsh\.agent-presets\cadence-standard"
New-Item -ItemType Directory -Force -Path $dst
Copy-Item -Recurse -Force .\preset\* $dst
```

```bash
# macOS / Linux
mkdir -p ~/.dsh/.agent-presets/cadence-standard
cp -r preset/* ~/.dsh/.agent-presets/cadence-standard/
```

Then **restart the harness process**. Preset `.mjs` modules are loaded once
per process via the ES module cache, so edits to `cadence-core.mjs` or
`cadence-bootstrap.mjs` require a restart; the YAML config is re-read per
session join. In the DSH Web GUI, select the `Cadence Standard (experimental)`
preset (order 6) for the session.

## Configuration

Key options in `preset/agent.cordis.yml` → `cadence-bootstrap`:

| Option | Default | Meaning |
|---|---|---|
| `simpleBootstrapMaxTokens` | 2048 | small-band cap |
| `simpleCapMaxTokens` | 4096 | medium-band cap |
| `complexBootstrapMaxTokens` | 16384 | complex bootstrap cap |
| `promoteOn` | `either` | promotion trigger: `tool-call` \| `assistant-message` \| `either` |
| `anchorFirstTurn` | `true` | enable the zero-tool warm-up turn |
| `platform` | `auto` | `auto` \| `win32` \| `posix` |
| `subagentTimeoutMin` | 15 | delegated-subagent timeout reminder |
| `todoSyncAdvisor` | `true` | todo-list sync advisor |
| `escalateAfterIgnore` | (see yml) | L4 escalation after repeated ignore |

## Testing

```bash
npm test        # node --test (test/cadence.test.mjs, 93 assertions)
npm run check   # syntax-check the preset modules, then run tests
```

The suite exercises every listener the bootstrap registers against a minimal
fake Cordis context, plus pure-function tests for the core detection logic.

## Showcase test case

[`lgr1230/dsh-gargantua`](https://github.com/lgr1230/dsh-gargantua) — a
real-time Schwarzschild black hole raytracer built under this preset with
DeepSeek V4 Pro Max. It is an outstanding acceptance case: **13/13 test
cases PASS with zero console errors and zero failed requests**, frames
VLM-reviewed at 8.5/10. **Live preview:** <https://lgr1230.github.io/dsh-gargantua/>
(WebGL2 required). See its
[test report](https://github.com/lgr1230/dsh-gargantua/blob/main/test/TEST_REPORT.md)
([中文版](https://github.com/lgr1230/dsh-gargantua/blob/main/test/TEST_REPORT.zh-CN.md)).

## License

[MIT](./LICENSE)
