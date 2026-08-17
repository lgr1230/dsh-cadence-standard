# dsh-cadence-standard

[中文说明](./README.zh-CN.md)

An experimental [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
agent preset that paces the model's thinking budget across a session —
**Cadence Standard v4.4** (thinking-budget pacing, LEAN).

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
- [`chenmzh/dsh-orchestrator-standard`](https://github.com/chenmzh/dsh-orchestrator-standard)
  — resident tool catalog, compaction epoch and pre-execute deny patterns.

See [NOTICE](./NOTICE).

## Features

Cadence Standard injects static, idempotent guidance into the agent pre-step
waterfall and exposes read-only diagnostic tools (`trace_status`,
`tool_search`) plus an in-preset hot code reloader (`cadence_reload`). It
registers **no fs/shell/permission tools** of its own.

| Mechanism | Description |
|---|---|
| **Anchored first turn** | A zero-tool, low-budget warm-up turn ("Cadence 热身") eliminates the turn-1 thinking stall before the real task begins. |
| **First-request class fix (F1)** | The task is pre-classified at inbox insert, so the FIRST task request already carries the complex persona + complex core surface (no more simple-persona/simple-core contradiction). |
| **Narrow first-task surface** | `promoteOn: tool-call` — the warm-up reply does NOT promote; the first task request runs on a narrow core (read/edit/glob/grep + shell), the first tool call promotes. |
| **Monotonic classification** | Simple by default; complex upgrades permanently. Batch-aware at pre-step; never downgraded (the warm-up pre-step cannot erase the pre-classified state). |
| **Resident catalog (R1)** | After promotion the surface stays on a resident set: core work tools + `vision` + `todo_write` + SAFETY VALVES (subagent/ask_user_question/list_agents/interrupt_agent/send_message) + preset tools. Heavier tools are found via `tool_search` and unlock on first use. Conditioning only — the sandbox/approval stack is the security boundary. |
| **Compaction epoch (R2)** | After a successful compaction/end the surface falls back to the resident set until new progress exists past the boundary. |
| **Bootstrap strip + instruction hint (R3)** | Auto-injected context (agent-instructions / skill-catalog) is stripped during the bootstrap phase; one short static hint is injected once after promotion instead of a full AGENTS.md digest. |
| **Process-self guard (R4)** | Shell commands that would kill/restart the harness process itself are vetoed at `tools/pre-execute` (native deny) until the user confirms. |
| **Per-message guides** | Every real user message gets one guide: full input-driven method comparison for complex tasks (data/reference-driven vs closed-loop self-generated), simple one-liner otherwise. |
| **Metacognition checkpoints** | Mid-task reflection (4 questions incl. real-form verification) + final requirement check (delivery audit against the task text; full-artifact verification required). |
| **Block-length convergence steer** | A session whose running reasoning-block median crosses 2500 gets one "converge" nudge (calibrated on 11 recorded sessions). |
| **Verified deadlock ladder** | Suspicion (L1) → fingerprint-verified (L2) → pause-and-ask-user via `ask_user_question` (L3) → bounded reminder (L3b) → optional escalation (L4, plan-mode-safe, cancel without directive). |
| **Subagent timeout reminder** | Settled-aware reminder when a delegated subagent runs too long (default 15 min). |
| **Hot code reloader** | `cadence_reload` verifies the preset's modules from a throwaway copy, purges Node's ESM cache and bumps the composition stamp — the NEXT NEW session mounts the new code, no restart. |
| **Diagnostics** | `trace_status` (session state: complexity, phase, guard stats, block p50, steer counters) and `tool_search` (full tool catalog discovery) — both read-only. |

All injections are static texts, idempotent (durable markers), and routed
through the `agent/pre-step` waterfall.

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

Config values in `agent.cordis.yml` are re-read per session join — new
sessions pick up value changes immediately, no restart. Code changes
(`cadence-core.mjs` / `cadence-bootstrap.mjs` / `cadence-reloader.mjs`)
are loaded once per process (ES module cache): run `cadence_reload` in any
session for a hot reload (verify-first, next new session mounts the new
code), or restart the harness. In the DSH Web GUI, select the
`Cadence Standard (experimental)` preset (order 6) for the session.

## Configuration

Key options in `preset/agent.cordis.yml` → `cadence-bootstrap`:

| Option | Default | Meaning |
|---|---|---|
| `anchorFirstTurn` | `true` | enable the zero-tool warm-up turn |
| `anchorCapMaxTokens` | 2048 | the ONLY remaining cap: the warm-up request |
| `promoteOn` | `tool-call` | promotion trigger: `tool-call` \| `assistant-message` \| `either` |
| `reflectionAfterSteps` | 12 | steps before the mid-task reflection is due |
| `finalCheckAfterSteps` | 8 | steps after the last write before the acceptance check is due |
| `residentTools` | (17 tools) | resident catalog after promotion (conditioning only) |
| `subagentTimeoutMin` | 15 | delegated-subagent timeout reminder |
| `blockP50Threshold` | 2500 | convergence steer threshold (reasoning-block median) |
| `escalateAfterIgnore` | `false` | L4 escalation after repeated ignore (plan-mode-safe) |

## Testing

```bash
npm test        # node --test (test/cadence.test.mjs, 124 assertions)
npm run check   # syntax-check the preset modules, then run tests
```

The suite exercises every listener the bootstrap registers against a minimal
fake Cordis context, plus pure-function tests for the core detection logic:
classification, personas, guides, anchor + F1 pre-classification, promotion,
resident catalog + compaction epoch + strip/hint, metacognition checkpoints,
the full deadlock ladder L1–L4, the process-self guard matrix, subagent
timeout, convergence steer (fixtures + calibration), verification texts,
reloader + trace_status + tool_search.

## License

[MIT](./LICENSE)
