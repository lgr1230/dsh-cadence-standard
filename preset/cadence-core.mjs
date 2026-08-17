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
  + 'Match your effort to the task. For straightforward tasks, decide quickly '
  + 'and act directly with the minimal tools needed; do not multiply steps, '
  + 'plans, or ceremony without evidence that the task is bigger than it looks.'

const COMPLEX_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide whether this task is simple or complex. For complex '
  + 'tasks: think deeply first — architecture, edge cases, integration points — '
  + 'and end each reasoning block with a decision or the specific information '
  + 'you still need. For simple tasks: act directly.'

export function personaFor(complex) {
  return complex ? COMPLEX_PERSONA : SIMPLE_PERSONA
}

/** First-request core tool surface (platform shell added by the plugin). */
export function coreFor(complex) {
  return complex ? ['read', 'edit', 'glob', 'grep'] : ['read', 'write', 'edit']
}

/** Replace only the persona section of an assembled section list. */
export function applyPersona(sections, text) {
  const rest = (sections ?? []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'cadence-persona', text, order: 0 }]
}

/* ── injection texts (static constants; P2: zero interpolation) ───────────── */

export const GUIDE_SIMPLE =
  '\nCadence：这是一个直接任务。先做一个明确动作；仅当工具结果显示任务比预想大时再升级到深度规划。'

/** Shared env-stuck strategy (V2.5 wording, relaxed in V4.0: no tool-name
 *  enumeration — the point is "verify availability before concluding a
 *  capability is missing", which any tool family can follow). */
export const ENV_STUCK_TEXT =
  '关键依赖被环境限制时（命令失败/工具缺失）：先做完整的可用性验证（完整路径、常见探测命令、包管理器），'
  + '命令失败≠能力缺失；若被卡路线可能更优且另一条路线可推进，可委派一个只读子代理并行验证环境配置'
  + '（只查询，不得安装/修改/删除任何环境组件，如需安装回到主进程执行），主进程继续当前路线，'
  + '返回后再评估是否切换。'

export const GUIDE_COMPLEX =
  '\nCadence：这是一个复杂任务。行动前深入思考——架构、边界、集成点；每段思考以决策或所需信息结尾。'
  + '产出方法对比：你的方案是「由任务输入驱动」（数据/文档/样例/参考/现有代码被真正读入并参与产出），'
  + '还是「闭路自造」（输入只做外围验证，产出靠推导与假设）？若存在把输入转化为产出的更优路线，'
  + '对比其上限与成本后再决定路线。'
  + ENV_STUCK_TEXT

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
 *  (V4.0). ④ requires verification to present the artifact's REAL form
 *  (measured: Mona V4.2 iterated a render→MAE loop at 300×400 while the
 *  artifact is 1200×1600 — the loop converged, the output stayed weak). */
export const STEER_REFLECTION =
  '\nCadence 自省：暂停执行片刻，回答三个问题——'
  + '① 我正在完成的是任务真正要求的目标，还是只是「看起来正确的动作」？'
  + '② 任务要求的输入材料（文档/数据/参考/样例）是否真正进入了我的产出？'
  + '③ 如果现在交付，用户会认为任务完成了吗？'
  + '④ 若产物具有视觉或空间形态，验证是否呈现了它的真实形态——还是只看了数字摘要、'
  + '文本化或字符化表示？'
  + '若有缺口，先补最小缺口再继续，避免推倒重来。'

/** Final requirement check — a delivery audit against the original task.
 *  V4.3+: full-artifact / real-form verification lines (V4.2 lesson). */
export const STEER_FINAL_CHECK =
  '\nCadence 验收：交付前，把任务原文的每条要求逐项对照你的产出——每条是否达成？'
  + '有没有「做了动作但没达成目标」的条目？'
  + '若任务存在参考输入（原图/样例/数据/已有实现），验收时对照参考核验产出，并确认参考'
  + '真正进入了产出（被读取/解析/采样），仅下载或检索不算。'
  + '对照核验必须作用于产物的完整形态——缩略、降采样或局部采样不能代表整体质量。'
  + '验证手段必须呈现产物的真实形态；任何数字、文本或字符摘要都不能替代。'
  + '自评或外部评分不等于交付依据——评价者的标准是否等于任务预期？差距大时应继续迭代'
  + '或向用户确认预期，而不是仅凭一个评分就交付。'
  + '未达成项先补齐，或向用户说明差距。'

/** V4.0 convergence steer: long reasoning blocks get one nudge to converge
 *  (routing-suite P10: deep thinking without a commit binding starves the
 *  budget). Generic: no task words. */
export const STEER_CONVERGE =
  '\nCadence 收敛：最近的推理块明显偏长。先收敛再继续——每段思考以决策或所需信息结尾；'
  + '信息足够就产出或执行下一步动作，不要继续扩大思考。'

/** V4.1 instruction hint (R3, orchestrator pattern): instead of injecting the
 *  full AGENTS.md/CLAUDE.md digest (a large block that perturbs the
 *  trajectory), one short hint is injected ONCE after promotion — the model
 *  reads the instruction files itself when relevant. Static text. */
export const STEER_INSTRUCTION_HINT =
  '\nCadence 指令提示：工作区可能带有指令文件（AGENTS.md / CLAUDE.md），行动前按需读取它们。'

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
 *  never fires (measured: Mona V4.2 V4F). */
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
  return !userIntervened(events)
}

/** Only top-level fresh sessions (no prior user message) get the anchor turn. */
export function isFreshTopLevel(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return false
  return !(agent?.session?.events ?? []).some((event) => event.type === 'user/message')
}

/* ── deadlock ladder (V2 verified ladder; SAFETY) ─────────────────────────── */

export const DL_NONE = 0
export const DL_SUSPECT = 1
export const DL_VERIFIED = 2
export const DL_PAUSE = 3
export const DL_REMIND = 4
export const DL_ESCALATE = 5

export const ANCHOR_TEXT =
  'Cadence 热身：本轮不执行任务、不调用任何工具。请用一两句话确认你已就绪，并简述你接下来会如何处理下一条消息。不要思考、不要规划、不要使用工具。'

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
  return p50 >= (cfg.blockP50Threshold ?? 2500)
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

  // V4.1 instruction hint (R3): once, AFTER promotion — replaces the full
  // AGENTS.md/CLAUDE.md digest (see agent.cordis.yml: no agent-instructions
  // row). Static, idempotent.
  if (cfg.instructionHint && promoted && !fired('Cadence 指令提示')) {
    out.push({ marker: 'Cadence 指令提示', text: STEER_INSTRUCTION_HINT })
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

  // Mid-task reflection (once per session; generic metacognition checkpoint).
  if (cfg.reflectionAdvisor && complex && !fired('Cadence 自省') && reflectionDue(events, cfg)) {
    out.push({ marker: 'Cadence 自省', text: STEER_REFLECTION })
  }

  // Final requirement check (once per session; generic delivery audit).
  if (cfg.finalCheckAdvisor && complex && !fired('Cadence 验收') && finalCheckDue(events, cfg)) {
    out.push({ marker: 'Cadence 验收', text: STEER_FINAL_CHECK })
  }

  // Block-length convergence steer (once per session; V4.0).
  if (cfg.blockLengthSteer && complex && !fired('Cadence 收敛') && blockLengthSteerDue(events, cfg)) {
    out.push({ marker: 'Cadence 收敛', text: STEER_CONVERGE })
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
