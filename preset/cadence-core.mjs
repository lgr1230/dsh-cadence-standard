/**
 * cadence-core v4 — LEAN core: pacing + safety + generic guidance.
 *
 * V4.0 de-fit removed: budget bands, Flash persona anchors, trajectory
 * steering, env-stuck detector, score-deliver calibration, delegation
 * advisor, todo sync, utilization, guide-frequency, trace_style/trace_tune,
 * bootstrap context strip, platform layer, file-discipline texts.
 * KEPT backbone: anchor turn (0 tools + the only cap), monotonic
 * classification, narrow first-task surface (promoteOn=tool-call),
 * personas, per-message guides (input-driven method comparison),
 * reflection + final check (relaxed), safety trio (deadlock ladder,
 * process-self guard, subagent timeout — precise), convergence steer.
 * V4.2: first-request class fix (pre-classify at inbox insert, F1) and
 * monotonic pre-step assignment. V4.3/V4.4: verification texts require the
 * artifact's REAL form; finalCheckDue counts the in-flight step (F4).
 *
 * Design rules: no task-domain words; thresholds calibrated across the
 * corpus; no model branches; no tool-family-specialized steers.
 * Security invariants (P1–P8): injection texts are static constants (zero
 * interpolation); no fs/shell/permission tools registered; injections are
 * idempotent via durable markers; L4 is opt-in and plan-mode-safe.
 */

/** Durable events that promote a session out of the bootstrap phase.
 *  V4.0: ONLY a tool call promotes — the warm-up reply (assistant/message)
 *  must NOT, so the first TASK request still runs on the narrow surface.
 *  (V4.4: bootstrap uses its own string literals; the constants were removed.) */

/**
 * Complexity heuristic. Long or architecturally-worded tasks are COMPLEX;
 * everything else is SIMPLE. Fix/debug keywords count as complex (inspect
 * first). Used by classification and by guidance selection.
 */
const COMPLEX_RE =
  /(多文件|重构|迁移|兼容|并发|性能|安全|架构|权衡|方案|规划|综合|集成|复杂|规模|修复|排查|调试|异常|打不开|报错|闪退|黑屏|白屏|卡死|崩溃|survey|overview|architecture|refactor|migration|concurrency|performance|security|design|trade-off|integrat|complex|scalab|bug|fix|debug|crash|blank|error)/i

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 160 || COMPLEX_RE.test(text))
}

export function extractText(data) {
  if (!data) return ''
  const content = Array.isArray(data.content) ? data.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

/* ── classification ───────────────────────────────────────────────────────── */

/** Classify a claimed batch from its first real user message (or null). */
export function classifyMessages(messages) {
  for (const m of messages ?? []) {
    if (m?.source?.kind === 'user') {
      const t = extractText(m)
      if (t.trim()) return isComplexTask(t) ? 'complex' : 'simple'
    }
  }
  return null
}

/** Session class from durable events: starts simple, upgrades on complex. */
export function sessionClass(events) {
  let cls = 'simple'
  for (const e of events ?? []) {
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      if (isComplexTask(extractText(e.data))) cls = 'complex'
    }
  }
  return cls
}

/**
 * Effective class for the current step: batch (entering messages) preferred
 * over durable events; complex wins (monotonic upgrade, never downgrade).
 */
export function effectiveClass(batchMessages, events) {
  const batch = classifyMessages(batchMessages)
  return batch === 'complex' || sessionClass(events) === 'complex' ? 'complex' : 'simple'
}

/* ── personas and first-request tool surface ──────────────────────────────── */

const SIMPLE_PERSONA =
  'You are a helpful assistant.\n'
  // V4.10 (session-28 review): the old "minimal tools needed; do not multiply
  // steps, plans, or ceremony" wording was an EXPLICIT minimum-spend directive
  // — session-28 (Pro) drifted to the cheapest option, 0 goal, 0 subagents
  // (vs session-22 standard: 7 subagents + goal, "夯爆"). Neutral wording:
  // proportionate effort, no under-investment.
  + 'Match your effort to the task. For straightforward tasks, decide quickly '
  + 'and act directly with the tools you need; avoid ceremony, but do not '
  + 'under-invest when the task deserves more.'

const COMPLEX_PERSONA =
  'You are a helpful software engineer assistant.\n'
  // V4.11 (2026-08-21): the "end each reasoning block with a decision"
  // requirement was removed — it forced every block to close with a decision,
  // suppressing open-ended exploration and divergent reasoning (user review).
  + 'Before acting, decide whether this task is simple or complex. For complex '
  + 'tasks: think deeply first — architecture, edge cases, integration points — '
  + 'and let the thinking run as deep as the task needs. For simple tasks: act directly.\n'
  // V4.8 (O2-B): persistent narration guidance — present in every request's
  // system prompt, unlike one-shot injections (session-24: the V4.7 guide
  // fired in the planning request and never reached the execution phase).
  // V4.11: "verify key assumptions before acting" removed from narration
  // (a pre-action verification gate can stall momentum).
  + 'Narrate your process in first person during execution (state findings, '
  + 'commit next steps).\n'
  // V4.13 (2026-08-22, session-30 review): interleave thinking with tool
  // calls — session-30 turn1 burned the whole 64k output budget in ONE
  // reasoning block (568s, zero tools) and was cut off mid-sentence; the
  // same session's turn2 interleaved and never truncated. Distinct from the
  // direct-task "make one clear move": this targets finish-the-plan-in-the-
  // head blowouts, not first-step hesitation.
  + 'Interleave thinking with tool calls: do not finish the whole plan in your head '
  + 'before the first action — take the first minimal step, then deepen.\n'
  // V4.13b (2026-08-22, session-31 review): the model's actual blowout mode
  // is drafting COMPLETE CODE inside reasoning (session-31: every pre-write
  // request burned 24k reasoning tokens writing files mentally, 3/3 turns
  // cut). Explicit: code is written by tools, not drafted in reasoning.
  + 'Write code with the write/edit tools; do not draft the full code inside reasoning.\n'
  // V4.13 (2026-08-22, session-30 review): long tasks should ride the goal
  // mechanism instead of the preset inventing scale rules — the goal driver
  // auto-queues rounds while the goal is active, which both sustains
  // multi-stage work and carries the scale expectation inside the objective.
  + 'For long-running or multi-stage tasks, create a goal first (create_goal) whose '
  + 'objective states the delivery form and the scale expectation (order of magnitude, '
  + 'density, coverage) — not the minimal viable version; the goal mechanism drives '
  + 'rounds automatically until completion.'

export function personaFor(complex) {
  return complex ? COMPLEX_PERSONA : SIMPLE_PERSONA
}

/** Replace only the persona section of an assembled section list. */
export function applyPersona(sections, text) {
  const rest = (sections ?? []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'cadence-persona', text, order: 0 }]
}

/* ── injection texts (static constants; P2: zero interpolation) ───────────── */
/* V4.7: model-facing injections are ENGLISH (unified with the English
 * persona/plan-mode — the old Chinese injections mixed languages inside the
 * reasoning domain; session-22 trajectory data shows English narration
 * drives the Pro chain). SAFETY texts stay Chinese (deadlock ladder,
 * subagent timeout, process-self veto — "safety wording stays precise",
 * user-visible). User-message regexes keep Chinese+English matching. */

export const GUIDE_SIMPLE =
  // V4.10: "only if" was a hard conservative escalation gate — softened.
  // V4.11: the evidence-wait removed entirely — deepen as the task demands.
  '\nCadence: this is a direct task. Make one clear move first; deepen the plan as the task demands.'

/** Shared env-capability strategy (V2.5 wording, relaxed in V4.0: no tool-name
 *  enumeration; V4.6: default config != only config, read-only probing). */
export const ENV_STUCK_TEXT =
  'When a critical dependency is constrained by the environment (command failure / missing tool): '
  + 'first do a full availability check (full paths, common probe commands, package managers) — '
  + 'a failed command does not mean the capability is missing; the default/common configuration is not the only configuration — '
  + 'environment capabilities your execution path depends on (acceleration, rendering, network) must be verified in practice; '
  + 'probing is read-only only; pick a usable path. '
  // V4.10 (session-28 review): software rendering saturates the CPU. Minimal
  // wording per user (2026-08-21): no rationale in the guide text.
  + 'For anything visual (rendering/screenshots), prefer hardware acceleration; do not use software rendering. '
  + 'If a stuck route may still be better and another route can progress, delegate a read-only subagent '
  + 'to verify the environment in parallel (query only — do not install/modify/delete any environment component; '
  + 'if installation is needed, return to the main process), keep the main process moving on the current route, '
  + 'and re-evaluate after it returns.'

/** V4.7 complex-task guide (input-driven comparison + delegation + env).
 *  V4.8 (O2-C): the first-person narration sentence MOVED OUT to
 *  STEER_NARRATION (execution-phase injection) — session-24 showed the
 *  guide fires in the planning request where there is no process to
 *  narrate; "think deeply" reworded decision-oriented so V4-Pro does not
 *  extend planning into a 92k-token single block (session-24: 24.5 min
 *  first request, 91,788 reasoning tokens, cache 0%). */
export const GUIDE_COMPLEX =
  // V4.11 (2026-08-21): "Think to a decision", "end this block with a
  // decision" and "deepen the plan later" all removed — they capped thinking
  // depth and forced every block to close with a decision (user review).
  '\nCadence: this is a complex task. Think before acting — '
  + 'architecture, edge cases, integration points. '
  + 'Compare production approaches: is your plan "input-driven" (data/docs/samples/reference/existing code '
  + 'actually read into the output) or "closed-loop self-made" (input only peripheral, output derived from '
  + 'assumptions)? If a better route exists that turns input into output, compare its ceiling and cost before deciding. '
  // V4.10 (session-29 review): the old "large or input-heavy" condition
  // framed delegation on the INPUT side — 29号 (voxel-china: big OUTPUT,
  // no external inputs) judged itself unqualified and ran 17 serial steps
  // alone. Modularity is the right criterion: parallelizable components.
  + 'If the task can be modularized (parallelizable components/modules), consider delegating subagents to build '
  + 'independent modules in parallel; the main process owns architecture, assembly and validation — give each '
  + 'subagent a complete self-contained brief and review its output before merging. '
  + ENV_STUCK_TEXT

/** V4.8 (O2-A): execution-phase narration steer — injected ONCE after
 *  promotion, at the SECOND tool call (the first tool call promotes; the
 *  instruction hint fires right after it — narration waits one more step so
 *  the two injections never stack). Session-22 trajectory: I'm density
 *  19.4/10k is the spontaneous Pro signature; the V4.7 guide never reached
 *  execution (fired in the planning request). */
export const STEER_NARRATION =
  // V4.11: "verify key assumptions before acting (let me ...)" removed — a
  // pre-action verification gate can stall momentum.
  '\nCadence narration: now executing — narrate your process in first person as you go: '
  + 'state what you are doing and finding (I am ...), commit the next step after each decision '
  + '(I will ...).'

/** Deadlock ladder (SAFETY — wording stays precise, never relaxed). */
export const STEER_STALL =
  '\nCadence 进度停滞：最近的调用在重复或连续报错。换个角度——更小范围、不同工具、先读相关上下文，或询问用户——不要重复同一调用。'

export const STEER_DEADLOCK =
  '\nCadence 已核验卡死：最近多次调用参数与失败结果完全相同，方案已被验证无效。现在切换：'
  + '(a) 换策略（不同工具/范围/实现）；(b) 委派 subagent 独立审查（打包接口+现象）；(c) 询问用户。禁止再重试原方案。'

export const STEER_PAUSE =
  '\nCadence 暂停指令：卡死已核验且切换建议未奏效。现在暂停自主工作——'
  + '调用 ask_user_question 询问用户（选项：终止任务 / 换方案继续 / 保持现状），'
  + '问题中说明卡点、已尝试次数与备选方向。用户回答前不要执行其他工具调用；'
  + '若 ask_user_question 不可用，以纯文本回复结束本轮，把选择权交给用户。'

export const STEER_PAUSE_REMINDER =
  '\nCadence 提醒：你忽略了上一条暂停指令。本步必须调用 ask_user_question 或停止自主工作；'
  + '不得继续重试已核验无效的方案。'

/** Subagent timeout (SAFETY). */
export const STEER_SUBAGENT =
  '\nCadence 子代理超时：委派的子代理已运行过久且未返回。用 list_agents 检查进展；'
  + '若无进展可 interrupt_agent 中断它，自己接手剩余工作（注意其报告可能基于旧代码）。'

/** Mid-task reflection — generic metacognition checkpoint, relaxed wording
 *  (V4.0). ④ requires verification to present the artifact's REAL/COMPLETE
 *  form (V4.6: dynamic/时序; session-21 ghosting was invisible to static
 *  screenshots). ⑤ V4.7: intent declaration (session-22 "I want" role). */
export const STEER_REFLECTION =
  '\nCadence reflection: pause for a moment and answer the questions — '
  + '① Is what I am completing truly what the task asks, or just "the right-looking action"? '
  + '② Have the required input materials (docs/data/reference/samples) actually entered my output? '
  + '③ If I delivered right now, would the user consider the task done? '
  + '④ If the artifact has a visual or spatial form (including dynamic processes), does my verification present '
  + 'its COMPLETE form — beyond static frames, are motion, timing behavior and state residue also verified? '
  + 'Or only numeric summaries, textual or character-based representations? '
  + '⑤ What effect/quality am I actually aiming for, and does the current state meet it? '
  // V4.9 (B): content-density reflection (session-25: 1,958 units vs 24: 10,182).
  + '⑥ Is the artifact\'s content density proportionate to the task scale — enough basic units to carry '
  + 'the intended detail, or was it thinned for convenience? '
  // V4.11: the "close the smallest gap / do not restart from scratch" tail was
  // removed — smallest-first nudges minimal patching and no-restart blocks
  // bold rewrites (user review: "不惜重构").
  + 'If there is a gap, close it in the order that best serves the goal.'

/** V4.13 (2026-08-22, session-30 review): truncation auto-recovery message.
 *  Injected once per session by the bootstrap's session/event listener when a
 *  max-tokens turn/end produced ZERO tool calls — the turn's thinking was cut
 *  off before any action (session-30: 64k reasoning tokens, 568s, nothing
 *  executed, user had to say "继续"). The plan is not lost (it is in the
 *  visible reasoning), so continue with the first minimal action instead of
 *  re-planning. Static, model-facing English, zero interpolation (P2). */
export const STEER_RECOVER =
  '\nCadence auto-recovery: the previous turn was cut off at the output limit before executing '
  + 'any action. Do not re-plan from scratch — take the FIRST minimal action now '
  + '(write the first file / run the first command), then continue step by step.'

/** Final requirement check — a delivery audit against the original task.
 *  V4.3+: full-artifact / real-form verification lines (V4.2 lesson).
 *  V4.6: broad-requirement interpretation line (session-21 "真实结构"). */
export const STEER_FINAL_CHECK =
  '\nCadence final check: before delivery, go through every requirement in the original task against '
  + 'your output — is each met? Are there items where you "did the action" but did not achieve the goal? '
  + 'If the task has reference inputs (source image/sample/data/existing implementation), verify your output '
  + 'against the reference and confirm the reference actually entered the output (read/parsed/sampled — '
  + 'downloading or searching alone does not count). '
  + 'The comparison must act on the artifact\'s complete form — thumbnails, downsampling or partial sampling '
  + 'do not represent overall quality. Verification must present the artifact\'s real form; no numeric, '
  + 'textual or character summary can substitute. '
  + 'Self-ratings or external scores are not delivery evidence — does the evaluator\'s standard equal the task '
  + 'expectation? If the gap is large, keep iterating or confirm expectations with the user instead of '
  + 'delivering on a single score. '
  + 'For broad requirements in the original wording (like "real", "complete", "comprehensive"), state your '
  + 'interpretation and any simplifications at delivery; if your interpretation diverges materially from the '
  + 'task, confirm scope with the user first. '
  // V4.9 (B): content-density floor — session-25 thinned the palace to 1,958
  // basic units vs session-24's 10,182 ("1000 voxels is lazy"; optimization
  // became a license to cut content). Generic: basic units, proportionate.
  + 'Check content density against task scale: the number of basic units (blocks/cells/elements) your '
  + 'artifact is built from should match the task\'s ambition — do not shrink the basic-unit count for '
  + 'convenience; optimization is not a license to reduce content. '
  + 'Close unmet items first, or explain the gap to the user.'

/** V4.0 convergence steer: long reasoning blocks get one nudge to converge
 *  (routing-suite P10: deep thinking without a commit binding starves the
 *  budget). V4.11: the per-block decision requirement and the
 *  "instead of expanding the thinking" tail removed — the steer only says
 *  to act when information is sufficient. Generic: no task words. */
export const STEER_CONVERGE =
  '\nCadence converge: recent reasoning blocks are notably long. Converge before continuing — '
  + 'when information is sufficient, produce or execute the next action.'

/** V4.10 (B2) block-depth steer: the mirror image of converge. Session-26
 *  (V4-Flash, 55 steps): p50=771 vs the 2500 converge line — the converge
 *  steer only fires on OVER-long medians, so a fragmented session (one
 *  shallow observation per step) never gets a nudge. Once per session, fires
 *  when the running median falls BELOW the floor. Static, zero interpolation;
 *  model-facing English. */
export const STEER_DEEPEN =
  '\nCadence deepen: recent reasoning blocks are notably short and fragmented. '
  + 'Think deeper before continuing — each block should carry the whole chain '
  + '(current finding → the decision it implies → the specific next step) instead of '
  + 'one shallow observation; when information is sufficient, take one decisive action '
  + 'rather than several shallow ones.'

/** V4.1 instruction hint (R3, orchestrator pattern): instead of injecting the
 *  full AGENTS.md/CLAUDE.md digest (a large block that perturbs the
 *  trajectory), one short hint is injected ONCE after promotion — the model
 *  reads the instruction files itself when relevant. Static text. */
/** V4.5 means-cost soft steer (detection-driven, complex tasks): the same
 *  execution/verification MEANS (platform command + script) has been run
 *  several times, is still failing, and has consumed noticeable wall-time.
 *  Generic: no task-domain words, no tool-name enumeration. */
export const STEER_MEANS_COST =
  '\nCadence means cost: the same execution/verification means has run multiple times without success '
  + 'and consumed noticeable wall-time. Pause once and evaluate the means itself — per-run cost, whether '
  + 'its run mode is constrained, whether the scope can shrink, and whether a cheaper alternative path '
  + 'exists; only continue after confirming the means is effective.'

/** V4.5 unconverged-means hard backstop (detection-driven, any task): the
 *  same MEANS has repeated many times, accumulated a large wall-time cost and
 *  still has no success — the last run failed. Unlike the deadlock ladder
 *  (identical command/failure fingerprints), this catches "progressing but
 *  not converging" loops (session-19: 10 x ~10min full acceptance runs). */
export const STEER_UNCONVERGED =
  // V4.11: "shrinking scope" removed from the preferred options — shrinking
  // is a retreat, not a first choice (user review).
  '\nCadence means review: the same execution/verification means has repeated many times, accumulated '
  + 'a large wall-time cost, and still has no success. Re-evaluate the means itself (cost, run mode, scope, '
  + 'alternative paths); prefer switching the approach; if you must continue, first state why the '
  + 'means is irreplaceable.'

/* ── V4.1 resident catalog + compaction epoch (orchestrator-inspired) ─────── */

/** Tool names the model explicitly used beyond the resident set, derived from
 *  durable tool/call events (resume/reload safe — no free-form state). */
export function unlockedTools(events, resident) {
  const unlocked = new Set()
  for (const e of events ?? []) {
    if (e.type !== 'tool/call') continue
    const name = e.data?.name
    if (typeof name === 'string' && name.length > 0 && !resident.has(name)) unlocked.add(name)
  }
  return unlocked
}

/** True when the session is in the POST-COMPACTION controlled phase: the last
 *  successful compaction/end landed AFTER the last progress (assistant
 *  message or tool call). The first new progress past the boundary
 *  re-promotes (a compaction rewrites the whole surface — the first
 *  post-compaction request is a "second first request"). */
export function postCompaction(events) {
  let lastComp = -1
  let lastProgress = -1
  for (const e of events ?? []) {
    if (e.type === 'compaction/end' && e.data?.error === undefined) lastComp = e.seq
    if (e.type === 'assistant/message' || e.type === 'tool/call') lastProgress = e.seq
  }
  return lastComp > lastProgress
}

/* ── metacognition triggers (generic) ─────────────────────────────────────── */

/** Whether the user intervened after the initial task (more than one real
 *  user message in the log). Interventions are external feedback that make
 *  the internal checkpoints redundant. */
export function userIntervened(events) {
  return (events ?? []).filter(
    (e) => e.type === 'user/message' && e.data?.source?.kind === 'user',
  ).length > 1
}

/** Mid-task reflection is due for a complex task with enough steps and no
 *  user intervention since. Generic trigger: step count only. */
export function reflectionDue(events, cfg) {
  const steps = (events ?? []).filter((e) => e.type === 'step/start').length
  if (steps < (cfg?.reflectionAfterSteps ?? 12)) return false
  return !userIntervened(events)
}

/** Final requirement check: a write exists, enough steps since the MOST
 *  RECENT write, no user intervention. Runs at pre-step time, which does not
 *  see the CURRENT step (its step/start lands after) — count it in, or a
 *  session ending exactly `finalCheckAfterSteps` steps after its last write
 *  never fires (measured: Mona V4.2 V4F).
 *  V4.6: a global step floor (`finalCheckMinSteps`, default 20) stops the
 *  check from firing during early build-out of edit-heavy sessions — the
 *  write-only signal fired at step 12/15 in sessions 21/19 (delivery at
 *  147/152) and collided with the reflection checkpoint (step 12).
 *  Calibrated on 8 archived sessions: 05/06/17/18/20 unaffected, 16/19/21
 *  shift to step >= 20, all still far ahead of delivery. */
export function finalCheckDue(events, cfg) {
  const writes = (events ?? []).filter(
    (e) => e.type === 'tool/call' && e.data?.name === 'write',
  )
  if (writes.length === 0) return false
  const lastWriteSeq = writes.at(-1).seq
  const stepsAfter = (events ?? []).filter(
    (e) => e.type === 'step/start' && e.seq > lastWriteSeq,
  ).length
  if (stepsAfter + 1 < (cfg?.finalCheckAfterSteps ?? 8)) return false
  const totalSteps = (events ?? []).filter((e) => e.type === 'step/start').length
  if (totalSteps + 1 < (cfg?.finalCheckMinSteps ?? 20)) return false
  return !userIntervened(events)
}

/** Only top-level fresh sessions (no prior user message) get the anchor turn. */
/* ── deadlock ladder (V2 verified ladder; SAFETY) ─────────────────────────── */

export const DL_NONE = 0
export const DL_SUSPECT = 1
export const DL_VERIFIED = 2
export const DL_PAUSE = 3
export const DL_REMIND = 4
export const DL_ESCALATE = 5

/** True when a REAL user message actually ASKS for a restart/kill — mere
 *  mention of the words must NOT count. Safety: precise. */
export function userAskedRestart(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return /(?:请|帮我|麻烦|需要|可以|麻烦你)[^。\n，,]{0,12}(?:重启|终止|停止|杀掉|停掉|kill|restart)/i.test(text)
    || /^(?:重启|终止|停止|杀掉|停掉|kill|restart)[^。\n，,]{0,12}(?:dsh|web|服务|进程|harness|server)/i.test(text)
    || /please[^.\n]{0,12}(?:restart|kill|stop|shut down)/i.test(text)
}

/** True when a shell command would terminate the harness process itself:
 *  a kill verb targeting the running web process or its direct parent
 *  (numeric PID match), or a name-wide node kill. Safety: precise. */
export function selfKillDetect(command, ownPid, parentPid) {
  if (typeof command !== 'string' || command.length === 0) return false
  if (!/\b(Stop-Process|taskkill|kill|Kill-Process|Stop-Computer)\b/i.test(command)) return false
  const pid = ownPid ?? process.pid
  const ppid = parentPid ?? process.ppid
  const numeric = [...command.matchAll(/\d+/g)].map((m) => Number(m[0]))
  if (numeric.some((n) => n === pid || n === ppid)) return true
  if (/(?:-Name|-ProcessName|\/IM|\/IMAGENAME)\s+node(?:\.exe)?|Get-Process\s+node(?:\.exe)?/i.test(command)) return true
  return false
}

/** The veto result text for a self-kill attempt. Safety: precise. */
export function selfKillVetoMessage(pid) {
  return `Cadence 保护：该命令会终止/重启 dsh 进程本体（当前 web 进程 PID=${pid}），将导致网页中断、会话空转。`
    + '请先调用 ask_user_question 向用户确认（说明原因与恢复方式），用户回复后再重试执行；'
    + '若用户已明确要求重启/终止，可直接重试执行。'
}

/** Whether a delegated subagent started but never settled past the timeout.
 *  Signals come from durable events: the subagent tool/call start time vs the
 *  settlement NOTICE — which arrives as a `user/message` whose
 *  `source.kind === 'subagent-settled'`. Pure function; `nowMs` from caller. */
export function subagentOverdue(events, nowMs, timeoutMs) {
  if (!Array.isArray(events) || timeoutMs <= 0) return false
  let startedAt = null
  for (const e of events) {
    if (e.type === 'tool/call' && e.data?.name === 'subagent' && startedAt === null) {
      startedAt = e.time
    }
  }
  if (startedAt === null) return false
  const settled = (events ?? []).some(
    (e) => e.type === 'user/message' && e.data?.source?.kind === 'subagent-settled',
  )
  return !settled && (nowMs ?? Date.now()) - startedAt > timeoutMs
}

/* ── V4.0 block-length convergence steer ──────────────────────────────────── */

/** Median length of all reasoning blocks in the session (0 when none). */
export function blockMedian(events) {
  const blens = []
  for (const e of events ?? []) {
    if (e.type !== 'assistant/message') continue
    for (const b of (e.data?.message?.content ?? []).filter((x) => x.type === 'reasoning')) {
      blens.push((b.text ?? '').length)
    }
  }
  if (blens.length === 0) return 0
  blens.sort((a, b) => a - b)
  return blens[Math.floor(blens.length / 2)]
}

/** True when the RUNNING median reasoning-block length crossed the
 *  threshold (calibrated on 11 recorded sessions: only the worst one — Mona
 *  V3.1 V4P, p50 4114 — crosses 2500). User feedback makes it redundant. */
export function blockLengthSteerDue(events, cfg = {}) {
  const steps = (events ?? []).filter((e) => e.type === 'step/start').length
  if (steps < (cfg.blockLengthAfterSteps ?? 10)) return false
  if (userIntervened(events)) return false
  const blens = []
  for (const e of events ?? []) {
    if (e.type !== 'assistant/message') continue
    for (const b of (e.data?.message?.content ?? []).filter((x) => x.type === 'reasoning')) {
      blens.push((b.text ?? '').length)
    }
  }
  if (blens.length < 3) return false
  blens.sort((a, b) => a - b)
  const p50 = blens[Math.floor(blens.length / 2)]
  return p50 >= (cfg.blockP50Threshold ?? 4000)
}

/** True when the RUNNING median reasoning-block length fell BELOW the floor
 *  (V4.10/B2: session-26 p50=771 vs the 2500 converge line — converge is
 *  over-long-only, so fragmented sessions never fire; p75=2620 shows flash
 *  CAN write long blocks, so a sub-1000 median means shallow steps, not a
 *  capability limit). Pairs with blockLengthSteerDue into a
 *  [blockP50Floor, blockP50Threshold) healthy band. */
export function blockShortnessSteerDue(events, cfg = {}) {
  const steps = (events ?? []).filter((e) => e.type === 'step/start').length
  if (steps < (cfg.blockShortnessAfterSteps ?? 10)) return false
  if (userIntervened(events)) return false
  const blens = []
  for (const e of events ?? []) {
    if (e.type !== 'assistant/message') continue
    for (const b of (e.data?.message?.content ?? []).filter((x) => x.type === 'reasoning')) {
      blens.push((b.text ?? '').length)
    }
  }
  if (blens.length < 3) return false
  blens.sort((a, b) => a - b)
  const p50 = blens[Math.floor(blens.length / 2)]
  return p50 < (cfg.blockP50Floor ?? 1000)
}

/* ── injection assembly (idempotent, derived) ─────────────────────────────── */

/**
 * Compute everything this step should inject, in priority order.
 * Every entry is { marker, text }; marker === null entries (per-message
 * guides) are idempotent by message id instead.
 */
export function pendingInjections({ events, batchMessages, cls, promoted, cfg, nowMs }) {
  const fired = (text) => events.some(
    (e) => e.type === 'user/message' && extractText(e.data).includes(text),
  )
  const complex = cls === 'complex'
  const out = []

  // V4.8 (O2-A): execution-phase narration — once, complex tasks, at the
  // SECOND tool call (V4.12: no promotion phases, so "tool calls >= 2" is
  // the whole trigger).
  if (cfg.narrationAdvisor !== false && complex && !fired('Cadence narration')
    && (events ?? []).filter((e) => e.type === 'tool/call').length >= 2) {
    out.push({ marker: 'Cadence narration', text: STEER_NARRATION })
  }

  // Per-message guides: only for real user messages not yet entered.
  for (const m of batchMessages ?? []) {
    if (m?.source?.kind !== 'user') continue
    if (events.some((e) => e.type === 'user/message' && e.data?.id === m.id)) continue
    const text = extractText(m)
    if (!text.trim()) continue
    out.push({ marker: null, text: isComplexTask(text) ? GUIDE_COMPLEX : GUIDE_SIMPLE })
  }

  // Deadlock ladder (each level once per episode; markers gate idempotency).
  if (cfg.deadlockDetector) {
    const dl = detectDeadlock(events, cfg)
    if (dl === DL_SUSPECT && !fired('进度停滞')) out.push({ marker: 'Cadence 进度停滞', text: STEER_STALL })
    if (dl === DL_VERIFIED && !fired('已核验卡死')) out.push({ marker: 'Cadence 已核验卡死', text: STEER_DEADLOCK })
    if (dl === DL_PAUSE && !fired('暂停指令')) out.push({ marker: 'Cadence 暂停指令', text: STEER_PAUSE })
    if (dl === DL_REMIND && !fired('Cadence 提醒')) out.push({ marker: 'Cadence 提醒', text: STEER_PAUSE_REMINDER })
  }

  // Subagent timeout (once per session; safety).
  if (cfg.subagentTimeoutMin > 0 && !fired('Cadence 子代理超时')
    && subagentOverdue(events, nowMs ?? Date.now(), cfg.subagentTimeoutMin * 60000)) {
    out.push({ marker: 'Cadence 子代理超时', text: STEER_SUBAGENT })
  }

  // V4.5 means detection (session-19 calibration): soft layer (3 runs / 5
  // min, complex) reminds to re-evaluate the means; hard backstop (5 runs /
  // 15 min, any task) demands re-evaluation of the means itself. The hard
  // steer supersedes the soft one (same means, stronger wording), so a hard
  // hit suppresses the soft injection for that step. V4.7: English markers.
  const hardHit = cfg.unconvergedDetector !== false && !fired('Cadence means review')
    && meansStats(events, {
      minRuns: cfg.unconvergedRuns ?? 8,
      minAccMs: (cfg.unconvergedMinSec ?? 1200) * 1000,
    })
  if (cfg.meansCostAdvisor !== false && complex && !fired('Cadence means cost') && !hardHit
    && meansStats(events, {
      minRuns: cfg.meansCostRuns ?? 5,
      minAccMs: (cfg.meansCostMinSec ?? 600) * 1000,
    })) {
    out.push({ marker: 'Cadence means cost', text: STEER_MEANS_COST })
  }
  if (hardHit) {
    out.push({ marker: 'Cadence means review', text: STEER_UNCONVERGED })
  }

  // Mid-task reflection (once per session; generic metacognition checkpoint).
  if (cfg.reflectionAdvisor && complex && !fired('Cadence reflection') && reflectionDue(events, cfg)) {
    out.push({ marker: 'Cadence reflection', text: STEER_REFLECTION })
  }

  // Final requirement check (once per session; generic delivery audit).
  if (cfg.finalCheckAdvisor && complex && !fired('Cadence final check') && finalCheckDue(events, cfg)) {
    out.push({ marker: 'Cadence final check', text: STEER_FINAL_CHECK })
  }

  // Block-length convergence steer (once per session; V4.0).
  if (cfg.blockLengthSteer && complex && !fired('Cadence converge') && blockLengthSteerDue(events, cfg)) {
    out.push({ marker: 'Cadence converge', text: STEER_CONVERGE })
  }

  // V4.10 (B2) block-depth steer (once per session): the running median fell
  // BELOW the floor — fragmented shallow steps (session-26 p50=771). Pairs
  // with converge into a [floor, threshold) healthy band.
  if (cfg.blockDepthSteer && complex && !fired('Cadence deepen') && blockShortnessSteerDue(events, cfg)) {
    out.push({ marker: 'Cadence deepen', text: STEER_DEEPEN })
  }

  return out
}

/* ── trace helpers ────────────────────────────────────────────────────────── */

export function countMarkers(events, text) {
  return events.filter(
    (e) => e.type === 'user/message' && extractText(e.data).includes(text),
  ).length
}

/* ── deadlock ladder internals (V4.0 rebuild: suspicion (L1) →
 *  fingerprint-verified (L2) → pause-and-ask (L3) → bounded reminder (L3b)
 *  → optional escalation (L4). Progress resets the episode; steers gate the
 *  next detection by grace steps. SAFETY — locked by the ladder tests. ── */

function failureFingerprint(result) {
  try {
    const inner = result?.data?.message?.content?.[0]?.content ?? []
    return inner.map((x) => x.text ?? '').join(' ').slice(0, 120)
  } catch { return '' }
}

/** Count occurrences of the MOST repeated identical tool call (name+args)
 *  after `fromSeq`. Interleaved writes are tolerated (loop case). */
export function identicalCommandCount(events, fromSeq = 0) {
  const counts = new Map()
  for (const e of events ?? []) {
    if (e.type !== 'tool/call' || e.seq <= fromSeq) continue
    const key = `${e.data?.name}|${JSON.stringify(e.data?.arguments)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts.size ? Math.max(...counts.values()) : 0
}

/** Count occurrences of the MOST repeated identical failure fingerprint
 *  (non-empty tool result text) after `fromSeq`. */
export function identicalFailureCount(events, fromSeq = 0) {
  const counts = new Map()
  for (const e of events ?? []) {
    if (e.type !== 'tool/result' || e.seq <= fromSeq) continue
    const fp = failureFingerprint(e)
    if (!fp) continue
    counts.set(fp, (counts.get(fp) ?? 0) + 1)
  }
  return counts.size ? Math.max(...counts.values()) : 0
}

const DEADLOCK_MARKERS = ['进度停滞', '已核验卡死', '暂停指令', 'Cadence 提醒']

/** The episode window: all events AFTER the last progress event. Progress is
 *  a write/edit tool call or an assistant message. V4.4 review note: because
 *  real sessions produce an assistant/message every step (the model reasons
 *  before each tool call), the window normally covers only the current
 *  step's calls — CROSS-STEP repeated commands are not detected by design
 *  (a model that keeps emitting reasoning is treated as still working).
 *  Kept as-is: the ladder is a safety backstop for the no-output case, and
 *  the fixture tests lock this behavior. */
function deadlockWindowStart(evs) {
  let start = 0
  for (const e of evs) {
    if (e.type === 'tool/call' && (e.data?.name === 'write' || e.data?.name === 'edit')) start = e.seq
    if (e.type === 'assistant/message') start = e.seq
  }
  return start
}

/** Verified deadlock ladder (SAFETY). Episode stage = number of deadlock
 *  steers already injected; each new detection advances one stage. */
export function detectDeadlock(events, cfg = {}) {
  const maxRepeats = cfg.maxRepeats ?? 4
  const maxIdenticalFailures = cfg.maxIdenticalFailures ?? 3
  const grace = cfg.graceStepsAfterSteer ?? 2
  const evs = events ?? []

  const steers = evs.filter((e) => e.type === 'user/message'
    && DEADLOCK_MARKERS.some((m) => extractText(e.data).includes(m)))
  const lastSteerSeq = steers.length ? steers.at(-1).seq : -1
  if (lastSteerSeq >= 0) {
    const stepsSince = evs.filter((e) => e.type === 'step/start' && e.seq > lastSteerSeq).length
    if (stepsSince < grace) return DL_NONE
  }

  // Progress of any kind resets the episode (the window starts after it).
  const windowStart = deadlockWindowStart(evs)
  const repeats = identicalCommandCount(evs, windowStart)
  const fails = identicalFailureCount(evs, windowStart)
  if (repeats < maxRepeats && fails < maxIdenticalFailures) return DL_NONE

  const stage = steers.length
  if (stage === 0) return DL_SUSPECT
  if (stage === 1) return DL_VERIFIED
  if (stage === 2) return DL_PAUSE
  if (stage === 3) return DL_REMIND
  return cfg.escalateAfterIgnore ? DL_ESCALATE : DL_NONE
}

/* ── V4.5 means-level detection + catalog matching ──────────────────────────
 * The deadlock ladder keys on IDENTICAL commands/failures and resets its
 * window at every assistant/message — a session that reasons before each
 * call (session-19) never trips it even while burning ~100 min on the same
 * verification means with a different failure each round. meansStats keys
 * on the MEANS (platform command + first script path), ignores interleaved
 * writes/reasoning, and requires cumulative wall-time so quick retries
 * (downloads, fast scripts) never fire. Calibrated on 6 recorded sessions:
 * fires on 19 at run 5 (~50 min saved); silent on 05/06/16/17/18. ── */

/** Failure-shaped result text: error words or a non-zero exit marker. */
export function resultFailed(text) {
  return /fail|error|timeout|超时|失败|报错|invalid|exception|timed out|exit[=: ]+[1-9]/i.test(String(text ?? ''))
}

/** Means fingerprint: platform command name + the first script path in the
 *  command. Log redirection/arg churn is the SAME means (session-19 ran the
 *  same acceptance script via Tee and via `>` — one means). */
export function meansKey(e) {
  const name = e.data?.name ?? ''
  if (name !== 'pwsh' && name !== 'bash') return null
  let cmd = ''
  try { cmd = String(JSON.parse(e.data?.arguments ?? '{}')?.command ?? '') } catch { return null }
  if (!cmd.trim()) return null
  cmd = cmd.replace(/\\/g, '/')
  const script = cmd.match(/(?:node|python|py|npm|npx|uv)\s+[\w./-]*?([\w.-]+\.(?:mjs|js|py|ps1|sh))\b/i)
  return `${name}|${script ? script[1].toLowerCase() : cmd.slice(0, 40).toLowerCase()}`
}

/** Find the first unconverged means: same means ran >= minRuns times,
 *  accumulated >= minAccMs wall-time, and its LAST result still failed.
 *  Returns { key, runs, accMs, lastFailed } or null. Single pass, O(n). */
export function meansStats(events, cfg = {}) {
  const minRuns = cfg.minRuns ?? 5
  const minAccMs = cfg.minAccMs ?? 900000
  const evs = events ?? []
  const byCall = new Map()
  const runs = new Map()
  for (const e of evs) {
    if (e.type === 'tool/call') {
      if (e.data?.name !== 'pwsh' && e.data?.name !== 'bash') continue
      byCall.set(e.data?.callId, e)
    } else if (e.type === 'tool/result') {
      const callId = e.data?.message?.content?.[0]?.toolCallId
      if (callId === undefined) continue
      const call = byCall.get(callId)
      if (call === undefined) continue
      const key = meansKey(call)
      if (key === null) continue
      let text = ''
      try {
        text = (e.data.message.content[0].content ?? []).map((p) => p.text ?? '').join(' ')
      } catch { /* keep '' */ }
      // Wall-time in MILLISECONDS (matches minAccMs units).
      const dur = Math.max(0, (e.time ?? e.time0 ?? 0) - (call.time ?? call.time0 ?? 0))
      const r = runs.get(key) ?? { key, runs: 0, accMs: 0, lastFailed: false }
      r.runs += 1
      r.accMs += dur
      r.lastFailed = resultFailed(text)
      runs.set(key, r)
    }
  }
  for (const r of runs.values()) {
    if (r.runs >= minRuns && r.accMs >= minAccMs && r.lastFailed) return r
  }
  return null
}
