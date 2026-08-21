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
  DL_ESCALATE,
  STEER_RECOVER,
  applyPersona, blockMedian, countMarkers,
  detectDeadlock, effectiveClass,
  extractText, isComplexTask, pendingInjections, personaFor,
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
    // V4.12: 32000 -> 64000 — the model upgrade self-manages overthinking;
    // the cap stays as a fuse, not a throttle. Subagents are exempt (V4.10).
    // V4.13b (session-dcc6d859 review): 64000 -> 24000 -> 32000 — 24k truncated
    // every "write-the-code-in-reasoning" request (3/3 turns cut); 32k is
    // the V4.8-calibrated value under which sessions 26/29 never truncated.
    firstRequestMaxTokens: Number.isSafeInteger(config.firstRequestMaxTokens) && config.firstRequestMaxTokens > 0
      ? config.firstRequestMaxTokens : 32000,
    // V4.8 (O2-A): execution-phase narration steer (once, complex).
    narrationAdvisor: config.narrationAdvisor !== false,
    // V4.13 (2026-08-22, session-30/31 review): truncation auto-recovery —
    // up to 2× per session, a max-tokens turn/end whose TRUNCATED STEP had
    // no tool calls gets a next-turn recovery message instead of waiting for
    // the user's "继续". Goal sessions are NOT excluded (the goal driver
    // disarms on max-tokens — no reservation to collide with).
    autoRecover: config.autoRecover !== false,
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
  /** Session id -> count of truncation auto-recoveries fired (max 2/session). */
  const recovered = new Map()

  const stateOf = (session) => {
    let st = states.get(session.id)
    if (st === undefined) {
      st = { complex: false, planMode: false, preClass: false }
      states.set(session.id, st)
    }
    return st
  }

  // ── F1 pre-classification (monotonic; plugin/runtime messages never
  // classify) ────────────────────────────────────────────────────────────────
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== undefined && agent.session !== undefined
      && message?.source?.kind === 'user') {
      const text = extractText(message)
      if (text.trim() && isComplexTask(text)) {
        stateOf(agent.session).complex = true
        stateOf(agent.session).preClass = true
      }
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
    // V4.12: no anchor turn, no narrow first-task surface, no promotion
    // phases — the RESIDENT catalog is the surface from the FIRST request
    // (simple and complex alike; V4.10 gave complex the resident surface
    // first, V4.12 extends it everywhere and removes the phase machinery).
    // postCompaction (R2) also converges to the same surface, so the branch
    // is gone too.
    return { ...assembled, sections, tools: keep(residentSet) }
  })

  // ── request listener: V4.8 first-request cap (V4.12: 64k fuse) ────────────
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    if (agent === undefined) return resolved
    const session = agent.session
    const st = stateOf(session)
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

  // ── V4.13 (2026-08-22, session-30/31 review): truncation auto-recovery ────
  // A max-tokens turn/end whose TRUNCATED STEP produced no tool calls is a
  // pure-thinking blowout (session-30: 64k in one block; session-dcc6d859: 24k in
  // every pre-write request, 3/3 turns cut). Recovery fires up to 2× per
  // session (the burn-every-request pattern outlasts a single recovery).
  // The guard is step-level (the turn's LAST step/start onward), not
  // turn-level — session-dcc6d859's turn1 ran env-probe + create_goal tools in
  // step1 but the cut happened in a zero-tool step2, and the turn-level
  // guard skipped it. Goal sessions are NOT excluded: the goal driver
  // disarms on max-tokens (no reservation to collide with), and with G1
  // guiding goal creation, goal sessions would otherwise never recover.
  // Every failure degrades to the manual one-click recovery footer.
  ctx.on('session/event', (session, event) => {
    if (!cfg.autoRecover) return
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'max-tokens') return
    const id = session?.id
    if (id === undefined) return
    const count = recovered.get(id) ?? 0
    if (count >= 2) return
    const ev = Array.isArray(session?.events) ? session.events : []
    const turn = event.data?.turn
    // The truncated step = the turn's last step/start boundary onward.
    let lastStepSeq = -Infinity
    for (const e of ev) {
      if (e.type === 'step/start' && e.data?.turn === turn && typeof e.seq === 'number') {
        if (e.seq > lastStepSeq) lastStepSeq = e.seq
      }
    }
    if (lastStepSeq === -Infinity) return // no step boundary: abnormal, do not inject
    if (ev.some((e) => e.type === 'tool/call' && e.data?.turn === turn
      && typeof e.seq === 'number' && e.seq > lastStepSeq)) return
    const agent = recentAgents.get(id) ?? agents.get(id)
    if (agent === undefined) return
    try {
      agent.inbox.prepend('next-turn', {
        id: `cadence-recover-${seqToken()}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'cadence-bootstrap' },
        content: [{ type: 'text', text: STEER_RECOVER }],
      })
      recovered.set(id, count + 1)
    } catch { /* degrade to the manual recovery footer */ }
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
        `build=v4.13`,
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
