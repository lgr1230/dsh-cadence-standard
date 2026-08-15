/**
 * cadence-bootstrap v2 — thinking-budget pacing for the DSH execution chain.
 *
 * v2 changes vs v1 (all derived from the V1 test-session postmortem):
 *
 *   1. ALL injections moved from the `session/event` emit path (which never
 *      fired in V1 — scope/agent lookup failure) into the `agent/pre-step`
 *      waterfall, which is proven to work. One listener, two explicit phases:
 *      strip first, inject second (no listener-order dependencies).
 *   2. Budget awareness: the model sees a constant neutral budget section
 *      plus a band message ("small/medium/large" with the real cap) injected
 *      when the band changes, BEFORE it starts thinking. Truncation of the
 *      previous step (reasoning consumed the whole cap) releases the next
 *      request's cap and injects a recovery message.
 *   3. Classification is monotonic and batch-aware: the entering batch's
 *      real user message classifies the step (fixes V1's assemble-time
 *      misclassification); later complex messages upgrade permanently.
 *   4. Platform-aware shell hints + shell-syntax-error detection (PowerShell
 *      on win32).
 *   5. Plan-forward utilization: slow progress steers the model to move
 *      planned independent verification earlier — never new actions.
 *   6. Verified deadlock ladder: suspicion (L1) → fingerprint-verified (L2)
 *      → pause-and-ask-user (L3) → bounded reminder (L3b) → optional
 *      escalation (L4, default off, plan-mode-safe). L4 uses
 *      `agent.cancel({keepInbox:true})` WITHOUT injecting a directive — the
 *      user decides afterwards; the turn ends `aborted` and stays auditable.
 *
 * Security invariants (P1–P8): all injection texts are static constants from
 * cadence-core (zero interpolation); no fs/shell/permission tools are
 * registered (`trace_status` is read-only, `trace_tune` only changes the
 * budget); the strip list never touches user or policy messages; every
 * injection is idempotent via durable markers; failures degrade to "keep
 * everything" / "no injection".
 */

import {
  ANCHOR_TEXT, BUDGET_SECTION, DELEGATION_SECTION, DL_ESCALATE,
  applyPersona, budgetBandFor, coreFor, countMarkers, countTruncated,
  detectDeadlock, detectTruncation, effectiveClass,
  isFreshTopLevel, parseCap, pendingInjections, personaFor,
  platformFor, platformProfileFor, platformSectionFor, sessionClass,
  trajectoryIndicators,
} from './cadence-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cadence-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

const PROMOTE_EITHER = ['tool/call', 'assistant/message']
const DEFAULT_SUPPRESSED_SOURCES = ['agent-instructions', 'skill-catalog']

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function positiveInt(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EITHER
  if (value === 'tool-call') return ['tool/call']
  if (value === 'assistant-message') return ['assistant/message']
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/** Strip `maxTokens` from a resolved request when it equals one of our caps. */
function stripCaps(resolved, caps) {
  if (!caps.includes(resolved.maxTokens)) return resolved
  const { maxTokens: _dropped, ...rest } = resolved
  return rest
}

function seqToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function apply(ctx, config) {
  const simpleBootstrap = positiveInt(config.simpleBootstrapMaxTokens, 'simpleBootstrapMaxTokens', 2048)
  const simpleCap = positiveInt(config.simpleCapMaxTokens, 'simpleCapMaxTokens', 4096)
  const complexBootstrap = positiveInt(config.complexBootstrapMaxTokens, 'complexBootstrapMaxTokens', 16384)
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const suppressedSources = sourceList(config.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const cfg = {
    simpleBootstrap,
    simpleCap,
    complexBootstrap,
    platformHints: config.platformHints !== false,
    delegationAdvisor: config.delegationAdvisor !== false,
    utilizationAdvisor: config.utilizationAdvisor !== false,
    deadlockDetector: config.deadlockDetector !== false,
    escalateAfterIgnore: config.escalateAfterIgnore === true,
    maxRepeats: positiveInt(config.maxRepeats, 'maxRepeats', 4),
    maxIdenticalFailures: positiveInt(config.maxIdenticalFailures, 'maxIdenticalFailures', 3),
    graceStepsAfterSteer: positiveInt(config.graceStepsAfterSteer, 'graceStepsAfterSteer', 2),
    anchorFirstTurn: config.anchorFirstTurn !== false,
    anchorText: typeof config.anchorText === 'string' && config.anchorText.length > 0
      ? config.anchorText
      : ANCHOR_TEXT,
    subagentTimeoutMin: positiveInt(config.subagentTimeoutMin, 'subagentTimeoutMin', 15),
    todoSyncAdvisor: config.todoSyncAdvisor !== false,
    todoSyncAfterSteps: positiveInt(config.todoSyncAfterSteps, 'todoSyncAfterSteps', 12),
    visualDepthAdvisor: config.visualDepthAdvisor !== false,
  }
  /** Active platform profile (V2.2 platform adaptation; config override wins). */
  const profile = platformProfileFor(platformFor(config))
  const injectedCaps = [simpleBootstrap, simpleCap, complexBootstrap]

  /** Sessions already promoted in this process; promotion is append-only. */
  const promoted = new Set()
  /** Session id -> explicit budget from `trace_tune` ('full' or a token count). */
  const explicitCaps = new Map()
  /** Session id -> live Agent handle (in-process only, for trace tools). */
  const agents = new Map()
  /** Session id -> most recently assembled Agent (C3: initiator cross-talk guard). */
  const recentAgents = new Map()
  /** Session id -> live state (plan-mode flag, memoized class, anchor flag). */
  const states = new Map()

  const isPromoted = (session) => {
    if (session === undefined) return true
    if (promoted.has(session.id)) return true
    const hit = session.events.some((event) => promoteEvents.includes(event.type))
    if (hit) promoted.add(session.id)
    return hit
  }

  const stateOf = (session) => {
    let st = states.get(session.id)
    if (st === undefined) {
      st = { complex: false, planMode: false, anchorInjected: false }
      states.set(session.id, st)
    }
    return st
  }

  // ── anchor first turn: seed one low-load warm-up turn before the real task ──
  // (V2.2: kills the turn-1 "all thinking, no output, max-tokens stall").
  // The `agent/inbox/inserted` event payload carries the agent — the one
  // injection path verified to work (zero-anchored-standard's anchor-turn).
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
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
    } catch {
      // Races: skip; the real message proceeds unanchored rather than blocked.
      st.anchorInjected = false
    }
  })

  // ── prompt assembly: persona + constant sections + first-request surface ──
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)
    recentAgents.set(session.id, agent) // C3: remember the most recent active session
    const st = stateOf(session)
    // Plan mode is a live system-prompt state; remember it for the L4 gate.
    st.planMode = (assembled.sections ?? []).some(
      (s) => (s.text ?? '').includes('You are in plan mode'),
    )
    // Durable classification; the entering batch is NOT visible here, so the
    // first request falls back to simple and complex sessions upgrade from
    // step 2 (documented one-step persona lag; the budget is batch-correct).
    const complex = sessionClass(session.events) === 'complex'
    st.complex = complex
    const sections = applyPersona(assembled.sections, personaFor(complex))
    sections.push(BUDGET_SECTION)
    sections.push(platformSectionFor(profile))
    if (complex) sections.push(DELEGATION_SECTION)
    // Anchor phase: the warm-up turn runs with ZERO tools (short text reply is
    // guaranteed, so it cannot stall on thinking; the reply promotes the
    // session and the real task then runs with the full catalog + budget).
    if (st.anchorInjected && !isPromoted(session)) {
      return { ...assembled, sections, tools: [] }
    }
    if (isPromoted(session)) return { ...assembled, sections }
    const core = new Set(coreFor(complex))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) return { ...assembled, sections } // no platform shell: keep the full catalog
    core.add(shell)
    return { ...assembled, sections, tools: assembled.tools.filter((tool) => core.has(tool.name)) }
  })

  // ── request budget ladder + truncation recovery ───────────────────────────
  // prepend:true keeps this listener the OUTERMOST transform.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    if (agent === undefined) return resolved
    const session = agent.session
    const complex = sessionClass(session.events) === 'complex'

    if (!isPromoted(session)) {
      return { ...resolved, maxTokens: complex ? complexBootstrap : simpleBootstrap }
    }

    const explicit = explicitCaps.get(session.id)
    if (explicit === 'full') return stripCaps(resolved, injectedCaps)
    if (typeof explicit === 'number') return { ...resolved, maxTokens: explicit }

    // Truncation recovery: the previous step burned its whole cap thinking.
    // Release the ladder now — the model gets the promoted bound immediately.
    if (detectTruncation(session.events, cfg)) {
      return complex ? stripCaps(resolved, injectedCaps) : { ...resolved, maxTokens: simpleCap }
    }

    if (complex) return stripCaps(resolved, injectedCaps)
    return { ...resolved, maxTokens: simpleCap }
  }, { prepend: true })

  // ── pre-step: strip (bootstrap) then inject (all advisors) ────────────────
  // ONE listener, explicit phase order — no cross-listener ordering hazards.
  // IMPORTANT: the `agent/pre-step` waterfall payload does NOT carry an
  // `agent` field (agent-loop passes { messages, turn, step, signal } only),
  // so the agent must come from the initiator scope (`ctx.get('agent')`),
  // falling back to the assemble-cached handle. Destructuring `{ agent }`
  // from the payload would silently disable every injection.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      // C3 initiator cross-talk guard: prefer the most recently assembled
      // agent for the initiator's session, then the initiator itself, then
      // any cached handle. (The payload carries no agent field.)
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

      // Phase 1: strip automatic injections on the bootstrap request only.
      let messages = Array.isArray(decision.messages) ? decision.messages : []
      if (!isPromoted(agent.session) && suppressedSources.size > 0) {
        const kept = messages.filter((m) => {
          const kind = m?.source?.kind
          return typeof kind !== 'string' || !suppressedSources.has(kind)
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

      // Phase 2: compute injections from durable events + the entering batch.
      const cls = effectiveClass(messages, agent.session.events)
      st.complex = cls === 'complex'
      const injections = pendingInjections({
        events: agent.session.events,
        batchMessages: messages,
        cls,
        promoted: isPromoted(agent.session),
        cfg,
        profile,
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

  // ── self-monitoring tools (agent-visible cadence loop) ───────────────────
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
    }))
  }

  function currentSession() {
    const initiator = ctx.get('agent')
    if (initiator !== undefined && initiator.session !== undefined) return initiator.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function snapshot(session) {
    const st = stateOf(session)
    const phase = isPromoted(session) ? 'promoted' : 'bootstrap'
    const explicit = explicitCaps.get(session.id)
    const budget = explicit === undefined
      ? phase === 'bootstrap'
        ? String(st.complex ? complexBootstrap : simpleBootstrap)
        : st.complex ? 'full' : String(simpleCap)
      : explicit === 'full' ? 'full' : String(explicit)
    const steps = session.events.filter((e) => e.type === 'step/start').length
    const calls = session.events.filter((e) => e.type === 'tool/call').length
    return {
      st,
      phase,
      budget,
      steps,
      calls,
      band: budgetBandFor(st.complex, phase === 'promoted'),
    }
  }

  registerTool({
    name: 'trace_status',
    description: "Show this session's cadence state: complexity class, phase, budget band, step/tool counts, sentinel counters (stall/verified/pause markers, truncations, utilization steers, shell errors, delegation advice), plan-mode flag, and current output budget. Read-only.",
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const s = snapshot(session)
      const ev = session.events
      const caps = [simpleBootstrap, simpleCap, complexBootstrap]
      return [
        `complexity=${s.st.complex ? 'complex' : 'simple'}`,
        `phase=${s.phase}`,
        `band=${s.band}`,
        `steps=${s.steps} calls=${s.calls}`,
        `planMode=${s.st.planMode ? 'yes' : 'no'}`,
        `anchor=${s.st.anchorInjected ? 'yes' : 'no'}`,
        `truncations=${countTruncated(ev, caps)}`,
        `stallSteers=${countMarkers(ev, '进度停滞')}`,
        `verifiedDeadlocks=${countMarkers(ev, '已核验卡死')}`,
        `pauses=${countMarkers(ev, '暂停指令')}`,
        `utilizationSteers=${countMarkers(ev, 'Cadence 利用率')}`,
        `shellChecks=${countMarkers(ev, 'Cadence shell 检查')}`,
        `delegationAdvice=${countMarkers(ev, 'Cadence 委派建议')}`,
        `budget=${s.budget}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'trace_style',
    description: "Show this session's trajectory-style indicators (diagnostics only): reasoning char count, Chinese share, we/let me/I'll densities per 10k chars, and the share of 'let me' contexts that are verification-flavoured (recall/check/verify — healthy) vs trial-flavoured (try/guess — risky). Read-only.",
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const ti = trajectoryIndicators(session.events)
      return [
        `reasoningChars=${ti.reasoningChars}`,
        `cnRatio=${ti.cnRatioPct}%`,
        `we=${ti.wePer10k} letMe=${ti.letMePer10k} lets=${ti.letsPer10k} ill=${ti.illPer10k} (per10k)`,
        `letMeVerify=${ti.letMeVerifyShare}% letMeTrial=${ti.letMeTrialShare}%`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'trace_tune',
    description: "Tune this session's cadence: set an explicit output budget for the next requests (positive integer token count), 'full' to lift every cadence cap, or 'auto' to return to the automatic schedule (bounded for simple tasks, unbounded for complex ones). The next request applies it.",
    parameters: {
      cap: { type: 'string', required: true, description: "'auto', 'full', or a positive integer token cap" },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const cap = parseCap(args.cap)
      if (cap === null) return `invalid cap "${args.cap}": use auto, full, or a positive integer`
      if (cap === 'auto') explicitCaps.delete(session.id)
      else explicitCaps.set(session.id, cap)
      const s = snapshot(session)
      return `budget=${s.budget} — next request applies`
    },
  })
}
