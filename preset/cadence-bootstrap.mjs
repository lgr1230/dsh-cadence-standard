/**
 * cadence-bootstrap v4.4 — LEAN wiring + resident-catalog tool-surface
 * management (orchestrator-inspired, see ref-orchestrator).
 *
 * V4.4: todo_write joins RESIDENT (task-list carrier — Mona 12/14 used it,
 * V4.1–V4.3 had 0 uses with unplanned iteration); verification texts demand
 * the artifact's REAL form (F7 — Mona V4.3 verified via crops/ASCII for 80+
 * steps, rendered a PNG only at the end). A windowed block-length trigger
 * was calibrated and REJECTED (whole-session p50 fires early enough; a
 * 10-block window mis-triggers the good V4.1 session).
 * V4.3: frequent tier + request_tool REMOVED (zero calls measured — a tool
 * not on the surface is never used), vision joins RESIDENT, finalCheckDue
 * counts the in-flight step (F4).
 * V4.2 (F1): pre-classify at agent/inbox/inserted — the FIRST task request
 * carries the complex persona + complex core (was: simple while the guide
 * said complex); pre-step assignment is monotonic (the warm-up batch has no
 * user message and must not downgrade F1).
 * V4.1: R1 resident catalog + unlock-on-use (subagents keep the full
 * catalog); R2 compaction epoch (surface falls back to resident until new
 * progress); R3 bootstrap context strip + one-time instruction hint; R4
 * process-self guard on tools/pre-execute (native deny).
 *
 * Security invariants (P1–P8): all injection texts are static constants
 * (zero interpolation); no fs/shell/permission tools registered
 * (trace_status/tool_search are read-only); injections idempotent via
 * durable markers; failures degrade to "keep everything" / "no injection".
 * The resident filter is CONDITIONING, not a security boundary — the
 * sandbox/approval stack is the enforcement layer (hiding ≠ denying).
 */

import {
  ANCHOR_TEXT, DL_ESCALATE,
  applyPersona, blockMedian, coreFor, countMarkers,
  detectDeadlock, effectiveClass,
  extractText, isComplexTask, isFreshTopLevel, pendingInjections, personaFor,
  postCompaction, selfKillDetect,
  selfKillVetoMessage, sessionClass,
  unlockedTools, userAskedRestart,
} from './cadence-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cadence-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

function parsePromoteOn(value) {
  if (value === undefined || value === 'tool-call') return ['tool/call']
  if (value === 'either') return ['tool/call', 'assistant/message']
  if (value === 'assistant-message') return ['assistant/message']
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

function seqToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** V4.4 default resident set: core work tools + vision (a general capability
 *  tool — V4.1/V4.2 Mona sessions repeatedly wanted it but never had it on
 *  the surface; the unlock-on-first-use loop made it unreachable in fresh
 *  sessions) + todo_write (explicit task-list carrier — Mona 12/14 used it
 *  during planned work; V4.1–V4.3 sessions had 0 uses with unplanned
 *  wandering iteration) + SAFETY VALVES (never filtered out — the L3
 *  pause-and-ask, the subagent-timeout instructions and delegation must stay
 *  reachable in every phase) + preset tools. */
const DEFAULT_RESIDENT = [
  'read', 'write', 'edit', 'glob', 'grep',
  'pwsh', 'bash',
  'vision', 'todo_write',
  'subagent', 'subagent_fork', 'ask_user_question',
  'list_agents', 'interrupt_agent', 'send_message',
  'trace_status', 'cadence_reload', 'tool_search',
]

export function apply(ctx, config) {
  const cfg = {
    anchorFirstTurn: config.anchorFirstTurn !== false,
    anchorText: typeof config.anchorText === 'string' && config.anchorText.length > 0
      ? config.anchorText
      : ANCHOR_TEXT,
    anchorCapMaxTokens: Number.isSafeInteger(config.anchorCapMaxTokens) && config.anchorCapMaxTokens > 0
      ? config.anchorCapMaxTokens : 2048,
    promoteEvents: parsePromoteOn(config.promoteOn),
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
      ? config.blockP50Threshold : 2500,
    blockLengthAfterSteps: Number.isSafeInteger(config.blockLengthAfterSteps) && config.blockLengthAfterSteps > 0
      ? config.blockLengthAfterSteps : 10,
    // V4.1 R1 — resident catalog (conditioning, NOT a security boundary).
    residentTools: Array.isArray(config.residentTools) && config.residentTools.length > 0
      ? [...new Set(config.residentTools)]
      : DEFAULT_RESIDENT,
    // V4.1 R3 — bootstrap-phase context strip + instruction hint.
    suppressedSources: Array.isArray(config.suppressedContextSources)
      ? new Set(config.suppressedContextSources.filter((s) => typeof s === 'string' && s.length > 0))
      : new Set(['agent-instructions', 'skill-catalog']),
    instructionHint: config.instructionHint !== false,
  }
  const residentSet = new Set(cfg.residentTools)

  /** Sessions already promoted in this process; promotion is append-only. */
  const promoted = new Set()
  /** Session id -> live Agent handle (in-process only, for trace tools). */
  const agents = new Map()
  /** Session id -> most recently assembled Agent (C3: initiator cross-talk guard). */
  const recentAgents = new Map()
  /** Session id -> full assembled tool catalog (name + description), for tool_search. */
  const catalogs = new Map()
  /** Session id -> live state (plan-mode flag, memoized class, anchor flags). */
  const states = new Map()
  /** Session id -> event seq at which the process-self guard first vetoed a
   *  self-kill command. The veto stays armed until a REAL user message lands
   *  after that seq (the user confirmed) — or the user's own message already
   *  asked for the restart/kill. */
  const killVetoed = new Map()

  const isPromoted = (session) => {
    if (session === undefined) return true
    if (promoted.has(session.id)) return true
    const hit = session.events.some((event) => cfg.promoteEvents.includes(event.type))
    if (hit) promoted.add(session.id)
    return hit
  }

  const stateOf = (session) => {
    let st = states.get(session.id)
    if (st === undefined) {
      st = { complex: false, planMode: false, anchorInjected: false, anchorZeroTools: false, anchorCap: false, preClass: false }
      states.set(session.id, st)
    }
    return st
  }

  // ── anchor first turn + F1 pre-classification (one listener) ──────────────
  // F1: the inbox insert lands BEFORE the task request is assembled, so the
  // FIRST task request carries the complex persona + complex core (was:
  // simple persona + simple core while the guide said complex). Monotonic —
  // once complex, never downgraded; plugin/runtime messages never classify.
  // The warm-up assemble forces the SIMPLE persona (0 tools + "act directly"
  // is the warm-up contract). Anchor flags are INDEPENDENTLY consumed
  // (anchorZeroTools by assemble, anchorCap by request) — do NOT infer the
  // warm-up from events (the user/message event lands AFTER task assembly).
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
    if (message?.source?.kind === 'plugin') return // never re-anchor on our own or other plugin messages
    if (!isFreshTopLevel(agent)) return
    const st = stateOf(agent.session)
    if (st.anchorInjected) return // process-local idempotency for rapid successive inserts
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

    // Subagents: full catalog (their own toolFilter governs).
    if ((agent.session?.header?.delegationDepth ?? 0) > 0) {
      return { ...assembled, sections }
    }
    // Warm-up turn: ZERO tools + SIMPLE persona, exactly once (F1: the
    // pre-classified complex state must not pull the warm-up into planning).
    if (st.anchorInjected && st.anchorZeroTools && !isPromoted(session)) {
      st.anchorZeroTools = false
      return { ...assembled, sections: applyPersona(assembled.sections, personaFor(false)), tools: [] }
    }
    // R2: post-compaction — resident set only until NEW progress exists past
    // the compaction boundary (a compaction rewrites the whole surface).
    if (postCompaction(session.events)) {
      return { ...assembled, sections, tools: keep(residentSet) }
    }
    // R1: promoted — resident + tools used this session (durable-derived).
    if (isPromoted(session)) {
      const keepSet = new Set([...residentSet, ...unlockedTools(session.events, residentSet)])
      return { ...assembled, sections, tools: keep(keepSet) }
    }
    // Bootstrap task request: narrow core surface only (no union — the
    // resident set enters after the first tool call promotes the session).
    const core = new Set(coreFor(complex))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) return { ...assembled, sections } // no platform shell: keep the full catalog
    core.add(shell)
    return { ...assembled, sections, tools: keep(core) }
  })

  // ── request listener: the ONLY cap is the warm-up anchor cap ──────────────
  // Non-warm-up requests INHERIT the warm-up's 2048 cap from the persisted
  // header — release it or the first task request burns its budget thinking.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    if (agent === undefined) return resolved
    const session = agent.session
    const st = stateOf(session)
    if (st.anchorInjected && st.anchorCap && !isPromoted(session)) {
      st.anchorCap = false
      return { ...resolved, maxTokens: cfg.anchorCapMaxTokens }
    }
    if (resolved.maxTokens === cfg.anchorCapMaxTokens) {
      const { maxTokens: _drop, ...rest } = resolved
      return rest
    }
    return resolved
  }, { prepend: true })

  // ── pre-step: strip (bootstrap) + inject (all advisors) ────────────────────
  // NOTE: the `agent/pre-step` waterfall payload does NOT carry an `agent`
  // field — resolve via the initiator scope, falling back to the
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

      // R3: strip auto-injected context during the bootstrap phase only
      // (never user/policy messages).
      if (!isPromoted(agent.session) && cfg.suppressedSources.size > 0) {
        const kept = messages.filter((m) => {
          const kind = m?.source?.kind
          return typeof kind !== 'string' || !cfg.suppressedSources.has(kind)
        })
        if (kept.length !== messages.length) messages = kept
      }

      // L4 gate: verified deadlock persisted past the reminder. Cancel the
      // turn WITHOUT a directive — the user decides afterwards. Plan mode
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
      // it (the warm-up batch has no user message → simple — measured: the
      // V4.2 probe showed it erasing the F1 pre-classification).
      st.complex = st.complex || cls === 'complex'
      const injections = pendingInjections({
        events: agent.session.events,
        batchMessages: messages,
        cls,
        promoted: isPromoted(agent.session),
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
    // The user explicitly asked for a restart/kill → the model may proceed.
    if (events.some((e) => e.type === 'user/message' && e.data?.source?.kind === 'user'
      && userAskedRestart(extractText(e.data)))) return next()
    const first = killVetoed.get(session.id)
    if (first !== undefined && events.some((e) => e.type === 'user/message'
      && e.data?.source?.kind === 'user' && e.seq > first)) {
      return next() // user replied after the reminder → confirmed
    }
    if (first === undefined) {
      killVetoed.set(session.id, events.length > 0 ? events.at(-1).seq : 0)
    }
    guardStats.vetoes += 1
    return { kind: 'deny', reason: selfKillVetoMessage(process.pid) }
  })

  // ── V4.1 R1: on-demand tool discovery (read-only; the resident filter is
  // conditioning, the sandbox/approval stack is the real boundary). ─────────
  ctx.effect(() => ctx.tools.register({
    name: 'tool_search',
    description: "Search the full tool catalog by name or description substring and list matching tools. Tools not currently visible can be called directly once discovered — the catalog keeps them unlocked for this session after their first use.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'substring to match against tool names and descriptions' } },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const session = currentSession()
      const cat = session === undefined ? [] : (catalogs.get(session.id) ?? [])
      const q = String(args?.query ?? '').toLowerCase().trim()
      const hits = cat.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q))
      if (hits.length === 0) return `no tools match "${args?.query}"`
      return hits.slice(0, 30).map((t) => `- ${t.name}: ${(t.description ?? '').slice(0, 160)}`).join('\n')
    },
  }))

  // ── self-monitoring tool: trace_status (read-only, lean) ──────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'trace_status',
    description: "Show this session's cadence state: complexity class, phase, step/tool counts, plan-mode flag, anchor state, process-self-guard stats, deadlock-ladder counters, subagent-timeout steers, reasoning-block median (p50), post-compaction state and unlocked-tool count. Read-only.",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const st = stateOf(session)
      const ev = session.events
      const phase = isPromoted(session) ? 'promoted' : 'bootstrap'
      const steps = ev.filter((e) => e.type === 'step/start').length
      const calls = ev.filter((e) => e.type === 'tool/call').length
      const unlocked = unlockedTools(ev, residentSet)
      return [
        `build=v4.4`,
        `complexity=${st.complex ? 'complex' : 'simple'}`,
        `preClass=${st.preClass ? 'yes' : 'no'}`,
        `phase=${phase}`,
        `controlled=${postCompaction(ev) ? 'yes' : 'no'}`,
        `steps=${steps} calls=${calls}`,
        `planMode=${st.planMode ? 'yes' : 'no'}`,
        `anchor=${st.anchorInjected ? 'yes' : 'no'}`,
        `selfGuard=${cfg.processSelfGuard ? 'on' : 'off'}`,
        `guardHits=${guardStats.hits} vetoes=${guardStats.vetoes} last=${guardStats.last || '-'}`,
        `blockP50=${blockMedian(ev)}`,
        `unlocked=${unlocked.size}`,
        `stallSteers=${countMarkers(ev, '进度停滞')}`,
        `verifiedDeadlocks=${countMarkers(ev, '已核验卡死')}`,
        `pauses=${countMarkers(ev, '暂停指令')}`,
        `subagentSteers=${countMarkers(ev, 'Cadence 子代理超时')}`,
        `convergeSteers=${countMarkers(ev, 'Cadence 收敛')}`,
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
