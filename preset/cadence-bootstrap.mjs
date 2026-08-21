/**
 * cadence-bootstrap v4.4 —LEAN wiring + resident-catalog tool-surface
 * management (orchestrator-inspired, see ref-orchestrator).
 *
 * V4.4: todo_write joins RESIDENT (task-list carrier —Mona 12/14 used it,
 * V4.1—4.3 had 0 uses with unplanned iteration); verification texts demand
 * the artifact's REAL form (F7 —Mona V4.3 verified via crops/ASCII for 80+
 * steps, rendered a PNG only at the end). A windowed block-length trigger
 * was calibrated and REJECTED (whole-session p50 fires early enough; a
 * 10-block window mis-triggers the good V4.1 session).
 * V4.3: frequent tier + request_tool REMOVED (zero calls measured —a tool
 * not on the surface is never used), vision joins RESIDENT, finalCheckDue
 * counts the in-flight step (F4).
 * V4.2 (F1): pre-classify at agent/inbox/inserted —the FIRST task request
 * carries the complex persona + complex core (was: simple while the guide
 * said complex); pre-step assignment is monotonic (the warm-up batch has no
 * user message and must not downgrade F1).
 * V4.1: R1 resident catalog + unlock-on-use (subagents keep the full
 * catalog); R2 compaction epoch (surface falls back to resident until new
 * progress); R3 bootstrap context strip + one-time instruction hint; R4
 * process-self guard on tools/pre-execute (native deny).
 *
 * Security invariants (P1—8): all injection texts are static constants
 * (zero interpolation); no fs/shell/permission tools registered
 * (trace_status/tool_search are read-only); injections idempotent via
 * durable markers; failures degrade to "keep everything" / "no injection".
 * The resident filter is CONDITIONING, not a security boundary —the
 * sandbox/approval stack is the enforcement layer (hiding 鈮?denying).
 */

import {
  ANCHOR_TEXT,
  DL_ESCALATE,
  applyPersona, blockMedian, countMarkers,
  detectDeadlock, effectiveClass,
  extractText, isComplexTask, isFreshTopLevel, pendingInjections, personaFor,
  postCompaction, selfKillDetect,
  selfKillVetoMessage, sessionClass,
  userAskedRestart,
} from './cadence-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cadence-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

function seqToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** V4.4 default resident set: core work tools + vision (a general capability
 *  tool —V4.1/V4.2 Mona sessions repeatedly wanted it but never had it on
 *  the surface; the unlock-on-first-use loop made it unreachable in fresh
 *  sessions) + todo_write (explicit task-list carrier —Mona 12/14 used it
 *  during planned work; V4.1—4.3 sessions had 0 uses with unplanned
 *  wandering iteration) + SAFETY VALVES (never filtered out —the L3
 *  pause-and-ask, the subagent-timeout instructions and delegation must stay
 *  reachable in every phase) + preset tools. */
const DEFAULT_RESIDENT = [
  'read', 'write', 'edit', 'glob', 'grep',
  'pwsh', 'bash',
  'vision', 'todo_write',
  'subagent', 'subagent_fork', 'ask_user_question',
  'list_agents', 'interrupt_agent', 'send_message',
  'trace_status', 'cadence_reload',
  // V4.10 (session-29 review): goal tools were REGISTERED but never on the
  // surface — with tool_search removed they were structurally unreachable
  // (goal usage was 0 by construction, not by model preference). web_search
  // feeds the input-driven method the complex guide teaches; job_*/read_*/
  // describe_image support parallel verification and visual tasks.
  'create_goal', 'get_goal', 'update_goal',
  'web_search',
  'job_output', 'job_list', 'job_kill',
  'read_image', 'describe_image',
]

/** V4.10 (safety, session-28 review) — delegated agents' working surface:
 *  file/command/vision/task/verification tools only. Control-plane tools
 *  (ssh_*, dev_* injectors, agent messaging, ask_user_question, heavy
 *  orchestration like ralph/workflow) stay with the top-level agent, so a
 *  prompt-injected subagent cannot reach remote hosts, plugin mutation or
 *  the user directly. */
const SUBAGENT_SURFACE = new Set([
  'read', 'write', 'edit', 'glob', 'grep',
  'pwsh', 'bash',
  'vision', 'read_image', 'describe_image',
  'todo_write', 'job_output', 'job_list', 'job_kill',
  'web_search', 'trace_status',
])

export function apply(ctx, config) {
  const cfg = {
    reflectionAdvisor: config.reflectionAdvisor !== false,
    reflectionAfterSteps: Number.isSafeInteger(config.reflectionAfterSteps) && config.reflectionAfterSteps > 0
      ? config.reflectionAfterSteps : 12,
    finalCheckAdvisor: config.finalCheckAdvisor !== false,
    finalCheckAfterSteps: Number.isSafeInteger(config.finalCheckAfterSteps) && config.finalCheckAfterSteps > 0
      ? config.finalCheckAfterSteps : 8,
    deadlockDetector: config.deadlockDetector !== false,
    escalateAfterIgnore: config.escalateAfterIgnore === true,
    maxRepeats: Number.isSafeInteger(config.maxRepeats) && config.maxRepeats > 0 ? config.maxRepeats : 4,
    maxIdenticalFailures: Number.isSafeInteger(config.maxIdenticalFailures) && config.maxIdenticalFailures > 0
      ? config.maxIdenticalFailures : 3,
    graceStepsAfterSteer: Number.isSafeInteger(config.graceStepsAfterSteer) && config.graceStepsAfterSteer >= 0
      ? config.graceStepsAfterSteer : 2,
    processSelfGuard: config.processSelfGuard !== false,
    subagentTimeoutMin: Number.isSafeInteger(config.subagentTimeoutMin) && config.subagentTimeoutMin > 0
      ? config.subagentTimeoutMin : 15,
    blockLengthSteer: config.blockLengthSteer !== false,
    blockP50Threshold: typeof config.blockP50Threshold === 'number' && config.blockP50Threshold > 0
      ? config.blockP50Threshold : 4000,
    blockLengthAfterSteps: Number.isSafeInteger(config.blockLengthAfterSteps) && config.blockLengthAfterSteps > 0
      ? config.blockLengthAfterSteps : 10,
    // V4.10 (B2) — block-depth steer (once per session): the running median
    // BELOW the floor gets one "deepen" nudge; pairs with the converge steer
    // into a [blockP50Floor, blockP50Threshold) healthy band.
    blockDepthSteer: config.blockDepthSteer !== false,
    blockP50Floor: typeof config.blockP50Floor === 'number' && config.blockP50Floor > 0
      ? config.blockP50Floor : 1000,
    blockShortnessAfterSteps: Number.isSafeInteger(config.blockShortnessAfterSteps) && config.blockShortnessAfterSteps > 0
      ? config.blockShortnessAfterSteps : 10,
    // V4.1 R1 —resident catalog (conditioning, NOT a security boundary).
    residentTools: Array.isArray(config.residentTools) && config.residentTools.length > 0
      ? [...new Set(config.residentTools)]
      : DEFAULT_RESIDENT,
    // V4.12 (2026-08-21): context strip REMOVED — model upgrade handles the
    // AGENTS.md digest + skill catalog natively; they are injected directly
    // from the first request (the one-time instruction hint was removed with
    // it). suppressedContextSources stays configurable for future needs.
    suppressedSources: Array.isArray(config.suppressedContextSources)
      ? new Set(config.suppressedContextSources.filter((s) => typeof s === 'string' && s.length > 0))
      : new Set(),
    // V4.8 (O1): first REAL request output cap —splits the planning monolith
    // (session-24: 92k reasoning tokens in ONE request, 24.5 min, cache 0%).
    // V4.14 (user decision): value stays 32000 (the V4.8-V4.11 calibrated
    // fuse under which sessions 26/28/29 never truncated; the V4.12-13
    // 64000/24000 experiments are reverted). With the anchor turn restored,
    // this cap applies to the first TASK request (the warm-up request is
    // capped by anchorCapMaxTokens instead). Subagents are exempt (V4.10).
    firstRequestMaxTokens: Number.isSafeInteger(config.firstRequestMaxTokens) && config.firstRequestMaxTokens > 0
      ? config.firstRequestMaxTokens : 32000,
    // V4.8 (O2-A): execution-phase narration steer (once, complex).
    narrationAdvisor: config.narrationAdvisor !== false,
    // V4.14 (2026-08-22, user decision): warm-up anchor turn RESTORED (V2.2
    // mechanism). A fresh top-level session's FIRST request runs with zero
    // tools, the SIMPLE persona and a tiny 2048 cap — the second request
    // then acts immediately instead of burning the whole fuse drafting code
    // inside reasoning (30号/dcc6d859/21bd3d46 all truncated exactly so).
    anchorFirstTurn: config.anchorFirstTurn !== false,
    anchorText: typeof config.anchorText === 'string' && config.anchorText.length > 0
      ? config.anchorText
      : ANCHOR_TEXT,
    anchorCapMaxTokens: Number.isSafeInteger(config.anchorCapMaxTokens) && config.anchorCapMaxTokens > 0
      ? config.anchorCapMaxTokens : 2048,
  }
  const residentSet = new Set(cfg.residentTools)

  /** Session id -> live Agent handle (in-process only, for trace tools). */
  const agents = new Map()
  /** Session id -> most recently assembled Agent (C3: initiator cross-talk guard). */
  const recentAgents = new Map()
  /** Session id -> full assembled tool catalog (name + description), for tool_search. */
  const catalogs = new Map()
  /** Session id -> live state (plan-mode flag, memoized class). */
  const states = new Map()
  /** Session id -> event seq at which the process-self guard first vetoed a
   *  self-kill command. The veto stays armed until a REAL user message lands
   *  after that seq (the user confirmed) —or the user's own message already
   *  asked for the restart/kill. */
  const killVetoed = new Map()

  const stateOf = (session) => {
    let st = states.get(session.id)
    if (st === undefined) {
      st = { complex: false, planMode: false, preClass: false, anchorInjected: false, anchorZeroTools: false, anchorCap: false }
      states.set(session.id, st)
    }
    return st
  }

  // ── F1 pre-classification + V4.14 anchor turn (one listener) ──────────────
  // F1 (V4.2): the inbox insert lands BEFORE the task request is assembled,
  // so the FIRST task request carries the complex persona + complex core.
  // Monotonic; plugin/runtime messages never classify.
  // Anchor (V2.2/V4.14): a FRESH top-level session's first user message gets
  // a warm-up notice prepended into the next-turn inbox — the warm-up turn
  // runs with zero tools + SIMPLE persona + 2048 cap; the task request that
  // follows acts immediately. Anchor flags are consumed independently by
  // assemble (zeroTools) and request (cap) — do NOT infer from events.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== undefined && agent.session !== undefined
      && message?.source?.kind === 'user') {
      const text = extractText(message)
      if (text.trim() && isComplexTask(text)) {
        stateOf(agent.session).complex = true
        stateOf(agent.session).preClass = true
      }
    }
    if (!cfg.anchorFirstTurn) return
    if (agent === undefined || agent.session === undefined) return
    if (message?.source?.kind === 'plugin') return // never re-anchor on plugin messages
    if (!isFreshTopLevel(agent)) return
    const st = stateOf(agent.session)
    if (st.anchorInjected) return // process-local idempotency for rapid inserts
    st.anchorInjected = true
    try {
      agent.inbox.prepend('next-turn', {
        id: `cadence-anchor-${seqToken()}`,
        role: 'user',
        content: [{ type: 'text', text: cfg.anchorText }],
        source: { kind: 'plugin', plugin: 'cadence-bootstrap', form: 'notice', summary: 'cadence anchor turn' },
      })
      st.anchorZeroTools = true
      st.anchorCap = true
    } catch {
      // Races: skip; the real message proceeds unanchored rather than blocked.
      st.anchorInjected = false
    }
  })

  // ── prompt assembly: persona + tool-surface phases ─────────────────────────
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)
    recentAgents.set(session.id, agent) // C3: remember the most recent active session
    catalogs.set(session.id, assembled.tools.map((t) => ({ name: t.name, description: t.description ?? '' })))
    const st = stateOf(session)
    // Plan mode is a live system-prompt state; remembered for the L4 gate.
    st.planMode = (assembled.sections ?? []).some(
      (s) => (s.text ?? '').includes('You are in plan mode'),
    )
    // Complex class: F1 pre-classified state, or durable events (monotonic).
    const complex = st.complex || sessionClass(session.events) === 'complex'
    st.complex = complex
    const sections = applyPersona(assembled.sections, personaFor(complex))
    const keep = (set) => assembled.tools.filter((tool) => set.has(tool.name))

    // Subagents (V4.10, safety — session-28 review): delegated agents get the
    // NARROWED working surface, not the full catalog. A subagent is an
    // extension hand of the parent; control-plane tools (ssh_*, dev_*
    // injectors, agent messaging, ask_user_question, heavy orchestration)
    // stay with the top-level agent. This bounds a prompt-injection's blast
    // radius in a subagent to the file/command layer, where the sandbox and
    // processSelfGuard backstop.
    if ((agent.session?.header?.delegationDepth ?? 0) > 0) {
      return { ...assembled, sections, tools: assembled.tools.filter((t) => SUBAGENT_SURFACE.has(t.name)) }
    }
    // V4.14: warm-up anchor turn — zero tools + SIMPLE persona (the
    // "act directly" warm-up contract; F1's complex state must NOT pull the
    // warm-up into planning). Consumed once; the next assemble returns the
    // resident surface.
    if (st.anchorInjected && st.anchorZeroTools) {
      st.anchorZeroTools = false
      return { ...assembled, sections: applyPersona(assembled.sections, personaFor(false)), tools: [] }
    }
    // V4.12 (kept): no narrow first-task surface, no promotion phases — the
    // RESIDENT catalog is the surface from the first TASK request (simple
    // and complex alike). postCompaction (R2) also converges to the same
    // surface, so the branch is gone too.
    return { ...assembled, sections, tools: keep(residentSet) }
  })

  // ── request listener: warm-up anchor cap (2048) then first-task cap (32k)
  // V4.14: the anchor turn's request is capped by anchorCapMaxTokens; the
  // NEXT request (the first task request) gets firstRequestMaxTokens.
  // Non-warm-up requests that would inherit the tiny cap are released (a
  // request that caps at 2048 without an anchor flag is the warm-up's
  // persisted header leaking into the task request — drop it).
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    if (agent === undefined) return resolved
    const session = agent.session
    const st = stateOf(session)
    if (st.anchorInjected && st.anchorCap) {
      st.anchorCap = false
      return { ...resolved, maxTokens: cfg.anchorCapMaxTokens }
    }
    if (resolved.maxTokens === cfg.anchorCapMaxTokens) {
      const { maxTokens: _drop, ...rest } = resolved
      return rest
    }
    if (!st.firstCapped && (agent.session.header?.delegationDepth ?? 0) === 0) {
      st.firstCapped = true
      return { ...resolved, maxTokens: cfg.firstRequestMaxTokens }
    }
    return resolved
  }, { prepend: true })

  // ── pre-step: strip (bootstrap) + inject (all advisors) ────────────────────
  // NOTE: the `agent/pre-step` waterfall payload does NOT carry an `agent`
  // field —resolve via the initiator scope, falling back to the
  // assemble-cached handle.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const initiator = ctx.get('agent')
      let agent = payload.agent
      if (agent === undefined && initiator !== undefined) {
        const recent = initiator.session !== undefined
          ? recentAgents.get(initiator.session.id)
          : undefined
        agent = recent ?? initiator
      }
      if (agent === undefined) agent = [...agents.values()].at(-1)
      if (agent === undefined) return decision
      let messages = Array.isArray(decision.messages) ? decision.messages : []

      // V4.12: context strip REMOVED — agent-instructions/skill-catalog flow
      // through from the first request (the one-time hint was removed too).
      // suppressedSources stays configurable; the filter below is a no-op
      // while the set is empty.

      // L4 gate: verified deadlock persisted past the reminder. Cancel the
      // turn WITHOUT a directive —the user decides afterwards. Plan mode
      // disables L4; keepInbox preserves pending work.
      const st = stateOf(agent.session)
      if (cfg.escalateAfterIgnore && !st.planMode) {
        if (detectDeadlock(agent.session.events, cfg) === DL_ESCALATE) {
          try {
            agent.cancel(
              { kind: 'hook', reason: 'cadence: verified deadlock persisted after reminders' },
              { keepInbox: true },
            )
          } catch { /* cancel is best-effort at the boundary */ }
          return messages === decision.messages ? decision : { ...decision, messages }
        }
      }

      // Compute injections from durable events + the entering batch.
      const cls = effectiveClass(messages, agent.session.events)
      // Monotonic: the pre-step class may ADD complexity but never DOWNGRADE
      // it (the warm-up batch has no user message 鈫?simple —measured: the
      // V4.2 probe showed it erasing the F1 pre-classification).
      st.complex = st.complex || cls === 'complex'
      const injections = pendingInjections({
        events: agent.session.events,
        batchMessages: messages,
        cls,
        promoted: true, // V4.12: no promotion phases — always the resident surface
        cfg,
        nowMs: Date.now(),
      })
      if (injections.length === 0) {
        return messages === decision.messages ? decision : { ...decision, messages }
      }
      const added = injections.map((inj) => ({
        id: `cadence-${seqToken()}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'cadence-bootstrap' },
        content: [{ type: 'text', text: inj.text }],
      }))
      return { ...decision, messages: [...messages, ...added] }
    } catch {
      // A filter bug must never eat context: degrade to the original decision.
      return decision
    }
  }, { prepend: true })

  // ── process-self guard (SAFETY): native pre-execute deny for shell
  // commands that kill/restart the harness process itself, until the user
  // confirms (R4: migrated from tools/execute + custom error result). ───────
  const guardStats = { hits: 0, vetoes: 0, last: '' }
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!cfg.processSelfGuard) return next()
    if (exec?.parent !== undefined || exec?.agent === undefined) return next()
    if (exec.name !== 'pwsh' && exec.name !== 'bash') return next()
    guardStats.hits += 1
    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
    const matched = selfKillDetect(command, process.pid, process.ppid)
    guardStats.last = `${exec.name}|${matched}|${command.slice(0, 80)}`
    if (!matched) return next()
    const session = exec.agent.session
    const events = Array.isArray(session?.events) ? session.events : []
    // The user explicitly asked for a restart/kill 鈫?the model may proceed.
    if (events.some((e) => e.type === 'user/message' && e.data?.source?.kind === 'user'
      && userAskedRestart(extractText(e.data)))) return next()
    const first = killVetoed.get(session.id)
    if (first !== undefined && events.some((e) => e.type === 'user/message'
      && e.data?.source?.kind === 'user' && e.seq > first)) {
      return next() // user replied after the reminder 鈫?confirmed
    }
    if (first === undefined) {
      killVetoed.set(session.id, events.length > 0 ? events.at(-1).seq : 0)
    }
    guardStats.vetoes += 1
    return { kind: 'deny', reason: selfKillVetoMessage(process.pid) }
  })

  // ── V4.9: tool_search REMOVED (measured: 17 calls across 7 sessions,
  // zero real successes —sessions 19/25 wasted 3/14 calls searching for
  // tools that were never in the catalog; the direct-call path (session 20
  // called job_output off-surface successfully) covers real needs, and the
  // resident set carries everything commonly used. Zero-success mechanism
  // rule (iron law 1). matchCatalog removed with it (dead code). ─────────

  // ── self-monitoring tool: trace_status (read-only, lean) ──────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'trace_status',
    description: "Show this session's cadence state: complexity class, phase, step/tool counts, plan-mode flag, process-self-guard stats, deadlock-ladder counters, subagent-timeout steers, reasoning-block median (p50), post-compaction state. Read-only.",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const st = stateOf(session)
      const ev = session.events
      const steps = ev.filter((e) => e.type === 'step/start').length
      const calls = ev.filter((e) => e.type === 'tool/call').length
      return [
        `build=v4.14`,
        `complexity=${st.complex ? 'complex' : 'simple'}`,
        `preClass=${st.preClass ? 'yes' : 'no'}`,
        `phase=resident`, // V4.12: no promotion phases
        `controlled=${postCompaction(ev) ? 'yes' : 'no'}`,
        `steps=${steps} calls=${calls}`,
        `planMode=${st.planMode ? 'yes' : 'no'}`,
        `selfGuard=${cfg.processSelfGuard ? 'on' : 'off'}`,
        `guardHits=${guardStats.hits} vetoes=${guardStats.vetoes} last=${guardStats.last || '-'}`,
        `blockP50=${blockMedian(ev)}`,
        `stallSteers=${countMarkers(ev, '进度停滞')}`,
        `verifiedDeadlocks=${countMarkers(ev, '已核验卡死')}`,
        `pauses=${countMarkers(ev, '暂停指令')}`,
        `subagentSteers=${countMarkers(ev, 'Cadence 子代理超时')}`,
        `convergeSteers=${countMarkers(ev, 'Cadence converge')}`,
        `costSteers=${countMarkers(ev, 'Cadence means cost')}`,
        `meansSteers=${countMarkers(ev, 'Cadence means review')}`,
      ].join('\n')
    },
  }))

  function currentSession() {
    const initiator = ctx.get('agent')
    if (initiator !== undefined && initiator.session !== undefined) return initiator.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }
}
