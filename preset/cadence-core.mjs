/**
 * cadence-core v2 — thinking-budget pacing logic (zero dependencies).
 *
 * Pure functions only — the bootstrap plugin imports these. v2 changes vs v1:
 *
 *   1. BUDGET AWARENESS (告知化): the model learns its per-step output cap
 *      BEFORE thinking, via band messages ("small/medium/large") injected at
 *      the pre-step waterfall when the band changes, plus a constant neutral
 *      budget section. Truncation is detected from durable events and the
 *      next request's cap is released (recovery).
 *   2. MONOTONIC CLASSIFICATION: the class starts simple; the first real
 *      user message sets it; later complex messages upgrade permanently.
 *      Classification prefers the entering batch (visible at pre-step),
 *      which fixes v1's timing bug where the first request was misclassified.
 *   3. VERIFIED DEADLOCK LADDER: suspicion (L1) → fingerprint-verified
 *      deadlock (L2) → pause-and-ask-user (L3) → bounded reminder (L3b) →
 *      optional escalation (L4, default off). Verification requires repeated
 *      identical arguments OR identical failure fingerprints with NO
 *      write/edit and NO assistant text in the window — progress of any
 *      kind resets the episode.
 *   4. PLAN-FORWARD UTILIZATION: slow progress steers the model to move
 *      planned, independent verification work earlier — never new actions.
 *   5. Platform-aware shell hints and shell-syntax-error detection.
 *   6. Delegation advisor for complex code-fixing sessions.
 *
 * Security invariants (P1–P8): every injection text is a static constant
 * (zero interpolation of user content / tool output / file content); the
 * preset never registers fs/shell/permission tools; strip lists never touch
 * user or policy messages; every injection is idempotent (marker searchable
 * in durable events); L4 is opt-in and plan-mode-safe.
 */

/** Durable events that promote a session out of the bootstrap phase. */
export const PROMOTE_EITHER = ['tool/call', 'assistant/message']

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
  + 'you still need. For simple tasks: act directly. Do not spend reasoning on '
  + 'the environment or tooling.'

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
    (section) => !section.name || !/persona/i.test(section.name),
  )
  return [...rest, { name: 'cadence-persona', text, order: 0 }]
}

/* ── constant sections (cache-stable, zero interpolation) ─────────────────── */

/** Neutral budget section — same text for every request. */
export const BUDGET_SECTION = {
  name: 'cadence-budget',
  order: 1,
  text: 'Cadence 预算：输出预算按任务复杂度自适应（简单任务受限，复杂任务充足）。'
    + '思考前先规划分配：思考用于决策，产出用于交付；每段思考以决策或信息需求结尾。',
}

/* ── platform profiles (V2.2: full platform adaptation) ───────────────────── */

/** Resolve the effective platform: config override wins, else the host. */
export function platformFor(config) {
  if (config?.platform === 'win32' || config?.platform === 'posix') return config.platform
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/** One immutable platform profile: every platform-specific fact the preset
 *  knows — shell, path style, env style, encoding, processes, browsers,
 *  permissions, and shell-error regexes. Pure data; no execution. */
export function platformProfileFor(platform) {
  return platform === 'win32' ? {
    key: 'win32',
    shell: 'pwsh',
    pathSep: '\\',
    envStyle: '$env:NAME',
    caseSensitive: false,
    encodingHint: '输出乱码时用 chcp 65001 或设置 $OutputEncoding；GBK 文本用 Get-Content -Encoding',
    processHints: 'Get-Process / Stop-Process',
    browserHints: 'Edge: C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe；Chrome: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    permissionHints: '文件只读属性用 attrib；无 chmod',
    errorRegexes: [
      /(不是内部或外部命令|无法将.{0,24}识别为 cmdlet|not recognized|is not recognized)/i,
      /(系统找不到指定的路径|系统找不到指定的文件|The system cannot find the path|Cannot find path)/i,
    ],
  } : {
    key: 'posix',
    shell: 'bash',
    pathSep: '/',
    envStyle: '$NAME',
    caseSensitive: true,
    encodingHint: '',
    processHints: 'ps / kill',
    browserHints: 'chromium / google-chrome',
    permissionHints: 'chmod / chown',
    errorRegexes: [
      /(command not found|No such file or directory|Permission denied)/i,
    ],
  }
}

/** Full platform section text from a profile (cache-stable per platform). */
export function platformSectionFor(profile) {
  if (profile.key === 'win32') {
    return {
      name: 'cadence-platform',
      order: 2,
      text: '当前平台为 Windows，shell 是 PowerShell。'
        + `路径分隔符为反斜杠（${profile.pathSep}），环境变量用 ${profile.envStyle}（如 ${profile.envStyle}USERPROFILE），大小写不敏感。`
        + `进程管理用 ${profile.processHints}。`
        + `${profile.encodingHint}。`
        + `浏览器路径：${profile.browserHints}。`
        + `${profile.permissionHints}。避免 ls、cat、&&、export 等 POSIX 语法。`,
    }
  }
  return {
    name: 'cadence-platform',
    order: 2,
    text: '当前 shell 为 bash（非 Windows 平台）。'
      + `路径分隔符为斜杠（${profile.pathSep}），环境变量用 ${profile.envStyle}，大小写敏感。`
      + `进程管理用 ${profile.processHints}；浏览器 ${profile.browserHints}；权限 ${profile.permissionHints}。`,
  }
}

/** Shell-syntax steer text generated from the active profile. */
export function shellSteerFor(profile) {
  return profile.key === 'win32'
    ? '\nCadence shell 检查：检测到 shell 语法错误。当前是 PowerShell——'
      + '用 Get-* / $env:NAME / Out-String，不用 ls / cat / && / export；'
      + `命令输出超限会自动落盘 spill 文件。${profile.encodingHint}。`
    : '\nCadence shell 检查：检测到 shell 语法错误（command not found 等）。请检查命令写法；当前为 bash。'
}

/** Detect shell syntax/path errors in the last tool results, profile-aware. */
export function shellErrorDetect(events, profile) {
  const results = events.filter((e) => e.type === 'tool/result').slice(-3)
  if (results.length < 2) return false
  const hits = results.filter((r) => profile.errorRegexes.some((re) => re.test(
    `${JSON.stringify(r.data?.message ?? '')}${r.data?.error ? JSON.stringify(r.data.error) : ''}`,
  )))
  if (hits.length < 2) return false
  const calls = events.filter((e) => e.type === 'tool/call').slice(-4)
  return calls.some((c) => c.data.name === 'pwsh' || c.data.name === 'bash')
}

/** Delegation discipline — complex sessions only. */
export const DELEGATION_SECTION = {
  name: 'cadence-delegation',
  order: 3,
  text: '委派纪律：委派 subagent 时——(a) 提供最小自包含上下文（函数签名、数据格式、期望行为、已知现象）；'
    + '(b) 一次一个明确任务；(c) 回来后必须验收（读它的输出、必要时跑测试）；'
    + '(d) 视觉/审美类验证不要委派（子代理看不到渲染结果，视觉验证用截图 + read_image）；'
    + '(e) 审查类委派必须在提示词中明确「只读——不得 write/edit/删除文件，发现问题时报告位置与理由」。',
}

/* ── budget bands ─────────────────────────────────────────────────────────── */

export const BAND_SMALL = 'small'
export const BAND_MEDIUM = 'medium'
export const BAND_LARGE = 'large'

/** Band for a (complex, promoted) pair. Complex stays LARGE across phases so
 *  the band message text never changes at promotion (zero header churn). */
export function budgetBandFor(complex, promoted) {
  if (complex) return BAND_LARGE
  return promoted ? BAND_MEDIUM : BAND_SMALL
}

/** Actual maxTokens for a (complex, promoted) pair; null = no cap. */
export function budgetCapFor(complex, promoted, cfg) {
  if (complex) return promoted ? null : cfg.complexBootstrap
  return promoted ? cfg.simpleCap : cfg.simpleBootstrap
}

/** Band messages carry the real cap (except LARGE, which promises room).
 *  The marker word ("Cadence 预算档 X") is searchable for idempotency. */
export function bandMessage(band, cap) {
  switch (band) {
    case BAND_SMALL:
      return `Cadence 预算档 small：本步输出上限 ${cap} token，思考与产出共享。`
        + '先规划分配：思考压缩到约 1/3，其余留给产出；长输出任务分步完成，不要试图一步写完。'
    case BAND_MEDIUM:
      return `Cadence 预算档 medium：本步输出上限 ${cap} token。`
        + '思考用于决策，产出用于交付；思考超过一半预算时强制收敛到行动。'
    default:
      return 'Cadence 预算档 large：本步输出预算充足。可深入思考，但每段思考以决策结尾；产出完整交付物。'
  }
}

/* ── injection texts (static constants; P2: zero interpolation) ───────────── */

export const GUIDE_SIMPLE =
  '\nCadence：这是一个直接任务。先做一个明确动作；仅当工具结果显示任务比预想大时再升级到深度规划。'

export const GUIDE_COMPLEX =
  '\nCadence：这是一个复杂任务。行动前深入思考——架构、边界、集成点；每段思考以决策或所需信息结尾。不要花推理在环境/工具上。'

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

export const STEER_RECOVERY =
  '\nCadence 恢复：上一步思考超出预算被截断，本步预算已放宽。压缩思考，直接产出可运行的结果。'

export const GUIDE_UTILIZATION =
  '\nCadence 利用率：当前项推进缓慢。不要做计划外的事——'
  + '从你已有的计划/todo 中，把【后置的、独立的、验证类】任务前移到当前等待窗口：'
  + '(a) 模块测试/冒烟验证（不依赖当前阻塞项的）；(b) 验收清单、检查点准备；'
  + '(c) 独立子模块实现（接口已冻结的）。只前移不依赖当前阻塞项的任务；'
  + '除计划内文件外不做修改，探索性复查保持只读。'

export const GUIDE_UTILIZATION_READONLY =
  '\nCadence 利用率：当前项推进缓慢。若没有待办计划，则只做只读准备——'
  + '读相关文件核对假设、检查依赖一致性；不新增任何动作。'

export const GUIDE_DELEGATION =
  '\nCadence 委派建议：检测到多轮代码修改。可委派一个 subagent 独立审查最近改动——'
  + '打包「模块接口签名 + 期望行为 + 已知失败现象」，让它检查参数顺序、索引/坐标、边界条件；'
  + '审查提示词中明确「只读：不得 write/edit/删除文件，报告位置与理由」；回来后必须验收。'

/** Targeted delegation variant for sessions touching math/graphics/physics
 *  modules — enhancement, not a gate (generic GUIDE_DELEGATION still fires
 *  for plain edit-heavy sessions). */
export const GUIDE_DELEGATION_RISKY =
  '\nCadence 委派建议：检测到多轮代码修改，且改动涉及数学/图形/物理计算模块。'
  + '可委派一个 subagent 独立审查——打包「模块接口签名 + 期望行为 + 已知失败现象」，'
  + '让它**重点检查数值计算类风险**：公式推导、坐标/索引变换、精度与除零、边界退化；'
  + '审查提示词中明确「只读：不得 write/edit/删除文件，报告位置与理由」；回来后必须验收。'

/** Steering injected when a delegated subagent runs far past its expected time. */
export const STEER_SUBAGENT =
  '\nCadence 子代理超时：委派的子代理已运行过久且未返回。用 list_agents 检查进展；'
  + '若无进展可 interrupt_agent 中断它，自己接手剩余工作（注意其报告可能基于旧代码）。'

/* ── todo sync (V2.3: keep the UI todo list honest) ───────────────────────── */

/** Steering when the todo snapshot lags the real progress. */
export const STEER_TODO_SYNC_STALE =
  '\nCadence todo 同步：任务已明显推进（上次清单更新后已过 N 步工具调用），但待办快照仍停留在早期状态。'
  + '请调用 todo_write 同步：标记已完成项、更新进行中项，保持清单与真实进度一致。'

/** Steering when the todo list says "all done" but new work appeared. */
export const STEER_TODO_SYNC_REOPEN =
  '\nCadence todo 同步：清单已全部标记完成，但检测到新的修改工作。'
  + '请调用 todo_write 重新打开清单，把当前修复/收尾工作记录为新的进行中项。'

/**
 * Todo staleness detection (derived from durable events; pure function).
 * Returns:
 *   0 — in sync (no todo, recently updated, or no progress evidence)
 *   1 — stale: the last todo snapshot predates a long run of work and is
 *       not fully completed (the classic "list stuck on item 1" state)
 *   2 — reopen: the last todo snapshot is fully completed but new
 *       edit/write work happened afterwards (the "all done but still
 *       fixing" state)
 */
export function todoStale(events, cfg) {
  const todoEvents = (events ?? []).filter((e) => e.type === 'todo/write')
  if (todoEvents.length === 0) return 0
  const last = todoEvents.at(-1)
  const after = (events ?? []).filter((e) => e.seq > last.seq)
  const callsAfter = after.filter((e) => e.type === 'tool/call')
  const editsAfter = callsAfter.filter((c) => c.data.name === 'write' || c.data.name === 'edit').length
  const stepThreshold = cfg?.todoSyncAfterSteps ?? 12
  if (callsAfter.length < stepThreshold) return 0
  const todos = last.data?.todos ?? []
  const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed')
  if (allDone) return editsAfter >= 5 ? 2 : 0
  // Not fully done: stale when there is clear progress evidence (≥3 edits or
  // a long run), otherwise wait.
  return editsAfter >= 3 || callsAfter.length >= 20 ? 1 : 0
}

/* ── anchor first turn (V2.2: kill the turn-1 truncation stall) ───────────── */

/** Default anchor text: a low-cognitive-load warm-up that MUST produce a short
 *  text reply (no tools, no deep thinking), which is also the promotion
 *  signal. Static constant; overridable via preset config (trust boundary:
 *  the user's own configuration, never external input). */
export const ANCHOR_TEXT =
  'Cadence 热身：本轮不执行任务、不调用任何工具。请用一两句话确认你已就绪，'
  + '并简述你接下来会如何处理下一条消息。不要思考、不要规划、不要使用工具。'

/** Only top-level fresh sessions (no prior user message) get the anchor turn. */
export function isFreshTopLevel(agent) {
  if (agent?.session?.header?.delegationDepth ?? 0 > 0) return false
  return !(agent?.session?.events ?? []).some((event) => event.type === 'user/message')
}

/** Whether a delegated subagent started but never settled past the timeout.
 *  Signals come from durable events: the subagent tool/call start time vs the
 *  settlement NOTICE — which arrives as a `user/message` whose
 *  `source.kind === 'subagent-settled'` (NOT a standalone event type; the
 *  v2.2 implementation wrongly matched `e.type === 'subagent-settled'`, so a
 *  finished subagent was still reported as overdue). Pure function; `nowMs`
 *  from the caller. */
export function subagentOverdue(events, nowMs, timeoutMs) {
  if (!Array.isArray(events) || timeoutMs <= 0) return false
  let startedAt = null
  let settled = false
  for (const e of events) {
    if (e.type === 'tool/call' && e.data?.name === 'subagent') {
      if (typeof e.time === 'number') startedAt = e.time
    }
    if (e.type === 'user/message' && e.data?.source?.kind === 'subagent-settled') {
      settled = true
    }
  }
  if (startedAt === null || settled) return false
  return nowMs - startedAt > timeoutMs
}

/* ── block helpers ────────────────────────────────────────────────────────── */

function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : []
}

export function hasTextBlock(message) {
  return blocksOf(message).some((b) => b.type === 'text' && b.text?.length > 0)
}

export function hasToolCallBlock(message) {
  return blocksOf(message).some((b) => b.type === 'tool-call')
}

export function isPureThinking(message) {
  return !hasTextBlock(message) && !hasToolCallBlock(message)
}

/* ── truncation detection ─────────────────────────────────────────────────── */

/** True when a message consumed exactly one of our caps with no visible
 *  output — the model thought until the budget ran out. */
export function isTruncatedMessage(event, caps) {
  if (event?.type !== 'assistant/message') return false
  const d = event.data ?? {}
  if (!isPureThinking(d.message)) return false
  const out = d.usage?.outputTokens
  return typeof out === 'number' && caps.includes(out)
}

export function detectTruncation(events, cfg) {
  const caps = [cfg.simpleBootstrap, cfg.simpleCap, cfg.complexBootstrap]
  const msgs = events.filter((e) => e.type === 'assistant/message')
  return msgs.length > 0 && isTruncatedMessage(msgs.at(-1), caps)
}

/* ── tool sequence helpers ────────────────────────────────────────────────── */

export function toolSequence(events, n) {
  return events
    .filter((e) => e.type === 'tool/call')
    .slice(-n)
    .map((e) => ({ name: e.data.name, args: String(e.data.arguments ?? '') }))
}

/** Count of trailing tool calls identical in name AND raw arguments. */
export function trailingRepeats(events) {
  const seq = toolSequence(events, 12)
  if (seq.length === 0) return 0
  const last = seq.at(-1)
  let n = 1
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i].name === last.name && seq[i].args === last.args) n++
    else break
  }
  return n
}

/** Extract the shell `command` property from pwsh/bash arguments, if any. */
function commandOf(event) {
  const args = event?.data?.arguments
  if (typeof args !== 'string') return null
  try {
    const parsed = JSON.parse(args)
    if (typeof parsed?.command === 'string' && parsed.command.length > 0) return parsed.command
  } catch { /* raw JSON */ }
  return null
}

/**
 * Count of occurrences of the most recent shell command (pwsh/bash with a
 * `command` property) among the last `window` tool calls. Window-based on
 * purpose: grinding loops interleave supporting writes (e.g. rewriting a
 * debug script between debug runs), so a strict "consecutive" counter misses
 * them, while a window of 8 with a threshold of 3 keeps benign double-checks
 * (2 occurrences) out.
 */
export function trailingCommandRepeats(events, window = 8) {
  const calls = events.filter((e) => e.type === 'tool/call').slice(-window)
  if (calls.length === 0) return 0
  const last = calls.at(-1)
  if (last.data.name !== 'pwsh' && last.data.name !== 'bash') return 0
  const cmd = commandOf(last)
  if (cmd === null) return 0
  let n = 0
  for (const c of calls) {
    if (c.data.name === 'pwsh' || c.data.name === 'bash') {
      if (commandOf(c) === cmd) n++
    }
  }
  return n
}

/** Normalized fingerprint of a tool/result (content + error identity). */
export function fingerprintResult(event) {
  const d = event?.data ?? {}
  const msg = d.message ?? {}
  const content = Array.isArray(msg.content)
    ? JSON.stringify(msg.content)
    : String(msg.content ?? '')
  const err = d.error ? `${d.error.name}:${d.error.code}` : ''
  const norm = `${content}|${err}`.replace(/\s+/g, ' ').slice(0, 500)
  let h = 0
  for (let i = 0; i < norm.length; i++) h = ((h << 5) - h + norm.charCodeAt(i)) | 0
  return String(h)
}

/** Length of the trailing run of identical FAILURE results, provided no
 *  write/edit and no assistant TEXT happened inside the window (any visible
 *  progress invalidates the run). */
export function identicalFailureRun(events, min) {
  const results = events.filter((e) => e.type === 'tool/result')
  if (results.length === 0) return 0
  const last = results.at(-1)
  if (last.data?.error === undefined) return 0
  const fp = fingerprintResult(last)
  let n = 1
  let earliest = last.seq
  for (let i = results.length - 2; i >= 0; i--) {
    const r = results[i]
    if (r.data?.error !== undefined && fingerprintResult(r) === fp) {
      n++
      earliest = r.seq
    } else break
  }
  if (n < min) return 0
  const progressed = events.some((e) => e.seq > earliest && (
    (e.type === 'tool/call' && (e.data.name === 'write' || e.data.name === 'edit'))
    || (e.type === 'assistant/message' && hasTextBlock(e.data?.message))
  ))
  return progressed ? 0 : n
}

/* ── deadlock ladder ──────────────────────────────────────────────────────── */

export const DL_NONE = 0
export const DL_SUSPECT = 1
export const DL_VERIFIED = 2
export const DL_PAUSE = 3
export const DL_REMIND = 31
export const DL_ESCALATE = 4

/**
 * Level for the current step, derived entirely from durable events.
 * Markers are plugin user/message texts; idempotency is marker presence.
 * Progress (write/edit or assistant text) resets the episode.
 */
export function detectDeadlock(events, cfg) {
  const markerSeq = (text) => {
    let found = -1
    for (const e of events) {
      if (e.type !== 'user/message') continue
      if (extractText(e.data).includes(text)) found = e.seq
    }
    return found
  }
  const l1 = markerSeq('进度停滞')
  const l2 = markerSeq('已核验卡死')
  const l3 = markerSeq('暂停指令')
  const l3b = markerSeq('Cadence 提醒')
  const episode = Math.max(l1, l2, l3, l3b, -1)
  const stepsAfter = (seq) => events.filter((e) => e.type === 'step/start' && e.seq > seq).length
  const repeats = trailingRepeats(events)
  // Command-level repetition (same shell command, different description) is
  // weaker evidence: it enters at L1 with a higher threshold, never hard.
  const cmdRepeats = trailingCommandRepeats(events)
  const failRun = identicalFailureRun(events, cfg.maxIdenticalFailures)
  const hard = repeats >= cfg.maxRepeats || failRun >= cfg.maxIdenticalFailures

  if (episode === -1) {
    if (hard) return DL_VERIFIED
    if (repeats >= 2 || cmdRepeats >= 3 || failRun >= 2) return DL_SUSPECT
    return DL_NONE
  }
  // A marker exists: progress since it resets the episode.
  const progressed = events.some((e) => e.seq > episode && (
    (e.type === 'tool/call' && (e.data.name === 'write' || e.data.name === 'edit'))
    || (e.type === 'assistant/message' && hasTextBlock(e.data?.message))
  ))
  if (progressed || !hard || stepsAfter(episode) < cfg.graceStepsAfterSteer) return DL_NONE
  if (l3b !== -1) return cfg.escalateAfterIgnore ? DL_ESCALATE : DL_NONE
  if (l3 !== -1) return DL_REMIND
  if (l2 !== -1) return DL_PAUSE
  if (l1 !== -1) return DL_VERIFIED
  return DL_NONE
}

/* ── utilization, shell, delegation ───────────────────────────────────────── */

/** Slow-progress signal for the utilization advisor (A1–A4). */
export function detectUtilization(events) {
  const calls = events.filter((e) => e.type === 'tool/call').slice(-4)
  const results = events.filter((e) => e.type === 'tool/result').slice(-4)
  const wrote = calls.some((c) => c.data.name === 'write' || c.data.name === 'edit')
  if (calls.filter((c) => c.data.name === 'job_output').length >= 2 && !wrote) return 'A1'
  if (results.filter((r) => r.data?.error !== undefined).length >= 2 && !wrote) return 'A3'
  if (calls.length >= 2) {
    const a = calls.at(-2)
    const b = calls.at(-1)
    if (a.data.name === b.data.name && String(a.data.arguments) === String(b.data.arguments)) return 'A2'
  }
  const msgs = events.filter((e) => e.type === 'assistant/message').slice(-2)
  if (msgs.length >= 2 && !wrote && msgs.every((m) => isPureThinking(m.data?.message))) return 'A4'
  return null
}

/** High-risk-module file fingerprints. V2.3.1 de-specialization: this is an
 *  ENHANCEMENT selector, not a gate — plain edit-heavy sessions still get the
 *  generic delegation suggestion (see delegationWarranted below); sessions
 *  touching math/graphics/physics modules get a targeted variant that names
 *  the risky logic. (Origin: both black-hole sessions adopted the advice when
 *  "shader math is most error-prone" — kept as an enhancement, not a filter.) */
const RISKY_MODULE_RE = /(shader|glsl|kernel|math|geometry|physics|ray|integrat|matrix|quaternion|noise|算法|计算|数学)/i

/** Whether any recent edit touches a high-risk module (enhancement selector). */
export function riskyModuleHit(events) {
  const calls = events.filter((e) => e.type === 'tool/call').slice(-5)
  return calls.some((c) => {
    if (c.data.name !== 'write' && c.data.name !== 'edit') return false
    try {
      const args = JSON.parse(c.data.arguments ?? '{}')
      return RISKY_MODULE_RE.test(args.file_path ?? '')
    } catch {
      return false
    }
  })
}

/** Delegation is warranted for complex sessions with ≥8 steps and ≥3
 *  write/edit calls among the last 5 — a multi-round code-fixing session.
 *  GENERIC by design (V2.3.1 de-specialization): plain CRUD sessions still
 *  warrant an independent review; riskyModuleHit() only selects the
 *  targeted message variant, never blocks the generic suggestion. */
export function delegationWarranted(events) {
  const steps = events.filter((e) => e.type === 'step/start').length
  if (steps < 8) return false
  const calls = events.filter((e) => e.type === 'tool/call').slice(-5)
  return calls.filter((c) => c.data.name === 'write' || c.data.name === 'edit').length >= 3
}

/** Vision depth deepening (V2.3, gentle variant): fires ONLY after the model
 *  has already used vision on its own — it never pushes vision usage, it only
 *  upgrades the depth of verification the model already performs. Generic
 *  wording (V2.3.1 de-specialization): multi-scale verification applies to any
 *  visual check, not just 3D rendering. */
export const STEER_VISUAL_DEPTH =
  '\nCadence 视觉深化：你已在用截图+vision 验证，很好。建议验证分两层：(a) 功能存在性（是否有预期内容、是否空白/异常）；'
  + '(b) 质量性（清晰度/一致性/对比与层次/布局是否协调）。'
  + '并做多尺度：整体视图 + 局部放大（关键区域）各验一轮，避免整体视图漏掉小尺度缺陷。'

export function visionInUse(events) {
  return (events ?? []).some((e) => e.type === 'tool/call' && e.data?.name === 'vision')
}

/* ── injection assembly (idempotent, derived) ─────────────────────────────── */

/**
 * Compute everything this step should inject, in priority order.
 * Every entry is { marker, text }; marker === null entries (per-message
 * guides) are idempotent by message id instead.
 */
export function pendingInjections({ events, batchMessages, cls, promoted, cfg, profile, nowMs }) {
  const fired = (text) => events.some(
    (e) => e.type === 'user/message' && extractText(e.data).includes(text),
  )
  const complex = cls === 'complex'
  const out = []

  // Per-message guides: only for real user messages not yet entered.
  for (const m of batchMessages ?? []) {
    if (m?.source?.kind !== 'user') continue
    if (events.some((e) => e.type === 'user/message' && e.data?.id === m.id)) continue
    const text = extractText(m)
    if (!text.trim()) continue
    out.push({ marker: null, text: isComplexTask(text) ? GUIDE_COMPLEX : GUIDE_SIMPLE })
  }

  // Budget band (fires once per band).
  const band = budgetBandFor(complex, promoted)
  const bandMarker = `Cadence 预算档 ${band}`
  if (!fired(bandMarker)) {
    out.push({ marker: bandMarker, text: bandMessage(band, budgetCapFor(complex, promoted, cfg)) })
  }

  // Truncation recovery (once per episode).
  if (detectTruncation(events, cfg) && !fired('Cadence 恢复')) {
    out.push({ marker: 'Cadence 恢复', text: STEER_RECOVERY })
  }

  // Utilization (once per session).
  if (cfg.utilizationAdvisor && !fired('Cadence 利用率') && detectUtilization(events) !== null) {
    const todos = events.filter((e) => e.type === 'todo/write').at(-1)?.data?.todos ?? []
    const hasPlan = todos.some((t) => t.status !== 'completed')
    out.push({
      marker: 'Cadence 利用率',
      text: hasPlan ? GUIDE_UTILIZATION : GUIDE_UTILIZATION_READONLY,
    })
  }

  // Deadlock ladder (each level once per episode; markers gate idempotency).
  if (cfg.deadlockDetector) {
    const dl = detectDeadlock(events, cfg)
    if (dl === DL_SUSPECT && !fired('进度停滞')) out.push({ marker: 'Cadence 进度停滞', text: STEER_STALL })
    if (dl === DL_VERIFIED && !fired('已核验卡死')) out.push({ marker: 'Cadence 已核验卡死', text: STEER_DEADLOCK })
    if (dl === DL_PAUSE && !fired('暂停指令')) out.push({ marker: 'Cadence 暂停指令', text: STEER_PAUSE })
    if (dl === DL_REMIND && !fired('Cadence 提醒')) out.push({ marker: 'Cadence 提醒', text: STEER_PAUSE_REMINDER })
  }

  // Shell syntax errors (once per session; profile-aware).
  if (cfg.platformHints && profile !== undefined && !fired('Cadence shell 检查') && shellErrorDetect(events, profile)) {
    out.push({ marker: 'Cadence shell 检查', text: shellSteerFor(profile) })
  }

  // Delegation advisor (once per session, complex only; generic by default,
  // with a targeted variant when recent edits touch math/graphics/physics).
  if (cfg.delegationAdvisor && complex && !fired('Cadence 委派建议') && delegationWarranted(events)) {
    out.push({
      marker: 'Cadence 委派建议',
      text: riskyModuleHit(events) ? GUIDE_DELEGATION_RISKY : GUIDE_DELEGATION,
    })
  }

  // Subagent timeout (once per session; C2 security enhancement).
  if (cfg.subagentTimeoutMin > 0 && !fired('Cadence 子代理超时')
    && subagentOverdue(events, nowMs ?? Date.now(), cfg.subagentTimeoutMin * 60000)) {
    out.push({ marker: 'Cadence 子代理超时', text: STEER_SUBAGENT })
  }

  // Todo sync (once per session; V2.3 — keeps the UI todo list honest when
  // long parallel work (delegation, phase shifts) stalls the model's own
  // todo_write cadence).
  if (cfg.todoSyncAdvisor && !fired('Cadence todo 同步')) {
    const stale = todoStale(events, cfg)
    if (stale === 1) out.push({ marker: 'Cadence todo 同步', text: STEER_TODO_SYNC_STALE })
    else if (stale === 2) out.push({ marker: 'Cadence todo 同步', text: STEER_TODO_SYNC_REOPEN })
  }

  // Visual depth deepening (once per session; only after the model already
  // uses vision on its own — never pushes vision usage).
  if (cfg.visualDepthAdvisor && !fired('Cadence 视觉深化') && visionInUse(events)) {
    out.push({ marker: 'Cadence 视觉深化', text: STEER_VISUAL_DEPTH })
  }

  return out
}

/* ── trace helpers ────────────────────────────────────────────────────────── */

export function countMarkers(events, text) {
  return events.filter(
    (e) => e.type === 'user/message' && extractText(e.data).includes(text),
  ).length
}

export function countTruncated(events, caps) {
  return events.filter((e) => isTruncatedMessage(e, caps)).length
}

/** Trajectory-style indicators (V2.3 diagnostics; see the we/let me analysis).
 *  Counts English planning/action markers per 10k reasoning chars, plus the
 *  share of "let me" contexts that are verification-flavoured (recall/check/
 *  verify/read — healthy) rather than trial-flavoured (try/guess/random). */
export function trajectoryIndicators(events) {
  const cnRe = /[\u4e00-\u9fff]/g
  let chars = 0
  let we = 0
  let letMe = 0
  let lets = 0
  let ill = 0
  let verify = 0
  let trial = 0
  let cnRatio = 0
  for (const e of events ?? []) {
    if (e.type !== 'assistant/message') continue
    const blocks = (e.data?.message?.content ?? []).filter((b) => b.type === 'reasoning')
    for (const b of blocks) {
      const t = b.text ?? ''
      chars += t.length
      cnRatio += (t.match(cnRe) || []).length
      we += (t.match(/\bwe\b/gi) || []).length
      const lms = t.match(/\blet me\b[^.\n]{0,40}/gi) || []
      letMe += lms.length
      verify += lms.filter((m) => /recall|check|verify|read|review|confirm|ensure|look at/i.test(m)).length
      trial += lms.filter((m) => /try|guess|random|experiment/i.test(m)).length
      lets += (t.match(/\blet'?s\b/gi) || []).length
      ill += (t.match(/\bi'?ll\b/gi) || []).length
    }
  }
  const per10k = (n) => (chars > 0 ? +(n / chars * 10000).toFixed(1) : 0)
  return {
    reasoningChars: chars,
    cnRatioPct: chars > 0 ? Math.round(cnRatio / chars * 100) : 0,
    wePer10k: per10k(we),
    letMePer10k: per10k(letMe),
    letsPer10k: per10k(lets),
    illPer10k: per10k(ill),
    letMeVerifyShare: letMe > 0 ? Math.round(verify / letMe * 100) : 0,
    letMeTrialShare: letMe > 0 ? Math.round(trial / letMe * 100) : 0,
  }
}

/** Parse a cap token for `trace_tune`: 'full' | 'auto' | positive integer. */
export function parseCap(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === 'full') return 'full'
  if (t === 'auto' || t === 'off') return 'auto'
  const n = Number(t)
  if (Number.isSafeInteger(n) && n > 0) return n
  return null
}
