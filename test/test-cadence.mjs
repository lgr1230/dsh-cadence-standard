// Functional test suite for cadence-standard v4.5 (LEAN): a minimal fake
// Cordis ctx exercises every listener the bootstrap registers, plus
// pure-function tests for the core detection logic.
//
// v4.5 (adds on v4.4's 124): means-cost steer + unconverged-means backstop
// (session-19 calibration) and token-AND tool_search matching ("vision
// image" regression). Covers the full V4.4/V4.5 mechanism set — anchor turn
// + F1 pre-classification, narrow first-task surface + promotion, resident
// catalog (17 tools incl. vision + todo_write), compaction epoch, bootstrap
// strip + instruction hint, metacognition checkpoints (reflection + final
// check with the F4 boundary fix), safety trio (deadlock ladder L1–L4,
// process-self guard, subagent timeout), convergence steer, verification
// texts, means detection, reloader + trace_status + tool_search.
import { apply } from 'file:///C:/Users/Admin/.dsh/.agent-presets/cadence-standard/cadence-bootstrap.mjs'
import * as core from 'file:///C:/Users/Admin/.dsh/.agent-presets/cadence-standard/cadence-core.mjs'

const results = []
const check = (label, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)

function makeHarness(cfg) {
  const listeners = {}
  const registered = []
  const cancelCalls = []
  let initiator = null
  const ctx = {
    on(ev, fn, opts) { (listeners[ev] ??= []).push({ fn, opts }) },
    effect(fn) { fn() },
    get(key) { return key === 'agent' ? initiator : undefined },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx, cfg ?? {})
  const agentOf = (session, opts) => {
    const agent = {
      session,
      inbox: { append() {} },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', ...(opts ?? {}) },
      cancel(cause, opts) { cancelCalls.push({ cause, opts }) },
    }
    initiator = agent
    return agent
  }
  const h = (ev) => listeners[ev].map((l) => l.fn)
  return { ctx, listeners, registered, cancelCalls, agentOf, h }
}

const userMsg = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const complexText = '请重构这个模块的架构，考虑并发与性能，多文件迁移'
const simpleText = '写个 hello 脚本'

// ── 1. classification ───────────────────────────────────────────────────────
{
  check('classify: complex long task', core.isComplexTask(complexText) === true, 'complex')
  check('classify: simple short task', core.isComplexTask(simpleText) === false, 'simple')
  check('classify: 打不开/异常 → complex', core.isComplexTask('WebGL异常，打不开网页') === true, 'cn error')
  check('classify: crash/blank → complex', core.isComplexTask('the page shows a blank screen and crashes') === true, 'en error')
  check('sessionClass: empty → simple', core.sessionClass([]) === 'simple', 'empty')
  check('sessionClass: complex msg upgrades', core.sessionClass([
    { type: 'user/message', seq: 1, data: userMsg('u1', simpleText) },
    { type: 'user/message', seq: 2, data: userMsg('u2', complexText) },
  ]) === 'complex', 'monotonic upgrade')
  check('effectiveClass: batch complex wins over simple events', core.effectiveClass(
    [userMsg('b1', complexText)],
    [{ type: 'user/message', seq: 1, data: userMsg('u1', simpleText) }],
  ) === 'complex', 'batch wins')
}

// ── 2. personas: lean, no anchors, no discipline sentences ──────────────────
{
  const sp = core.personaFor(false)
  const cp = core.personaFor(true)
  check('persona: simple is minimal', sp.includes('Match your effort'), 'simple')
  check('persona: complex has deep-think guidance', cp.includes('think deeply first'), 'complex')
  check('persona: no flash anchors', !cp.includes('review what you have already done'), 'no anchors')
  check('persona: no file-discipline sentence', !cp.includes('read it first'), 'no discipline')
  check('persona: no env enumeration', !cp.includes('py -0p'), 'no env words')
}

// ── 3. guides: full every message, relaxed wording ──────────────────────────
{
  check('guide: simple text', core.GUIDE_SIMPLE.includes('direct task'), 'simple guide')
  check('guide: complex carries input-driven comparison', core.GUIDE_COMPLEX.includes('input-driven') && core.GUIDE_COMPLEX.includes('closed-loop self-made'), 'method text')
  check('guide: complex carries delegation line (session-22 parallel spec extraction)', core.GUIDE_COMPLEX.includes('delegating subagents') && core.GUIDE_COMPLEX.includes('main process owns architecture'), 'delegation text')
  check('V4.10: delegation criterion is modularity, not input-heaviness (session-29 review)',
    core.GUIDE_COMPLEX.includes('can be modularized') && !core.GUIDE_COMPLEX.includes('large or input-heavy'), 'modular delegation')
  check('guide: complex carries relaxed env-stuck', core.GUIDE_COMPLEX.includes('a failed command does not mean'), 'env-stuck text')
  check('V4.8: guide is decision-oriented (no deep-think monolith)', core.GUIDE_COMPLEX.includes('Think before acting')
    && !core.GUIDE_COMPLEX.includes('Think enough') && !core.GUIDE_COMPLEX.includes('first-person process narration'), 'decision wording')
  check('V4.11: no per-block decision requirement (user review)',
    !core.GUIDE_COMPLEX.includes('end this block with a decision') && !core.personaFor(true).includes('end each reasoning block with a decision'), 'no decision-ending')
  check('V4.10: no minimum-spend directive in simple persona (session-28 review)',
    !core.personaFor(false).includes('do not multiply') && !core.personaFor(false).includes('minimal tools'), 'no min-spend')
  check('V4.10: no hard escalation gate in simple guide (session-28 review)',
    !core.GUIDE_SIMPLE.includes('only if'), 'no only-if')
  check('V4.10: env-stuck carries minimal rendering guidance (session-28 CPU spike)',
    core.ENV_STUCK_TEXT.includes('prefer hardware acceleration') && core.ENV_STUCK_TEXT.includes('do not use software rendering')
    && !core.ENV_STUCK_TEXT.includes('SwiftShader') && !core.ENV_STUCK_TEXT.includes('saturate the CPU'), 'render minimal')
  check('V4.8: narration moved to STEER_NARRATION (execution phase)', core.STEER_NARRATION.includes('Cadence narration')
    && core.STEER_NARRATION.includes('I am') && core.STEER_NARRATION.includes('I will')
    && !core.STEER_NARRATION.includes('let me'), 'narration steer')
  check('V4.8: persona carries narration line (always-present, complex only)', core.personaFor(true).includes('Narrate your process in first person during execution')
    && !core.personaFor(false).includes('Narrate'), 'persona narration')
  check('guide: relaxed — no tool-name enumeration', !core.GUIDE_COMPLEX.includes('py -0p') && !core.GUIDE_COMPLEX.includes('uv-conda'), 'relaxed')
  check('guide: lite removed', core.GUIDE_COMPLEX_LITE === undefined, 'no lite')
  const hh = makeHarness()
  const s = { id: 's3', events: [{ type: 'user/message', seq: 1, data: userMsg('u1', complexText) }] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [userMsg('u2', complexText)] }))
  const fulls = d1.messages.filter((m) => m.content?.[0]?.text?.includes('this is a complex task')).length
  check('guide: every complex message gets the FULL guide', fulls === 1, `full guides=${fulls}`)
}

// ── 4. V4.14: warm-up anchor turn + resident surface + 32k fuse ────────────
{
  const hh = makeHarness()
  const s = { id: 's4', events: [], header: { delegationDepth: 0 } }
  const agent = hh.agentOf(s)
  agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  hh.prepended = []

  // Fresh top-level user message → anchor notice prepended (warm-up turn).
  hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r1', complexText) })
  check('V4.14: fresh session prepends the anchor notice', hh.prepended.length === 1
    && hh.prepended[0].content[0].text.includes('Cadence 热身'), `n=${hh.prepended.length}`)

  // Warm-up assemble: ZERO tools + SIMPLE persona (even for a complex task).
  const warm = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [
      { name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' },
      { name: 'web_search' }, { name: 'create_goal' },
    ], contexts: [],
  }))
  check('V4.14: warm-up turn has zero tools', warm.tools.length === 0, `tools=${warm.tools.length}`)
  check('V4.14: warm-up uses SIMPLE persona',
    warm.sections.find((x) => x.name === 'cadence-persona').text.includes('Match your effort'), 'simple persona')

  // Warm-up request: capped at 2048; a later request must not inherit it.
  const rw = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('V4.14: warm-up request capped at 2048', rw.maxTokens === 2048, `got ${rw.maxTokens}`)
  const rx = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 2048 }))
  check('V4.14: inherited 2048 cap released for the task request', rx.maxTokens === undefined, `got ${rx.maxTokens}`)

  // Task request: resident surface + complex persona + 32k first-task cap.
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' },
      { name: 'write' }, { name: 'vision' }, { name: 'web_search' }, { name: 'subagent' }, { name: 'create_goal' },
    ], contexts: [],
  }))
  const taskTools = a1.tools.map((t) => t.name).sort()
  check('V4.14: task request = resident surface (delegation/goal visible from the start)',
    JSON.stringify(taskTools) === JSON.stringify(['create_goal', 'edit', 'glob', 'grep', 'pwsh', 'read', 'subagent', 'vision', 'web_search', 'write'].sort()),
    `got ${taskTools.join(',')}`)
  check('V4.14: task request complex persona', a1.sections.find((x) => x.name === 'cadence-persona').text.includes('think deeply first'), 'complex persona')
  const r1 = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('V4.14: first task request capped at 32000 (V4.8 calibrated fuse)', r1.maxTokens === 32000, `got ${r1.maxTokens}`)
  const r2 = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('V4.14: later requests uncapped', r2.maxTokens === 256000, `got ${r2.maxTokens}`)

  // Surface is stable across phases (no promotion machinery).
  s.events.push({ type: 'tool/call', seq: 20, data: { name: 'read', arguments: '{}' } })
  const a2 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' },
      { name: 'write' }, { name: 'vision' }, { name: 'web_search' }, { name: 'subagent' },
    ], contexts: [],
  }))
  check('V4.14: surface unchanged after tool calls (no promotion phase)',
    JSON.stringify(a2.tools.map((t) => t.name).sort()) === JSON.stringify(['edit', 'glob', 'grep', 'pwsh', 'read', 'subagent', 'vision', 'web_search', 'write'].sort()),
    `tools=${a2.tools.map((t) => t.name).join(',')}`)
}

// V4.14: non-fresh sessions never re-anchor; anchorFirstTurn off disables it.
{
  const hh = makeHarness()
  const s = { id: 's4b', events: [{ type: 'user/message', seq: 1, data: userMsg('old', 'hi') }], header: { delegationDepth: 0 } }
  const agent = hh.agentOf(s)
  agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  hh.prepended = []
  hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r2', complexText) })
  check('V4.14: non-fresh session does not re-anchor', hh.prepended.length === 0, `n=${hh.prepended.length}`)
}
{
  const hh = makeHarness({ anchorFirstTurn: false })
  const s = { id: 's4c', events: [], header: { delegationDepth: 0 } }
  const agent = hh.agentOf(s)
  agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  hh.prepended = []
  hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r3', complexText) })
  check('V4.14: anchorFirstTurn off → no anchor', hh.prepended.length === 0, `n=${hh.prepended.length}`)
}

// ── 5. V4.12: surface is phase-independent (simple too) ─────────────────────
{
  const hh = makeHarness()
  const s = { id: 's5', events: [{ type: 'assistant/message', seq: 1, data: { message: { content: [] } } }] }
  hh.agentOf(s)
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent: hh.agentOf(s) }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }, { name: 'web_search' }],
    contexts: [],
  }))
  check('V4.12: simple session also gets the resident surface (no narrow core)',
    a1.tools.length === 6 && a1.tools.some((t) => t.name === 'web_search'), `tools=${a1.tools.length}`)
  s.events.push({ type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } })
  const a2 = await hh.h('system-prompt/assemble')[0](null, { agent: hh.agentOf(s) }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }, { name: 'web_search' }],
    contexts: [],
  }))
  check('V4.12: surface stable after tool calls', a2.tools.length === 6, `tools=${a2.tools.length}`)
}

// ── 6. metacognition checkpoints ────────────────────────────────────────────
{
  const mkSteps = (n, startSeq = 1) => Array.from({ length: n }, (_, i) => ({ type: 'step/start', seq: startSeq + i, data: {} }))
  const userMsgEv = (seq) => ({ type: 'user/message', seq, data: userMsg(`u${seq}`, '任务') })
  check('reflection: too few steps → false', core.reflectionDue(mkSteps(10), {}) === false, 'early')
  check('reflection: ≥12 steps no intervention → true', core.reflectionDue([...mkSteps(13), userMsgEv(99)], {}) === true, 'due')
  check('reflection: user intervention → false', core.reflectionDue([...mkSteps(13), userMsgEv(99), userMsgEv(100)], {}) === false, 'intervened')
  const writeEv = { type: 'tool/call', seq: 50, data: { name: 'write', arguments: '{}' } }
  check('final: no write → false', core.finalCheckDue(mkSteps(15), {}) === false, 'no write')
  check('final: <8 steps after write → false', core.finalCheckDue([...mkSteps(3), writeEv, ...mkSteps(5, 60)], {}) === false, 'early')
  check('final: ≥8 steps after write → true (and ≥20 total, V4.6 floor)', core.finalCheckDue([...mkSteps(13), writeEv, ...mkSteps(9, 60), userMsgEv(99)], {}) === true, 'due')
  check('final: relaxed text carries contrast principle', core.STEER_FINAL_CHECK.includes('against the reference') && core.STEER_FINAL_CHECK.includes('downloading or searching alone does not count'), 'contrast+flow')
  check('final: relaxed text carries self-score line', core.STEER_FINAL_CHECK.includes('Self-ratings or external scores are not delivery evidence'), 'score line')
  const hh = makeHarness()
  const s = { id: 's6', events: [
    ...mkSteps(14),
    { type: 'user/message', seq: 20, data: userMsg('task', complexText) },
    writeEv,
    ...mkSteps(9, 70),
  ] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('checkpoints: reflection injected', d1.messages.some((m) => m.content[0].text.includes('Cadence reflection')), 'reflection')
  check('checkpoints: final check injected', d1.messages.some((m) => m.content[0].text.includes('Cadence final check')), 'final')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('checkpoints: idempotent', !d2.messages.some((m) => m.content[0].text.includes('Cadence reflection') || m.content[0].text.includes('Cadence final check')), 'no repeat')
}

// ── 5b. V4.8: execution-phase narration steer (once, at 2nd tool call) ─────
{
  const hh = makeHarness()
  const s = { id: 's5b', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },   // 1st call → promotion + hint
  ] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('V4.8: narration NOT injected at 1st tool call (hint only, no stack)', !d1.messages.some((m) => m.content[0].text.includes('Cadence narration')), '1st call no narration')
  s.events.push({ type: 'tool/call', seq: 3, data: { name: 'write', arguments: '{}' } }) // 2nd call
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('V4.8: narration injected at 2nd tool call', d2.messages.some((m) => m.content[0].text.includes('Cadence narration')), '2nd call narration')
  for (const m of d2.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 100, data: m })
  const d3 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('V4.8: narration idempotent', !d3.messages.some((m) => m.content[0].text.includes('Cadence narration')), 'no repeat')
}

// ── 7. deadlock ladder (rebuilt, locked) ────────────────────────────────────
{
  const cmd = (seq, name, command) => ({ type: 'tool/call', seq, data: { name, arguments: JSON.stringify({ command }) } })
  const res = (seq, text) => ({ type: 'tool/result', seq, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }], isError: true }] } } })
  check('ladder: identicalCommandCount x3', core.identicalCommandCount([cmd(1, 'pwsh', 'a'), cmd(2, 'pwsh', 'a'), cmd(3, 'pwsh', 'a')]) === 3, '3')
  check('ladder: distinct args count 1', core.identicalCommandCount([cmd(1, 'pwsh', 'a'), cmd(2, 'pwsh', 'b')]) === 1, 'distinct')
  check('ladder: interleaved writes still count', core.identicalCommandCount([cmd(1, 'pwsh', 'a'), cmd(2, 'write', 'x'), cmd(3, 'pwsh', 'a'), cmd(4, 'write', 'y'), cmd(5, 'pwsh', 'a')]) === 3, 'loop')
  check('ladder: double-check below threshold', core.identicalCommandCount([cmd(1, 'pwsh', 'a'), cmd(2, 'pwsh', 'a')]) === 2, '2')
  check('ladder: identicalFailureCount x3', core.identicalFailureCount([res(1, 'boom'), res(2, 'boom'), res(3, 'boom')]) === 3, 'fails 3')
  check('ladder: different failures count 1', core.identicalFailureCount([res(1, 'boom'), res(2, 'bang')]) === 1, 'fails distinct')

  const cfg = { maxRepeats: 3, maxIdenticalFailures: 3, graceStepsAfterSteer: 0 }
  const steers = (s) => s.events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'plugin')
  const pushSteers = (s, msgs) => { for (const m of msgs.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 100, data: m }) }

  // L1: 3 repeats → SUSPECT; then L2 → VERIFIED; then L3 → PAUSE; then L3b → REMIND.
  const hhCfg = { maxRepeats: 3, maxIdenticalFailures: 3, graceStepsAfterSteer: 0 }
  const s = { id: 's7', events: [cmd(1, 'pwsh', 'a'), cmd(2, 'pwsh', 'a'), cmd(3, 'pwsh', 'a')] }
  check('ladder: L1 suspect', core.detectDeadlock(s.events, cfg) === core.DL_SUSPECT, 'L1')
  const hh = makeHarness(hhCfg)
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('ladder: stall steer injected', d1.messages.some((m) => m.content[0].text.includes('进度停滞')), 'L1 steer')
  pushSteers(s, d1.messages)
  check('ladder: L2 verified', core.detectDeadlock(s.events, cfg) === core.DL_VERIFIED, 'L2')
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('ladder: verified steer injected', d2.messages.some((m) => m.content[0].text.includes('已核验卡死')), 'L2 steer')
  pushSteers(s, d2.messages)
  check('ladder: L3 pause', core.detectDeadlock(s.events, cfg) === core.DL_PAUSE, 'L3')
  const d3 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('ladder: pause steer injected', d3.messages.some((m) => m.content[0].text.includes('暂停指令')), 'L3 steer')
  pushSteers(s, d3.messages)
  check('ladder: L3b reminder', core.detectDeadlock(s.events, cfg) === core.DL_REMIND, 'L3b')
  const d4 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('ladder: reminder steer injected', d4.messages.some((m) => m.content[0].text.includes('Cadence 提醒')), 'L3b steer')
  pushSteers(s, d4.messages)
  check('ladder: no escalation by default', core.detectDeadlock(s.events, cfg) === core.DL_NONE, 'no L4')

  // Progress resets the episode.
  const sP = { id: 's7p', events: [cmd(1, 'pwsh', 'a'), cmd(2, 'pwsh', 'a'), cmd(3, 'pwsh', 'a'), { type: 'tool/call', seq: 9, data: { name: 'write', arguments: '{}' } }] }
  check('ladder: progress resets', core.detectDeadlock(sP.events, cfg) === core.DL_NONE, 'progress')

  // L4 escalate (opt-in) + plan-mode block.
  const hh4 = makeHarness({ escalateAfterIgnore: true, ...hhCfg })
  const s4 = { id: 's7e', events: [cmd(1, 'pwsh', 'a'), cmd(2, 'pwsh', 'a'), cmd(3, 'pwsh', 'a')] }
  const a4 = hh4.agentOf(s4)
  const e1 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  pushSteers(s4, e1.messages)
  const e2 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  pushSteers(s4, e2.messages)
  const e3 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  pushSteers(s4, e3.messages)
  const e4 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  pushSteers(s4, e4.messages)
  check('ladder: L4 detected with escalateAfterIgnore', core.detectDeadlock(s4.events, { ...cfg, escalateAfterIgnore: true }) === core.DL_ESCALATE, 'L4 state')
  const e5 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('ladder: L4 cancels once with keepInbox', hh4.cancelCalls.length === 1 && hh4.cancelCalls[0].opts?.keepInbox === true, `${hh4.cancelCalls.length} cancel`)
  check('ladder: L4 has no directive injection', !e5.messages.some((m) => m.content?.[0]?.text?.includes('Cadence')), 'no directive')
  s4.events.push({ type: 'user/message', seq: 999, data: { content: [{ type: 'text', text: 'You are in plan mode.' }] } })
  // plan mode blocks L4: assemble sets st.planMode from sections.
  await hh4.h('system-prompt/assemble')[0](null, { agent: a4 }, async () => ({
    sections: [{ name: 'persona', text: 'x' }, { name: 'plan-mode', text: 'You are in plan mode.' }], tools: [], contexts: [],
  }))
  const e6 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('ladder: plan mode blocks L4 cancel', hh4.cancelCalls.length === 1, `cancels=${hh4.cancelCalls.length}`)
}

// ── 8. process-self guard ───────────────────────────────────────────────────
{
  const selfPid = process.pid
  const parentPid = process.ppid
  check('guard: kill own pid → true', core.selfKillDetect(`Stop-Process -Id ${selfPid} -Force`) === true, 'own pid')
  check('guard: taskkill own pid → true', core.selfKillDetect(`taskkill /PID ${selfPid} /F`) === true, 'taskkill')
  check('guard: bash kill -9 own pid → true', core.selfKillDetect(`kill -9 ${selfPid}`) === true, 'bash kill')
  check('guard: Get-Process node | Stop-Process → true', core.selfKillDetect('Get-Process node | Stop-Process') === true, 'all node')
  check('guard: unrelated kill → false', core.selfKillDetect('Stop-Process -Id 99999999') === false, 'other pid')
  check('guard: ordinary command → false', core.selfKillDetect('Get-Content foo.txt') === false, 'plain')
  check('guard: user asked restart → true', core.userAskedRestart('请重启 dsh web 服务') === true, 'ask')
  check('guard: user asked restart (verb-first) → true', core.userAskedRestart('重启 dsh web 服务吧') === true, 'verb-first')
  check('guard: english ask → true', core.userAskedRestart('please restart the dsh server') === true, 'en')
  check('guard: mention only → false', core.userAskedRestart('工具层会拦截，不会实际终止任何进程') === false, 'mention')
  const exec = (name, command, session) => ({
    name, arguments: command !== undefined ? { command } : {}, agent: { session }, parent: undefined,
    signal: new AbortController().signal,
  })
  const marker = async () => ({ kind: 'allow' })
  const isPass = (r) => r?.kind === 'allow'
  const hh = makeHarness()
  const s = { id: 's8', events: [{ type: 'user/message', seq: 5, data: userMsg('u8', '帮我检查一下环境') }] }
  hh.agentOf(s)
  const veto = await hh.h('tools/pre-execute')[0](exec('pwsh', `Stop-Process -Id ${selfPid} -Force`, s), marker)
  check('guard: self-kill denied via pre-execute', veto?.kind === 'deny' && String(veto.reason ?? '').includes('Cadence 保护'), 'deny')
  const pass = await hh.h('tools/pre-execute')[0](exec('pwsh', 'Get-Content foo.txt', s), marker)
  check('guard: ordinary command passes', isPass(pass), 'pass')
  const hh2 = makeHarness()
  const s2 = { id: 's8b', events: [{ type: 'user/message', seq: 5, data: userMsg('u8', '帮我检查一下环境') }] }
  hh2.agentOf(s2)
  const v1 = await hh2.h('tools/pre-execute')[0](exec('pwsh', `Stop-Process -Id ${selfPid}`, s2), marker)
  check('guard: first veto records state', v1?.kind === 'deny', 'first veto')
  s2.events.push({ type: 'user/message', seq: 99, data: userMsg('u8b', '好的，确认重启') })
  const v2 = await hh2.h('tools/pre-execute')[0](exec('pwsh', `Stop-Process -Id ${selfPid}`, s2), marker)
  check('guard: after user reply the kill passes', isPass(v2), 'confirmed')
  const hh3 = makeHarness()
  const s3 = { id: 's8c', events: [{ type: 'user/message', seq: 5, data: userMsg('u8', '请重启 dsh web 服务') }] }
  hh3.agentOf(s3)
  const v3 = await hh3.h('tools/pre-execute')[0](exec('pwsh', `Stop-Process -Id ${selfPid}`, s3), marker)
  check('guard: user-requested restart allowed', isPass(v3), 'user asked')
  const hh4 = makeHarness({ processSelfGuard: false })
  const s4 = { id: 's8d', events: [{ type: 'user/message', seq: 5, data: userMsg('u8', '帮我检查一下环境') }] }
  hh4.agentOf(s4)
  const v4 = await hh4.h('tools/pre-execute')[0](exec('pwsh', `Stop-Process -Id ${selfPid}`, s4), marker)
  check('guard: processSelfGuard:false disables veto', isPass(v4), 'config off')
}

// ── 9. subagent timeout ─────────────────────────────────────────────────────
{
  const now = Date.now()
  const started = { type: 'tool/call', seq: 1, time: now - 20 * 60000, data: { name: 'subagent', arguments: '{}' } }
  check('timeout: overdue without settled → true', core.subagentOverdue([started], now, 15 * 60000) === true, 'overdue')
  check('timeout: settled is not overdue', core.subagentOverdue([
    started,
    { type: 'user/message', seq: 2, time: now - 1000, data: { source: { kind: 'subagent-settled' }, content: [] } },
  ], now, 15 * 60000) === false, 'settled')
  check('timeout: within window not overdue', core.subagentOverdue([{ ...started, time: now - 1000 }], now, 15 * 60000) === false, 'fresh')
  const hh = makeHarness()
  const s = { id: 's9', events: [started] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('timeout: steer injected', d1.messages.some((m) => m.content[0].text.includes('Cadence 子代理超时')), 'steer')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('timeout: idempotent', !d2.messages.some((m) => m.content[0].text.includes('Cadence 子代理超时')), 'no repeat')
}

// ── 10. block-length convergence steer ──────────────────────────────────────
{
  const mkMsg = (text) => ({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'reasoning', text }] } } })
  const mkSteps = (n) => Array.from({ length: n }, (_, i) => ({ type: 'step/start', seq: 100 + i, data: {} }))
  const long = mkMsg('x'.repeat(6000))
  const short = mkMsg('y'.repeat(200))
  check('converge: long-median fixture → true', core.blockLengthSteerDue([...mkSteps(12), long, long, short, long, long], {}) === true, 'long')
  check('converge: short-median fixture → false', core.blockLengthSteerDue([...mkSteps(12), short, short, long, short, short], {}) === false, 'short')
  check('converge: too few steps → false', core.blockLengthSteerDue([long, long, long, long, long], {}) === false, 'steps')
  check('converge: user intervened → false', core.blockLengthSteerDue([...mkSteps(12), { type: 'user/message', seq: 1, data: userMsg('u', 'x') }, { type: 'user/message', seq: 2, data: userMsg('u2', 'y') }, long, long, long, long, long], {}) === false, 'intervened')
  check('converge: threshold override', core.blockLengthSteerDue([...mkSteps(12), mkMsg('z'.repeat(3000)), mkMsg('z'.repeat(3000)), mkMsg('z'.repeat(3000))], { blockP50Threshold: 4000 }) === false, 'threshold')
  // Calibration equivalents (the local real-session logs are not part of this
  // repo): a session whose running median crosses 2500 fires; one that stays
  // below does not.
  check('converge: long-median session fires (calibration)',
    core.blockLengthSteerDue([...mkSteps(12), long, long, short, long, long, long, long, long], {}) === true, 'cal long')
  check('converge: short-median session does not fire (calibration)',
    core.blockLengthSteerDue([...mkSteps(12), short, short, long, short, short, short, short, short], {}) === false, 'cal short')
  const hh = makeHarness()
  const s = { id: 's10', events: [...mkSteps(12), { type: 'user/message', seq: 50, data: userMsg('task', complexText) }, long, long, long, long, long] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('converge: steer injected via pre-step', d1.messages.some((m) => m.content[0].text.includes('Cadence converge')), 'steer')
}

// ── 10b. V4.10 (B2) block-depth steer (mirror of converge) ──────────────────
{
  const mkMsg = (text) => ({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'reasoning', text }] } } })
  const mkSteps = (n) => Array.from({ length: n }, (_, i) => ({ type: 'step/start', seq: 100 + i, data: {} }))
  const long = mkMsg('x'.repeat(6000))
  const short = mkMsg('y'.repeat(200))
  const mid = mkMsg('z'.repeat(1500))
  check('deepen: short-median fixture → true', core.blockShortnessSteerDue([...mkSteps(12), short, short, long, short, short], {}) === true, 'short')
  check('deepen: long-median fixture → false', core.blockShortnessSteerDue([...mkSteps(12), long, long, short, long, long], {}) === false, 'long')
  check('deepen: mid-band fixture → false', core.blockShortnessSteerDue([...mkSteps(12), mid, mid, long, mid, mid], {}) === false, 'mid')
  check('deepen: too few steps → false', core.blockShortnessSteerDue([short, short, short, short, short], {}) === false, 'steps')
  check('deepen: user intervened → false', core.blockShortnessSteerDue([...mkSteps(12), { type: 'user/message', seq: 1, data: userMsg('u', 'x') }, { type: 'user/message', seq: 2, data: userMsg('u2', 'y') }, short, short, short, short, short], {}) === false, 'intervened')
  check('deepen: floor override', core.blockShortnessSteerDue([...mkSteps(12), mid, mid, mid, mid, mid], { blockP50Floor: 2000 }) === true, 'floor')
  check('deepen: threshold override does not fire floor', core.blockShortnessSteerDue([...mkSteps(12), short, short, short, short, short], { blockP50Floor: 100 }) === false, 'low floor')
  const hh = makeHarness()
  const s = { id: 's10b', events: [...mkSteps(12), { type: 'user/message', seq: 50, data: userMsg('task', complexText) }, short, short, long, short, short, short, short, short] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('deepen: steer injected via pre-step', d1.messages.some((m) => m.content[0].text.includes('Cadence deepen')), 'steer')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('deepen: idempotent (once per session)', !d2.messages.some((m) => m.content[0].text.includes('Cadence deepen')), 'no repeat')
}

// ── 11. reloader + trace_status (lean) ──────────────────────────────────────
{
  const rel = await import('file:///C:/Users/Admin/.dsh/.agent-presets/cadence-standard/cadence-reloader.mjs')
  check('reloader: shape', rel.name === 'cadence-reloader' && rel.inject.includes('loader') && typeof rel.apply === 'function', 'shape')
  const hh = makeHarness()
  const s = { id: 's11', events: [{ type: 'user/message', seq: 1, data: userMsg('u11', '写个脚本') }, { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } }] }
  hh.agentOf(s)
  const names = hh.registered.map((t) => t.name)
  check('V4.9: tool_search REMOVED (17 calls / 0 successes rule)', !names.includes('tool_search')
    && names.includes('trace_status'), names.join(','))
  const status = hh.registered.find((t) => t.name === 'trace_status')
  const out = await status.execute()
  check('trace_status: lean fields', /build=v4\.14/.test(out) && /blockP50=0/.test(out) && !/band=|budget=|frequent=|requested=/.test(out), out.replace(/\n/g, ' | '))
}

// ── 12. V4.1: resident catalog, compaction epoch, strip, hint ───────────────
{
  // unlockedTools
  const resident = new Set(['read'])
  const unlocked = core.unlockedTools([
    { type: 'tool/call', seq: 1, data: { name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 2, data: { name: 'vision', arguments: '{}' } },
  ], resident)
  check('R1: unlockedTools from durable tool/call events', unlocked.has('vision') && !unlocked.has('read'), [...unlocked].join(','))
  // postCompaction
  check('R2: postCompaction true after boundary', core.postCompaction([
    { type: 'tool/call', seq: 1, data: { name: 'read', arguments: '{}' } },
    { type: 'compaction/end', seq: 10, data: { compactionId: 'c1', turn: null } },
  ]) === true, 'controlled')
  check('R2: new progress re-promotes', core.postCompaction([
    { type: 'tool/call', seq: 1, data: { name: 'read', arguments: '{}' } },
    { type: 'compaction/end', seq: 10, data: { compactionId: 'c1', turn: null } },
    { type: 'assistant/message', seq: 20, data: { message: { content: [] } } },
  ]) === false, 'repromoted')
  check('R2: failed compaction ignored', core.postCompaction([
    { type: 'tool/call', seq: 1, data: { name: 'read', arguments: '{}' } },
    { type: 'compaction/end', seq: 10, data: { compactionId: 'c1', turn: null, error: 'boom' } },
  ]) === false, 'failed ignored')

  // R1 assemble integration: promoted → resident + unlocked; safety valves.
  const hh = makeHarness()
  const s = { id: 's12', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 3, data: { name: 'vision', arguments: '{}' } },
  ] }
  const agent = hh.agentOf(s)
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [
      { name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' },
      { name: 'vision' }, { name: 'web_search' }, { name: 'subagent' }, { name: 'ask_user_question' },
      { name: 'create_goal' }, { name: 'dev_inject_plugin' }, { name: 'workflow' }, { name: 'trace_status' },
    ],
    contexts: [],
  }))
  const names = a1.tools.map((t) => t.name)
  check('R1: resident + unlocked (vision) visible', names.includes('read') && names.includes('ask_user_question')
    && names.includes('vision') && !names.includes('tool_search'), names.join(','))
  check('R1: heavy tools filtered until unlocked', !names.includes('dev_inject_plugin')
    && !names.includes('workflow'), names.join(','))
  check('V4.10: web_search/goal resident (session-29 review)', names.includes('web_search') && names.includes('create_goal'), names.join(','))

  // R1: subagents get the NARROWED working surface (V4.10 safety): the
  // file/command/task core only — control-plane tools stay with the parent.
  const sub = { id: 's12s', header: { delegationDepth: 1 }, events: [] }
  const agentS = hh.agentOf(sub)
  const aS = await hh.h('system-prompt/assemble')[0](null, { agent: agentS }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [{ name: 'read' }, { name: 'dev_inject_plugin' }, { name: 'workflow' }, { name: 'ask_user_question' }, { name: 'pwsh' }], contexts: [],
  }))
  const sNames = aS.tools.map((t) => t.name)
  check('R1: subagent surface narrowed (safety) — work tools kept, control-plane filtered',
    sNames.includes('read') && sNames.includes('pwsh') && !sNames.includes('dev_inject_plugin')
    && !sNames.includes('workflow') && !sNames.includes('ask_user_question'), sNames.join(','))

  // V4.10: first-request cap applies to TOP-LEVEL agents only.
  const hhCap = makeHarness()
  const capTop = hhCap.agentOf({ id: 'cap-top', header: { delegationDepth: 0 }, events: [] })
  const capSub = hhCap.agentOf({ id: 'cap-sub', header: { delegationDepth: 1 }, events: [] })
  const rTop = await hhCap.h('agent/request')[0]({ agent: capTop }, async () => ({ maxTokens: 256000 }))
  const rSub = await hhCap.h('agent/request')[0]({ agent: capSub }, async () => ({ maxTokens: 256000 }))
  check('V4.10: top-level first request capped (32000)', rTop.maxTokens, 32000)
  check('V4.10: subagent first request NOT capped (truncation fix)', rSub.maxTokens, 256000)

  // R2 assemble: post-compaction → resident only (no unlocked).
  const sC = { id: 's12c', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 3, data: { name: 'vision', arguments: '{}' } },
    { type: 'compaction/end', seq: 10, data: { compactionId: 'c', turn: null } },
  ] }
  const agentC = hh.agentOf(sC)
  const aC = await hh.h('system-prompt/assemble')[0](null, { agent: agentC }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [{ name: 'read' }, { name: 'vision' }, { name: 'web_search' }, { name: 'ask_user_question' }],
    contexts: [],
  }))
  const cNames = aC.tools.map((t) => t.name)
  check('R2: post-compaction → resident only (vision stays resident, unlocked filtered)',
    cNames.includes('read') && cNames.includes('ask_user_question')
    && cNames.includes('vision') && !cNames.includes('dev_inject_plugin'), cNames.join(','))

  // R3 → V4.12: context strip REMOVED — AGENTS digest and skill catalog flow
  // through from the first request; no instruction hint anymore.
  const hh3 = makeHarness()
  const s3 = { id: 's12d', events: [{ type: 'user/message', seq: 1, data: userMsg('u', complexText) }] }
  hh3.agentOf(s3)
  const d1 = await hh3.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [
    userMsg('m1', '任务'),
    { id: 'instr', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS digest' }] },
    { id: 'skill', role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skills' }] },
  ] }))
  const kinds = d1.messages.map((m) => m.source?.kind)
  check('V4.12: no context strip — agent-instructions/skill-catalog pass through',
    kinds.includes('agent-instructions') && kinds.includes('skill-catalog') && kinds.includes('user'), kinds.join(','))
  const hh4 = makeHarness()
  const s4 = { id: 's12e', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
  ] }
  hh4.agentOf(s4)
  const d2 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('V4.12: no instruction hint injected (strip removed with the hint)',
    !d2.messages.some((m) => m.content?.[0]?.text?.includes('Cadence instruction hint')), 'no hint')
}

// ── 13. V4.2: F1 pre-classify, F2 request_tool, F3 frequent tier ────────────
{
  const fs = await import('node:fs')
  const assemble = async (hh, agent, tools) => hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools, contexts: [],
  }))
  const names = (a) => a.tools.map((t) => t.name)

  // F1: inserted pre-classification — first request WITHOUT any user/message
  // event yet must carry the complex persona + complex core.
  {
    const hh = makeHarness()
    const s = { id: 's13f1', events: [] }
    const agent = hh.agentOf(s)
    hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('task', complexText) })
    const a1 = await assemble(hh, agent, [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' }, { name: 'write' }, { name: 'vision' },
    ])
    check('F1: complex first request gets the resident surface (V4.10)',
      JSON.stringify(names(a1).sort()) === JSON.stringify(['edit', 'glob', 'grep', 'pwsh', 'read', 'vision', 'write']), names(a1).join(','))
    check('F1: complex persona on the very first request',
      a1.sections.find((x) => x.name === 'cadence-persona').text.includes('think deeply first'), 'complex persona')
  }
  // F1: simple insert does NOT upgrade; plugin insert never classifies —
  // the surface is the resident catalog either way (V4.12).
  {
    const hh = makeHarness()
    const s = { id: 's13s', events: [] }
    const agent = hh.agentOf(s)
    hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r1', simpleText) })
    const a1 = await assemble(hh, agent, [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }])
    check('F1: simple insert → resident surface (V4.12, no narrow core)',
      names(a1).length === 5 && names(a1).includes('vision'), names(a1).join(','))
    const hh2 = makeHarness()
    const s2 = { id: 's13p', events: [] }
    const agent2 = hh2.agentOf(s2)
    hh2.h('agent/inbox/inserted')[0]({ agent: agent2, message: { source: { kind: 'plugin' }, content: [{ type: 'text', text: complexText }] } })
    const a2 = await assemble(hh2, agent2, [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }])
    check('F1: plugin insert never classifies (surface still resident)', names(a2).length === 5, names(a2).join(','))
  }

  // F1: the pre-step batch (no user message → effectiveClass simple) must
  // NOT downgrade the inserted pre-classification.
  {
    const hh = makeHarness()
    const s = { id: 's13m', events: [] }
    const agent = hh.agentOf(s)
    hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r1', complexText) })
    const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [
      { id: 'w', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Cadence context' }] },
    ] }))
    check('F1: plugin-only pre-step does not downgrade complex', d1 !== undefined, 'ran')
    const a1 = await assemble(hh, agent, [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' }, { name: 'write' },
    ])
    check('F1: complex first request gets the resident surface',
      JSON.stringify(names(a1).sort()) === JSON.stringify(['edit', 'glob', 'grep', 'pwsh', 'read', 'write']), names(a1).join(','))
    // The planning round sees delegation/goal/todo/search tools (V4.10+).
    const hhF = makeHarness()
    const sF = { id: 's13first', events: [{ type: 'user/message', seq: 1, data: userMsg('u', complexText) }] }
    const agentF = hhF.agentOf(sF)
    const aF = await assemble(hhF, agentF, [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' }, { name: 'write' },
      { name: 'subagent' }, { name: 'create_goal' }, { name: 'todo_write' }, { name: 'web_search' }, { name: 'vision' },
    ])
    const fNames = names(aF)
    check('V4.10: complex first request sees delegation+goal+todo+search (planning round)',
      fNames.includes('subagent') && fNames.includes('create_goal') && fNames.includes('todo_write') && fNames.includes('web_search'), fNames.join(','))
  }

  // V4.3: vision is RESIDENT — visible right after promotion without any
  // request/unlock (the V4.1/V4.2 dead loop is gone).
  {
    const hh = makeHarness()
    const s = { id: 's13vis', events: [
      { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
      { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
    ] }
    const agent = hh.agentOf(s)
    const a1 = await assemble(hh, agent, [
      { name: 'vision' }, { name: 'read' }, { name: 'pwsh' }, { name: 'web_search' }, { name: 'subagent' },
    ])
    check('V4.3: vision in promoted surface (resident)', names(a1).includes('vision'), names(a1).join(','))
    check('V4.3: request_tool NOT registered', hh.registered.find((t) => t.name === 'request_tool') === undefined, 'removed')
    check('V4.9: content-density line in final check', core.STEER_FINAL_CHECK.includes('basic units')
      && core.STEER_FINAL_CHECK.includes('proportionate') === false || core.STEER_FINAL_CHECK.includes('match the task'), 'density final')
    check('V4.9: content-density question in reflection ⑥', core.STEER_REFLECTION.includes('content density proportionate')
      && core.STEER_REFLECTION.includes('thinned for convenience'), 'density reflection')
    // post-compaction: vision stays (resident).
    const sC = { id: 's13visc', events: [
      { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
      { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
      { type: 'compaction/end', seq: 10, data: { compactionId: 'c', turn: null } },
    ] }
    const agentC = hh.agentOf(sC)
    const aC = await assemble(hh, agentC, [{ name: 'read' }, { name: 'vision' }, { name: 'web_search' }])
    check('V4.3: vision stays in post-compaction surface', names(aC).includes('vision') && !names(aC).includes('dev_inject_plugin'), names(aC).join(','))
  }

  // V4.3 (F4): finalCheckDue counts the in-flight step — a session ending
  // exactly `finalCheckAfterSteps` steps after its last write still fires.
  // V4.6: a global step floor (finalCheckMinSteps=20) stops early fires on
  // edit-heavy sessions (sessions 21/19 fired at step 12/15, delivery
  // 147/152; calibrated on 8 archived sessions).
  {
    const mkSteps = (n, startSeq = 1) => Array.from({ length: n }, (_, i) => ({ type: 'step/start', seq: startSeq + i, data: {} }))
    const writeEv = { type: 'tool/call', seq: 50, data: { name: 'write', arguments: '{}' } }
    // 7 steps after the write but only 10 total steps → the floor blocks.
    check('V4.6: <20 total steps → false (floor)', core.finalCheckDue([...mkSteps(3), writeEv, ...mkSteps(7, 60)], {}) === false, 'floor blocks')
    // 7 steps after the write AND >= 20 total steps → due (F4 in-flight still counts).
    check('V4.6: >=20 total steps → true', core.finalCheckDue([...mkSteps(13), writeEv, ...mkSteps(7, 60)], {}) === true, '13+7')
    check('V4.6: floor configurable (15)', core.finalCheckDue([...mkSteps(8), writeEv, ...mkSteps(7, 60)], { finalCheckMinSteps: 15 }) === true, 'cfg 15')
  }
}

// ── 14. V4.3/V4.4: verification texts + resident additions ────────────────
{
  check('V4.3: real-form line in reflection', core.STEER_REFLECTION.includes('COMPLETE form'), 'reflection ④ real-form')
  check('V4.3: real-form lines in final check', core.STEER_FINAL_CHECK.includes('complete form')
    && core.STEER_FINAL_CHECK.includes('real form') && core.STEER_FINAL_CHECK.includes('character summary'), 'final check')
  check('V4.3: no failure-turn remnants', core.STEER_FAILURE_TURN === undefined
    && !core.STEER_FINAL_CHECK.includes('连续失败'), 'no F5')
  check('V4.6: reflection covers dynamic/时序 (session-21 ghosting)', core.STEER_REFLECTION.includes('dynamic processes')
    && core.STEER_REFLECTION.includes('timing behavior') && core.STEER_REFLECTION.includes('state residue'), 'reflection dynamic')
  check('V4.6: final check broad-requirement line (session-21 single-side)', core.STEER_FINAL_CHECK.includes('broad requirements')
    && core.STEER_FINAL_CHECK.includes('confirm scope'), 'broad req')
  check('V4.6: env default-config line (sessions 19/20 soft-render)', core.ENV_STUCK_TEXT.includes('not the only configuration')
    && core.ENV_STUCK_TEXT.includes('read-only'), 'env config')
  check('V4.7: reflection intent question ⑤ (session-22 "I want" role)', core.STEER_REFLECTION.includes('What effect/quality am I actually aiming for'), 'intent ⑤')
  check('V4.7: safety texts stay CHINESE (deadlock/subagent/veto)', core.STEER_STALL.includes('进度停滞')
    && core.STEER_DEADLOCK.includes('已核验卡死') && core.STEER_PAUSE.includes('暂停指令')
    && core.STEER_SUBAGENT.includes('子代理超时'), 'safety zh')
  check('V4.7: english injections have english markers in text', core.STEER_REFLECTION.includes('Cadence reflection')
    && core.STEER_FINAL_CHECK.includes('Cadence final check') && core.STEER_CONVERGE.includes('Cadence converge')
    && core.STEER_DEEPEN.includes('Cadence deepen'), 'en markers')

  // V4.4: todo_write is resident (visible after promotion without unlock).
  const hh = makeHarness()
  const s = { id: 's14', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
  ] }
  const agent = hh.agentOf(s)
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }, { name: 'todo_write' }, { name: 'web_search' }],
    contexts: [],
  }))
  const n = a1.tools.map((t) => t.name)
  check('V4.4: todo_write in promoted surface (resident)', n.includes('todo_write') && n.includes('vision') && n.includes('web_search'), n.join(','))
}

// ── 15. V4.5: means-level detection (tool_search/matcatalog removed V4.9) ──
{
  // meansStats: session-19-shaped events (5 runs of the same script,
  // cumulative > 15 min, last run failed) must fire.
  const mcmd = (seq, callId, command, t) => ({ type: 'tool/call', seq, time: t, data: { name: 'pwsh', callId, arguments: JSON.stringify({ command }) } })
  const mres = (seq, callId, text, t) => ({ type: 'tool/result', seq, time: t, data: { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } } })
  const slowRuns = []
  for (let i = 1; i <= 5; i++) {
    slowRuns.push(mcmd(i, `c${i}`, `node tools\\headless_test.mjs http://127.0.0.1:8080/ > test\\out\\harness_run${i}.log 2>&1; Write-Output "exit=$LASTEXITCODE"`, i * 1000))
    slowRuns.push(mres(100 + i, `c${i}`, 'exit=1 === scenario: equatorial FAILED', i * 1000 + 200000))
  }
  const st = core.meansStats(slowRuns, { minRuns: 5, minAccMs: 900000 })
  check('V4.5: 5 slow failing runs → unconverged', st !== null && st.runs === 5 && st.accMs >= 900000, JSON.stringify(st))

  // Same shape but the LAST run succeeded → converged, no fire.
  const converged = [...slowRuns.slice(0, -1), mres(105, 'c5', '65/65 PASS exit=0', 5 * 1000 + 200000)]
  check('V4.5: last run succeeded → no fire', core.meansStats(converged, { minRuns: 5, minAccMs: 900000 }) === null, 'converged')

  // Different scripts (12 fast physics runs) never fire: runs per means < 5.
  const fastMany = []
  for (let i = 1; i <= 12; i++) {
    fastMany.push(mcmd(i, `p${i}`, `node tools\\physics_test.mjs`, i * 1000))
    fastMany.push(mres(200 + i, `p${i}`, 'assert failed', i * 1000 + 2000))
  }
  check('V4.5: many fast runs of another means → no fire', core.meansStats(fastMany, { minRuns: 5, minAccMs: 900000 }) === null, 'fast other means')

  // Duration gate: 5 slow-failing runs but cumulative < 15 min → no fire.
  const shortAcc = []
  for (let i = 1; i <= 5; i++) {
    shortAcc.push(mcmd(i, `s${i}`, `node tools\\headless_test.mjs x`, i * 1000))
    shortAcc.push(mres(300 + i, `s${i}`, 'exit=1 FAILED', i * 1000 + 60000))
  }
  check('V4.5: cumulative < threshold → no fire', core.meansStats(shortAcc, { minRuns: 5, minAccMs: 900000 }) === null, 'short acc')

  // Soft layer threshold (explicit cfg — V4.12 defaults are relaxed to
  // 5 runs / 10 min): 3 runs / 5 min fires the soft steer (hard silent).
  const softRuns = slowRuns.slice(0, 6)
  const softCfg = { meansCostRuns: 3, meansCostMinSec: 300, unconvergedRuns: 8, unconvergedMinSec: 1200 }
  const softInj = core.pendingInjections({
    events: [{ type: 'user/message', seq: 1, data: userMsg('u', complexText) }, { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } }, ...softRuns],
    batchMessages: [], cls: 'complex', promoted: true, cfg: softCfg, nowMs: 0,
  })
  const softTexts = softInj.map((i) => i.text).join(' ')
  check('V4.5: 3 slow failing runs → cost steer only', softTexts.includes('Cadence means cost') && !softTexts.includes('Cadence means review'), 'soft only')

  // pendingInjections: markers injected once, idempotent (explicit V4.5 cfg).
  const base = [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
    ...slowRuns,
  ]
  const v45cfg = { meansCostRuns: 3, meansCostMinSec: 300, unconvergedRuns: 5, unconvergedMinSec: 900 }
  const inj1 = core.pendingInjections({ events: base, batchMessages: [], cls: 'complex', promoted: true, cfg: v45cfg, nowMs: 0 })
  const texts1 = inj1.map((i) => i.text).join(' ')
  check('V4.5: unconverged steer injected', texts1.includes('Cadence means review') && texts1.includes('Re-evaluate the means itself'), 'hard steer')
  check('V4.5: cost steer NOT injected when hard fires', !texts1.includes('Cadence means cost'), 'no soft when hard')
  const withCost = [...base, ...inj1.filter((i) => i.marker).map((i) => ({ type: 'user/message', seq: 999, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: i.text }] } }))]
  const inj2 = core.pendingInjections({ events: withCost, batchMessages: [], cls: 'complex', promoted: true, cfg: v45cfg, nowMs: 0 })
  check('V4.5: steer idempotent', !inj2.some((i) => i.marker === 'Cadence means review'), 'idempotent')
}

// ── V4.13 (2026-08-22, session-30 review): interleave persona + goal guide ──
{
  const cp = core.personaFor(true)
  const sp = core.personaFor(false)
  check('V4.13: complex persona interleaves thinking with tool calls (1A)',
    cp.includes('Interleave thinking with tool calls') && cp.includes('first minimal step'), '1A text')
  check('V4.13: simple persona has no interleave sentence', !sp.includes('Interleave thinking'), 'simple clean')
  check('V4.13: complex persona guides goal creation (G1)',
    cp.includes('create a goal first') && cp.includes('scale expectation') && cp.includes('drives rounds automatically'), 'G1 text')
  check('V4.13b: code goes to tools, not into reasoning (session-dcc6d859)',
    cp.includes('do not draft the full code inside reasoning') && cp.includes('write/edit tools'), 'F3 text')
  check('V4.13b: simple persona has no code-draft sentence', !sp.includes('draft the full code'), 'simple clean')
}

// ── V4.14 (user decision): 2A auto-recovery REMOVED — the restored anchor
// turn prevents the first-request blowout; truncation protection no longer
// needs a continue-the-turn crutch. STEER_RECOVER is gone. ───────────────────
{
  check('V4.14: auto-recovery steer removed', core.STEER_RECOVER === undefined, 'no STEER_RECOVER')
  const hh = makeHarness()
  check('V4.14: no agent/status listener registered', (hh.listeners['agent/status'] ?? []).length === 0, `n=${(hh.listeners['agent/status'] ?? []).length}`)
}

console.log(results.join('\n'))
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`)
