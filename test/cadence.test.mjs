// Functional test suite for cadence-standard v2.3.1: a minimal fake Cordis ctx
// exercises every listener the bootstrap registers, plus pure-function tests
// for the core detection logic.
//
// v2.1 additions: the agent/pre-step waterfall payload carries NO agent field
// in real agent-loop (only { messages, turn, step, signal }), so the listener
// must resolve the agent via ctx.get('agent') (initiator) with an
// assemble-cached fallback. All pre-step calls below therefore pass an EMPTY
// payload and rely on the harness's initiator mechanism — mirroring reality.
import { apply } from '../preset/cadence-bootstrap.mjs'
import * as core from '../preset/cadence-core.mjs'

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
  const agentOf = (session) => {
    const agent = {
      session,
      inbox: { append() {} },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      cancel(cause, opts) { cancelCalls.push({ cause, opts }) },
    }
    initiator = agent // ctx.get('agent') resolves the last-created agent
    return agent
  }
  const h = (ev) => listeners[ev].map((l) => l.fn)
  return { ctx, listeners, registered, cancelCalls, agentOf, h }
}

const userMsg = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

// ── 1. assemble: sections + bootstrap tool surface ──────────────────────────
{
  const hh = makeHarness()
  const session = { id: 's1', events: [] }
  const agent = hh.agentOf(session)
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }, { name: 'plan-mode', text: 'You are in plan mode.' }],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'grep' }, { name: 'glob' }],
    contexts: [],
  }))
  const names = a1.sections.map((s) => s.name)
  check('assemble: persona replaced, sections added',
    names.includes('cadence-persona') && names.includes('cadence-budget') && names.includes('cadence-platform'),
    names.join(','))
  check('assemble: PowerShell platform hint (win32)',
    a1.sections.find((s) => s.name === 'cadence-platform').text.includes('PowerShell'),
    'hint text present')
  check('assemble: bootstrap tools (simple default)', a1.tools.map((t) => t.name).join(',') === 'read,write,edit,pwsh',
    `got ${a1.tools.map((t) => t.name).join(',')}`)
  check('assemble: no delegation section for simple', !names.includes('cadence-delegation'), 'absent')
}

// ── 2. pre-step step 1 (EMPTY payload — real agent-loop shape): complex batch ──
{
  const hh = makeHarness()
  const session = { id: 's2', events: [] }
  const agent = hh.agentOf(session)
  const batch = [userMsg('u1', '请重构这个模块的架构，考虑并发与性能，多文件迁移')]
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: batch }))
  const texts = d1.messages.map((m) => m.content[0].text)
  check('pre-step (no agent in payload): complex guide injected via initiator',
    texts.some((t) => t.includes('复杂任务')), texts.join(' | ').slice(0, 60))
  check('pre-step: band large injected', texts.some((t) => t.includes('预算档 large')), 'band present')
  check('pre-step: strip keeps user message', d1.messages.some((m) => m.id === 'u1'), 'kept')
  for (const m of batch) session.events.push({ type: 'user/message', seq: session.events.length + 1, data: m })
  const r = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('request: complex bootstrap cap 16384', r.maxTokens === 16384, `got ${r.maxTokens}`)
}

// ── 3. simple batch → guide + band small(2048); request cap 2048 ────────────
{
  const hh = makeHarness()
  const session = { id: 's3', events: [] }
  const agent = hh.agentOf(session)
  const batch = [userMsg('u2', '写一个 hello world 脚本')]
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: batch }))
  const texts = d1.messages.map((m) => m.content[0].text)
  check('pre-step: simple guide + band small(2048)',
    texts.some((t) => t.includes('直接任务')) && texts.some((t) => t.includes('预算档 small') && t.includes('2048')),
    texts.join(' | ').slice(0, 70))
  for (const m of batch) session.events.push({ type: 'user/message', seq: session.events.length + 1, data: m })
  const r = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('request: simple bootstrap cap 2048', r.maxTokens === 2048, `got ${r.maxTokens}`)
}

// ── 4. promotion: simple → band medium(4096), request 4096; complex strips ──
{
  const hh = makeHarness()
  const session = { id: 's4', events: [{ type: 'tool/call', seq: 1, data: { name: 'read', arguments: '{}' } }] }
  const agent = hh.agentOf(session)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  const texts = d1.messages.map((m) => m.content[0].text)
  check('promoted simple: band medium(4096)', texts.some((t) => t.includes('预算档 medium') && t.includes('4096')),
    texts.join(' | ').slice(0, 70))
  const r = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 2048 }))
  check('promoted simple: request cap 4096', r.maxTokens === 4096, `got ${r.maxTokens}`)
  const c4 = { id: 's4c', events: [
    { type: 'user/message', seq: 1, data: userMsg('u3', '重构这个系统的架构') },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
  ] }
  const a4 = hh.agentOf(c4)
  const dc = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('promoted complex: band large without number', dc.messages.some((m) => m.content[0].text.includes('预算档 large')),
    'band large')
  const rc = await hh.h('agent/request')[0]({ agent: a4 }, async () => ({ provider: 'p', model: 'm', maxTokens: 16384 }))
  check('promoted complex: caps stripped (adapter default)', rc.maxTokens === undefined, `got ${String(rc.maxTokens)}`)
}

// ── 5. monotonic upgrade: simple first, complex later → complex wins ────────
{
  const evs = [{ type: 'user/message', seq: 1, data: userMsg('a', '写个脚本') }]
  check('monotonic: simple stays simple', core.effectiveClass([userMsg('b', '改一下配置')], evs) === 'simple', 'simple')
  check('monotonic: complex batch upgrades', core.effectiveClass([userMsg('b', '重构架构并迁移多文件')], evs) === 'complex', 'upgraded')
  check('monotonic: durable complex wins over simple batch', core.effectiveClass([userMsg('b', '改配置')], [
    ...evs, { type: 'user/message', seq: 2, data: userMsg('c', '系统架构设计') },
  ]) === 'complex', 'durable wins')
}

// ── 5b. command-level repetition (same command, different description) ──────
{
  const pwsh = (i) => ({ type: 'tool/call', seq: i, data: { name: 'pwsh', arguments: JSON.stringify({ command: 'node scripts/debug.mjs', description: `run ${i}` }) } })
  const evs = [pwsh(1), pwsh(2), pwsh(3)]
  check('cmd-repeats: same command x3 detected', core.trailingCommandRepeats(evs) === 3, '3')
  check('cmd-repeats: args-level repeats stays 1', core.trailingRepeats(evs) === 1, '1')
  const loop = [pwsh(1), { type: 'tool/call', seq: 2, data: { name: 'write', arguments: '{}' } }, pwsh(3), { type: 'tool/call', seq: 4, data: { name: 'write', arguments: '{}' } }, pwsh(5)]
  check('cmd-repeats: loop with interleaved writes detected', core.trailingCommandRepeats(loop) === 3, '3')
  const benign = [pwsh(1), pwsh(2)]
  check('cmd-repeats: double-check stays below threshold', core.trailingCommandRepeats(benign) === 2, '2')
  const d = core.detectDeadlock([...loop, { type: 'step/start', seq: 6, data: {} }], { maxRepeats: 4, maxIdenticalFailures: 3, graceStepsAfterSteer: 2, escalateAfterIgnore: false })
  check('cmd-repeats: x3 enters L1 suspect', d === core.DL_SUSPECT, `level ${d}`)
}

// ── 6. truncation: recovery injection + promoted bound ──────────────────────
{
  const hh = makeHarness()
  const session = { id: 's6', events: [
    { type: 'user/message', seq: 1, data: userMsg('u6', '写一个 hello world') },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'x'.repeat(10) }] }, usage: { outputTokens: 2048, reasoningTokens: 2048 } } },
  ] }
  const agent = hh.agentOf(session)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('pre-step: truncation recovery injected', d1.messages.some((m) => m.content[0].text.includes('预算已放宽')),
    'recovery text')
  const r = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 2048 }))
  check('request: truncation releases to promoted bound 4096', r.maxTokens === 4096, `got ${r.maxTokens}`)
  const ok2 = { id: 's6b', events: [{ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'done' }] }, usage: { outputTokens: 500 } } }] }
  hh.agentOf(ok2)
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('no false recovery', !d2.messages.some((m) => m.content[0].text.includes('预算已放宽')), 'clean')
}

// ── 7. deadlock ladder: L2 → L3 → L3b, idempotent, L4 gated ────────────────
{
  const hh = makeHarness()
  let seq = 0
  const session = { id: 's7', events: [] }
  const agent = hh.agentOf(session)
  const ev = (type, data) => { const e = { type, seq: ++seq, time: Date.now(), data }; session.events.push(e); return e }
  const stuckRound = () => {
    ev('step/start', { turn: 1, step: 1 })
    ev('tool/call', { turn: 1, step: 1, callId: `c${seq}`, name: 'pwsh', arguments: '{"x":1}' })
    ev('tool/result', { turn: 1, step: 1, callId: `c${seq - 1}`, message: { content: [{ type: 'text', text: 'ERROR boom' }] }, error: { name: 'E', code: 'X' } })
  }
  const pre = async () => {
    const d = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
    const added = d.messages.filter((m) => m.source?.kind === 'plugin')
    for (const m of added) ev('user/message', m)
    return added.map((m) => m.content[0].text)
  }
  for (let i = 0; i < 5; i++) stuckRound()
  let texts = await pre()
  check('ladder: L2 verified injected first', texts.some((t) => t.includes('已核验卡死')), texts.join('|').slice(0, 50))
  for (let i = 0; i < 2; i++) stuckRound()
  texts = await pre()
  check('ladder: L3 pause injected after grace', texts.some((t) => t.includes('暂停指令') && t.includes('ask_user_question')),
    texts.join('|').slice(0, 50))
  for (let i = 0; i < 2; i++) stuckRound()
  texts = await pre()
  check('ladder: L3b reminder injected', texts.some((t) => t.includes('Cadence 提醒')), texts.join('|').slice(0, 50))
  for (let i = 0; i < 2; i++) stuckRound()
  texts = await pre()
  check('ladder: no further injections (idempotent, no escalate)', texts.length === 0, `got ${texts.length}`)
  check('ladder: cancel NOT called without escalateAfterIgnore', hh.cancelCalls.length === 0, '0 cancels')

  const hh4 = makeHarness({ escalateAfterIgnore: true })
  let seq4 = 0
  const s4 = { id: 's7x', events: [] }
  const a4 = hh4.agentOf(s4)
  const ev4 = (type, data) => { const e = { type, seq: ++seq4, data }; s4.events.push(e); return e }
  const round4 = () => {
    ev4('step/start', {})
    ev4('tool/call', { name: 'pwsh', arguments: '{"x":1}' })
    ev4('tool/result', { message: { content: [{ type: 'text', text: 'ERROR boom' }] }, error: { name: 'E', code: 'X' } })
  }
  const pre4 = async () => {
    const d = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
    for (const m of d.messages.filter((m) => m.source?.kind === 'plugin')) ev4('user/message', m)
    return d.messages.filter((m) => m.source?.kind === 'plugin').map((m) => m.content[0].text)
  }
  for (let i = 0; i < 5; i++) round4()
  await pre4()
  for (let i = 0; i < 2; i++) round4()
  await pre4()
  for (let i = 0; i < 2; i++) round4()
  await pre4()
  for (let i = 0; i < 2; i++) round4()
  await pre4()
  check('ladder: L4 cancel fires once with keepInbox', hh4.cancelCalls.length === 1 && hh4.cancelCalls[0].opts?.keepInbox === true,
    JSON.stringify(hh4.cancelCalls.length))
  check('ladder: L4 has no directive injection', hh4.cancelCalls.length === 1, 'cancel only')

  const sP = { id: 's7p', events: [] }
  const aP = hh4.agentOf(sP)
  await hh4.h('system-prompt/assemble')[0](null, { agent: aP }, async () => ({
    sections: [{ name: 'plan-mode', text: 'You are in plan mode.' }], tools: [], contexts: [],
  }))
  let seqP = 0
  const evP = (type, data) => { const e = { type, seq: ++seqP, data }; sP.events.push(e); return e }
  const roundP = () => {
    evP('step/start', {})
    evP('tool/call', { name: 'pwsh', arguments: '{"x":1}' })
    evP('tool/result', { message: { content: [{ type: 'text', text: 'ERROR boom' }] }, error: { name: 'E', code: 'X' } })
  }
  const preP = async () => {
    const d = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
    for (const m of d.messages.filter((m) => m.source?.kind === 'plugin')) evP('user/message', m)
  }
  const before = hh4.cancelCalls.length
  for (let i = 0; i < 5; i++) roundP()
  await preP(); for (let i = 0; i < 2; i++) roundP(); await preP()
  for (let i = 0; i < 2; i++) roundP(); await preP()
  for (let i = 0; i < 2; i++) roundP(); await preP()
  check('ladder: plan mode blocks L4 cancel', hh4.cancelCalls.length === before, 'no new cancels')
}

// ── 8. utilization: plan-forward vs read-only ───────────────────────────────
{
  const hh = makeHarness()
  const mk = (id, todos) => {
    const s = { id, events: [
      { type: 'tool/call', seq: 1, data: { name: 'job_output', arguments: '{}' } },
      { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: 'running' }] } } },
      { type: 'tool/call', seq: 3, data: { name: 'job_output', arguments: '{}' } },
      { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'text', text: 'running' }] } } },
    ] }
    if (todos !== null) s.events.push({ type: 'todo/write', seq: 5, data: { todos } })
    return s
  }
  const sPlan = mk('s8a', [{ content: '写单元测试', status: 'pending' }])
  hh.agentOf(sPlan)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('utilization: plan-forward with todo', d1.messages.some((m) => m.content[0].text.includes('前移')),
    'plan-forward text')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) {
    sPlan.events.push({ type: 'user/message', seq: sPlan.events.length + 1, data: m })
  }
  const sNo = mk('s8b', null)
  hh.agentOf(sNo)
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('utilization: read-only without todo', d2.messages.some((m) => m.content[0].text.includes('只读')),
    'read-only text')
  // restore the sPlan initiator, then confirm idempotency against sPlan
  hh.agentOf(sPlan)
  const d3 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('utilization: idempotent', d3.messages.length === 0, `got ${d3.messages.length}`)
}

// ── 9. shell syntax errors ──────────────────────────────────────────────────
{
  const hh = makeHarness()
  const s = { id: 's9', events: [
    { type: 'tool/call', seq: 1, data: { name: 'pwsh', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: 'ls : 无法将“ls”项识别为 cmdlet、函数、脚本文件或可运行程序的名称' }] }, error: { name: 'E', code: 'X' } } },
    { type: 'tool/call', seq: 3, data: { name: 'pwsh', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'text', text: 'ls : 无法将“ls”项识别为 cmdlet' }] }, error: { name: 'E', code: 'X' } } },
  ] }
  hh.agentOf(s)
  const d = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('shell: syntax-error steer injected (PowerShell text)', d.messages.some((m) => m.content[0].text.includes('shell 检查') && m.content[0].text.includes('PowerShell')),
    'shell steer')
}

// ── 10. delegation advisor ──────────────────────────────────────────────────
{
  const hh = makeHarness()
  const calls = []
  for (let i = 0; i < 5; i++) {
    calls.push({ type: 'tool/call', seq: 10 + i, data: { name: i < 3 ? 'edit' : 'read', arguments: i < 3 ? JSON.stringify({ file_path: 'C:/x/src/shaders.js' }) : '{}' } })
  }
  const s = { id: 's10', events: [
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'step/start', seq: i + 1, data: {} })),
    { type: 'user/message', seq: 9, data: userMsg('u10', '重构这个模块的架构并修复多个 bug') },
    ...calls,
  ] }
  hh.agentOf(s)
  const d = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('delegation: advisor fires for complex edit-heavy session', d.messages.some((m) => m.content[0].text.includes('委派建议')),
    'delegation text')
  for (const m of d.messages.filter((m) => m.source?.kind === 'plugin')) {
    s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  }
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('delegation: idempotent', d2.messages.length === 0, `got ${d2.messages.length}`)
}

// ── 11. strip phase: bootstrap strips only suppressed sources ───────────────
{
  const hh = makeHarness()
  const s = { id: 's11', events: [] }
  const instructions = { id: 'i1', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md digest' }] }
  const batch = [userMsg('u11', '写个脚本'), instructions]
  hh.agentOf(s)
  const d = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: batch }))
  check('strip: agent-instructions removed', !d.messages.some((m) => m.id === 'i1'), 'stripped')
  check('strip: user message kept + guides appended', d.messages.some((m) => m.id === 'u11') && d.messages.length > batch.length - 1,
    `kept, ${d.messages.length} messages`)
}

// ── 12. trace tools ─────────────────────────────────────────────────────────
{
  const hh = makeHarness()
  const s = { id: 's12', events: [{ type: 'user/message', seq: 1, data: userMsg('u12', '写个脚本') }, { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } }] }
  const agent = hh.agentOf(s)
  const names = hh.registered.map((t) => t.name)
  check('tools: trace_status + trace_tune registered', names.includes('trace_status') && names.includes('trace_tune'),
    names.join(','))
  const status = hh.registered.find((t) => t.name === 'trace_status')
  const out = await status.execute()
  check('trace_status: reports band/budget/counters',
    /band=/.test(out) && /truncations=0/.test(out) && /budget=4096/.test(out), out.replace(/\n/g, ' | '))
  const tune = hh.registered.find((t) => t.name === 'trace_tune')
  const tOut = await tune.execute({ cap: '8192' })
  check('trace_tune: explicit cap applies', tOut.includes('8192'), tOut)
  const r = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 4096 }))
  check('trace_tune: explicit cap reaches request listener', r.maxTokens === 8192, `got ${r.maxTokens}`)
}

// ── 13. V2.2: anchor first turn ─────────────────────────────────────────────
{
  const hh = makeHarness()
  const s = { id: 's13', events: [], header: { delegationDepth: 0 } }
  const agent = hh.agentOf(s)
  agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  hh.prepended = []
  const inserted = hh.h('agent/inbox/inserted')[0]
  inserted({ agent, message: userMsg('r1', '请创建一个 3D 场景') })
  check('anchor: prepend fired once for first real message', hh.prepended.length === 1
    && hh.prepended[0].source?.kind === 'plugin' && hh.prepended[0].source?.form === 'notice',
    `${hh.prepended.length} prepended`)
  inserted({ agent, message: userMsg('r2', '第二条消息') })
  check('anchor: no duplicate on second user insert', hh.prepended.length === 1, `${hh.prepended.length}`)
  inserted({ agent, message: { id: 'p1', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'x' }] } })
  check('anchor: plugin messages never trigger', hh.prepended.length === 1, `${hh.prepended.length}`)
  // subagent sessions are never anchored
  const sub = { id: 's13b', events: [], header: { delegationDepth: 1 } }
  const subAgent = hh.agentOf(sub)
  subAgent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  inserted({ agent: subAgent, message: userMsg('r3', '审查代码') })
  check('anchor: subagent sessions skipped', hh.prepended.length === 1, `${hh.prepended.length}`)
  // resumed sessions (existing user/message) never anchored
  const res = { id: 's13c', events: [{ type: 'user/message', seq: 1, data: userMsg('old', '历史消息') }], header: { delegationDepth: 0 } }
  const resAgent = hh.agentOf(res)
  resAgent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  inserted({ agent: resAgent, message: userMsg('r4', '继续') })
  check('anchor: resumed sessions skipped', hh.prepended.length === 1, `${hh.prepended.length}`)
  // anchor phase: assemble exposes ZERO tools until promotion
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [], tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'grep' }], contexts: [],
  }))
  check('anchor: warm-up request carries zero tools', a1.tools.length === 0, `tools=${a1.tools.length}`)
  // after promotion (anchor reply), the full catalog returns
  s.events.push({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '就绪' }] } } })
  const a2 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [], tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'grep' }], contexts: [],
  }))
  check('anchor: promoted request restores tools', a2.tools.length === 5, `tools=${a2.tools.length}`)
}

// ── 14. V2.2: platform profiles ─────────────────────────────────────────────
{
  const win = core.platformProfileFor('win32')
  const posix = core.platformProfileFor('posix')
  check('profile: win32 fields', win.shell === 'pwsh' && win.pathSep === '\\' && win.envStyle === '$env:NAME' && !win.caseSensitive,
    JSON.stringify([win.shell, win.pathSep]))
  check('profile: posix fields', posix.shell === 'bash' && posix.pathSep === '/' && posix.caseSensitive, posix.shell)
  const ws = core.platformSectionFor(win)
  const ps = core.platformSectionFor(posix)
  check('platform section: win32 full text', ws.text.includes('PowerShell') && ws.text.includes('chcp') && ws.text.includes('反斜杠') && ws.text.includes('Get-Process'),
    'win32 text')
  check('platform section: posix text', ps.text.includes('bash') && ps.text.includes('chmod'), 'posix text')
  const winErrs = [
    { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'text', text: 'ls : 无法将“ls”项识别为 cmdlet、函数、脚本文件或可运行程序的名称' }] }, error: { name: 'E', code: 'X' } } },
    { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: 'ls : 无法将“ls”项识别为 cmdlet' }] }, error: { name: 'E', code: 'X' } } },
    { type: 'tool/call', seq: 3, data: { name: 'pwsh', arguments: '{}' } },
  ]
  const posixErrs = [
    { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'text', text: 'bash: ls: command not found' }] }, error: { name: 'E', code: 'X' } } },
    { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: 'ls: command not found' }] }, error: { name: 'E', code: 'X' } } },
    { type: 'tool/call', seq: 3, data: { name: 'bash', arguments: '{}' } },
  ]
  check('shell detect: win32 hits PowerShell errors', core.shellErrorDetect(winErrs, win) === true, 'win32 hit')
  check('shell detect: win32 misses POSIX errors', core.shellErrorDetect(posixErrs, win) === false, 'win32 miss')
  check('shell detect: posix hits command-not-found', core.shellErrorDetect(posixErrs, posix) === true, 'posix hit')
  check('shell detect: posix misses PowerShell errors', core.shellErrorDetect(winErrs, posix) === false, 'posix miss')
  check('shell steer: win32 includes encoding hint', core.shellSteerFor(win).includes('chcp'), 'win32 steer')
  check('shell steer: posix short', core.shellSteerFor(posix).includes('bash'), 'posix steer')
  check('platform override: config wins', core.platformFor({ platform: 'posix' }) === 'posix', 'posix override')
}

// ── 15. V2.2: subagent timeout (C2) + read-only delegation (C1) ─────────────
{
  const now = 1000000
  const t0 = now - 20 * 60000 // started 20 min ago
  const running = [
    { type: 'tool/call', seq: 1, time: t0, data: { name: 'subagent', arguments: '{}' } },
    { type: 'tool/result', seq: 2, time: t0 + 1000, data: { message: { source: { kind: 'tool' } } } },
  ]
  check('subagent timeout: overdue without settled', core.subagentOverdue(running, now, 15 * 60000) === true, 'overdue')
  const settled = [...running, {
    type: 'user/message', seq: 3, time: t0 + 2000,
    data: { source: { kind: 'subagent-settled', form: 'notice' }, content: [{ type: 'text', text: 'done' }] },
  }]
  check('subagent timeout: settled is not overdue', core.subagentOverdue(settled, now, 15 * 60000) === false, 'settled')
  const fresh = [
    { type: 'tool/call', seq: 1, time: now - 5 * 60000, data: { name: 'subagent', arguments: '{}' } },
  ]
  check('subagent timeout: within window not overdue', core.subagentOverdue(fresh, now, 15 * 60000) === false, 'fresh')
  check('C1: delegation section has read-only discipline', core.DELEGATION_SECTION.text.includes('只读'), 'section')
  check('C1: delegation guide has read-only discipline', core.GUIDE_DELEGATION.includes('只读'), 'guide')
  // pre-step integration: overdue subagent injects once, then idempotent
  const hh = makeHarness()
  const s = { id: 's15', events: running.map((e, i) => ({ ...e, seq: i + 1 })) }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('subagent timeout: steer injected', d1.messages.some((m) => m.content[0].text.includes('子代理超时')),
    'steer')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('subagent timeout: idempotent', !d2.messages.some((m) => m.content[0].text.includes('子代理超时')),
    'no repeat')
}

// ── 16. V2.2: C3 initiator cross-talk guard ─────────────────────────────────
{
  const hh = makeHarness()
  const sA = { id: 'sA', events: [] }
  const sB = { id: 'sB', events: [] }
  const aA = hh.agentOf(sA)
  const aB = hh.agentOf(sB)
  // assemble for both sessions; the LAST assemble must win the recent map
  await hh.h('system-prompt/assemble')[0](null, { agent: aA }, async () => ({ sections: [], tools: [], contexts: [] }))
  await hh.h('system-prompt/assemble')[0](null, { agent: aB }, async () => ({ sections: [], tools: [], contexts: [] }))
  // ctx.get('agent') returns the last-created agent (aB); its session has a
  // recent entry, so the pre-step must resolve to aB — not aA.
  const d = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [userMsg('uA', '写个脚本')] }))
  const guide = d.messages.filter((m) => m.source?.kind === 'plugin' && m.content[0].text.includes('Cadence：'))
  check('C3: initiator resolves to its own recent agent', guide.length >= 1, `guide=${guide.length}`)
}

// ── 17. V2.3: todo sync ─────────────────────────────────────────────────────
{
  const mkCalls = (n, edits) => Array.from({ length: n }, (_, i) => ({
    type: 'tool/call', seq: 100 + i, data: { name: i < edits ? 'edit' : 'pwsh', arguments: '{}' },
  }))
  const todoEv = (seq, statuses) => ({ type: 'todo/write', seq, data: { todos: statuses.map((s, i) => ({ content: `任务${i}`, status: s })) } })
  const cfg = { todoSyncAfterSteps: 12 }
  check('todo sync: no todo → 0', core.todoStale([], cfg) === 0, '0')
  check('todo sync: too few calls → 0', core.todoStale([todoEv(1, ['pending'])], cfg) === 0, '0')
  check('todo sync: stale mid-run → 1',
    core.todoStale([todoEv(1, ['pending', 'pending']), ...mkCalls(15, 4)], cfg) === 1, '1')
  check('todo sync: completed but new edits → 2',
    core.todoStale([todoEv(1, ['completed', 'completed']), ...mkCalls(12, 6)], cfg) === 2, '2')
  check('todo sync: completed without new edits → 0',
    core.todoStale([todoEv(1, ['completed', 'completed']), ...mkCalls(12, 1)], cfg) === 0, '0')
  // integration: inject once, then idempotent
  const hh = makeHarness()
  const s = { id: 's17', events: [todoEv(1, ['pending', 'pending']), ...mkCalls(15, 4)] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('todo sync: steer injected (stale)', d1.messages.some((m) => m.content[0].text.includes('todo 同步') && m.content[0].text.includes('待办快照仍停留在')),
    'stale steer')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('todo sync: idempotent', !d2.messages.some((m) => m.content[0].text.includes('todo 同步')), 'no repeat')
}

// ── 18. V2.3: remaining optimizations ───────────────────────────────────────
{
  // C2 fix: settled arrives as user/message with source.kind === 'subagent-settled'
  const now = 1_000_000
  const t0 = now - 20 * 60000
  const started = [{ type: 'tool/call', seq: 1, time: t0, data: { name: 'subagent', arguments: '{}' } }]
  const settledNotice = [...started, {
    type: 'user/message', seq: 2, time: t0 + 1000,
    data: { source: { kind: 'subagent-settled', form: 'notice' }, content: [{ type: 'text', text: 'finished' }] },
  }]
  check('C2 fix: settled notice (user/message) clears overdue', core.subagentOverdue(settledNotice, now, 15 * 60000) === false, 'settled')
  check('C2 fix: no notice still overdue', core.subagentOverdue(started, now, 15 * 60000) === true, 'overdue')

  // classifier: error-report keywords
  check('classifier: 打不开/异常 → complex', core.isComplexTask('WebGL异常，打不开网页') === true, 'cn error words')
  check('classifier: crash/blank → complex', core.isComplexTask('the page shows a blank screen and crashes') === true, 'en error words')

  // delegation: high-risk module targeting (V2.3.1: enhancement, not gate)
  const mkEdit = (seq, fp) => ({ type: 'tool/call', seq, data: { name: 'edit', arguments: JSON.stringify({ file_path: fp }) } })
  const base = [
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'step/start', seq: i + 1, data: {} })),
    mkEdit(10, 'C:/x/src/shaders.js'),
    mkEdit(11, 'C:/x/src/shaders.js'),
    mkEdit(12, 'C:/x/src/engine.js'),
  ]
  check('delegation: shader edits warrant review (generic)', core.delegationWarranted(base) === true, 'warranted')
  check('delegation: riskyModuleHit selects targeted variant', core.riskyModuleHit(base) === true, 'risky hit')
  const plain = [
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'step/start', seq: i + 1, data: {} })),
    mkEdit(10, 'C:/x/src/app.js'),
    mkEdit(11, 'C:/x/src/app.js'),
    mkEdit(12, 'C:/x/src/util.js'),
  ]
  check('delegation: plain edits still warrant generic review (de-specialized)', core.delegationWarranted(plain) === true, 'warranted')
  check('delegation: plain edits no risky hit', core.riskyModuleHit(plain) === false, 'no risky')
  // integration: plain session gets generic text, risky session gets targeted text
  const hhD = makeHarness()
  const sD = { id: 'sD1', events: [
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'step/start', seq: i + 1, data: {} })),
    { type: 'user/message', seq: 9, data: userMsg('uD', '重构这个模块的架构并修复多个 bug') },
    mkEdit(10, 'C:/x/src/app.js'), mkEdit(11, 'C:/x/src/app.js'), mkEdit(12, 'C:/x/src/util.js'),
  ] }
  hhD.agentOf(sD)
  const dD1 = await hhD.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  const dlg = dD1.messages.find((m) => m.content[0].text.includes('委派建议'))
  check('delegation: plain session gets generic text', dlg !== undefined && !dlg.content[0].text.includes('数值计算'), 'generic')
  const sR = { id: 'sD2', events: [
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'step/start', seq: i + 1, data: {} })),
    { type: 'user/message', seq: 9, data: userMsg('uR', '重构这个模块的架构并修复多个 bug') },
    mkEdit(10, 'C:/x/src/shaders.js'), mkEdit(11, 'C:/x/src/math.js'), mkEdit(12, 'C:/x/src/engine.js'),
  ] }
  hhD.agentOf(sR)
  const dR1 = await hhD.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  const dlgR = dR1.messages.find((m) => m.content[0].text.includes('委派建议'))
  check('delegation: risky session gets targeted text', dlgR !== undefined && dlgR.content[0].text.includes('数值计算'), 'targeted')

  // visual depth: fires only after vision was used; idempotent
  const hh = makeHarness()
  const s = { id: 's18', events: [{ type: 'tool/call', seq: 1, data: { name: 'vision', arguments: '{}' } }] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('visual depth: steer injected after vision use', d1.messages.some((m) => m.content[0].text.includes('视觉深化')),
    'visual steer')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('visual depth: idempotent', !d2.messages.some((m) => m.content[0].text.includes('视觉深化')), 'no repeat')
  const sNoV = { id: 's18b', events: [] }
  hh.agentOf(sNoV)
  const d3 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('visual depth: never fires without vision use', !d3.messages.some((m) => m.content[0].text.includes('视觉深化')), 'no vision')

  // trace_style indicators
  const ti = core.trajectoryIndicators([
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'reasoning', text: 'we need a plan. let me recall the formula. let me verify by reading.' }] } } },
  ])
  check('trace_style: we/letMe counted', ti.wePer10k > 0 && ti.letMePer10k > 0, JSON.stringify(ti.letMeVerifyShare))
  check('trace_style: verify share high', ti.letMeVerifyShare >= 66, `${ti.letMeVerifyShare}%`)
}

console.log(results.join('\n'))
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`)
