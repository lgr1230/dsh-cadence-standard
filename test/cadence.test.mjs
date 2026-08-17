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
  check('persona: complex has decision-ending', cp.includes('end each reasoning block with a decision'), 'complex')
  check('persona: no flash anchors', !cp.includes('review what you have already done'), 'no anchors')
  check('persona: no file-discipline sentence', !cp.includes('read it first'), 'no discipline')
  check('persona: no env enumeration', !cp.includes('py -0p'), 'no env words')
}

// ── 3. guides: full every message, relaxed wording ──────────────────────────
{
  check('guide: simple text', core.GUIDE_SIMPLE.includes('直接任务'), 'simple guide')
  check('guide: complex carries input-driven comparison', core.GUIDE_COMPLEX.includes('输入驱动') && core.GUIDE_COMPLEX.includes('闭路自造'), 'method text')
  check('guide: complex carries relaxed env-stuck', core.GUIDE_COMPLEX.includes('命令失败≠能力缺失'), 'env-stuck text')
  check('guide: relaxed — no tool-name enumeration', !core.GUIDE_COMPLEX.includes('py -0p') && !core.GUIDE_COMPLEX.includes('uv-conda'), 'relaxed')
  check('guide: lite removed', core.GUIDE_COMPLEX_LITE === undefined, 'no lite')
  const hh = makeHarness()
  const s = { id: 's3', events: [{ type: 'user/message', seq: 1, data: userMsg('u1', complexText) }] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [userMsg('u2', complexText)] }))
  const fulls = d1.messages.filter((m) => m.content?.[0]?.text?.includes('这是一个复杂任务')).length
  check('guide: every complex message gets the FULL guide', fulls === 1, `full guides=${fulls}`)
}

// ── 4. anchor + warm-up + narrow first-task surface + promotion ─────────────
{
  const hh = makeHarness()
  const s = { id: 's4', events: [], header: { delegationDepth: 0 } }
  const agent = hh.agentOf(s)
  agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
  hh.prepended = []
  const inserted = hh.h('agent/inbox/inserted')[0]
  inserted({ agent, message: userMsg('r1', complexText) })
  check('anchor: prepend fired once for first real message', hh.prepended.length === 1
    && hh.prepended[0].source?.kind === 'plugin', `${hh.prepended.length} prepended`)
  inserted({ agent, message: userMsg('r2', '第二条消息') })
  check('anchor: no duplicate on second insert', hh.prepended.length === 1, `${hh.prepended.length}`)
  inserted({ agent, message: { source: { kind: 'plugin' } } })
  check('anchor: plugin messages never trigger', hh.prepended.length === 1, 'plugin ignored')

  // Warm-up assembly: 0 tools.
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [{ name: 'read' }, { name: 'edit' }, { name: 'pwsh' }], contexts: [],
  }))
  check('warm-up: zero tools', a1.tools.length === 0, `tools=${a1.tools.length}`)
  check('warm-up: simple persona', a1.sections.find((x) => x.name === 'cadence-persona').text.includes('Match your effort'), 'simple persona')

  // Warm-up request: anchor cap 2048.
  const r1 = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('warm-up: request capped at 2048', r1.maxTokens === 2048, `got ${r1.maxTokens}`)

  // First TASK request (user message now committed): narrow complex core + complex persona.
  s.events.push({ type: 'user/message', seq: 10, data: userMsg('t1', complexText) })
  const a2 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' },
      { name: 'write' }, { name: 'vision' }, { name: 'web_search' }, { name: 'subagent' },
    ], contexts: [],
  }))
  const taskTools = a2.tools.map((t) => t.name).sort()
  check('task request: narrow core surface', JSON.stringify(taskTools) === JSON.stringify(['edit', 'glob', 'grep', 'pwsh', 'read'].sort()), `got ${taskTools.join(',')}`)
  check('task request: complex persona (lag fixed)', a2.sections.find((x) => x.name === 'cadence-persona').text.includes('end each reasoning block with a decision'), 'complex persona')
  const r2 = await hh.h('agent/request')[0]({ agent }, async () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  check('task request: no cap', r2.maxTokens === 256000, `got ${r2.maxTokens}`)

  // First tool call → promoted → RESIDENT surface (web_search not resident → filtered; vision IS resident).
  s.events.push({ type: 'tool/call', seq: 20, data: { name: 'read', arguments: '{}' } })
  const a3 = await hh.h('system-prompt/assemble')[0](null, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [{ name: 'read' }, { name: 'write' }, { name: 'vision' }, { name: 'pwsh' }, { name: 'web_search' }], contexts: [],
  }))
  check('promoted: resident surface (vision resident, web_search filtered)',
    JSON.stringify(a3.tools.map((t) => t.name).sort()) === JSON.stringify(['pwsh', 'read', 'vision', 'write'].sort()),
    `tools=${a3.tools.map((t) => t.name).join(',')}`)
}

// ── 5. promotion: tool-call only (warm-up reply does NOT promote) ───────────
{
  const hh = makeHarness()
  const s = { id: 's5', events: [{ type: 'assistant/message', seq: 1, data: { message: { content: [] } } }] }
  hh.agentOf(s)
  const a1 = await hh.h('system-prompt/assemble')[0](null, { agent: hh.agentOf(s) }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }, { name: 'web_search' }],
    contexts: [],
  }))
  check('promotion: assistant message alone does NOT promote', a1.tools.length === 4,
    `tools=${a1.tools.length} (narrow read/write/edit+pwsh)`)
  s.events.push({ type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } })
  const a2 = await hh.h('system-prompt/assemble')[0](null, { agent: hh.agentOf(s) }, async () => ({
    sections: [{ name: 'persona', text: 'x' }],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }, { name: 'web_search' }],
    contexts: [],
  }))
  check('promotion: tool call promotes to resident set (vision resident)', a2.tools.length === 5
    && a2.tools.some((t) => t.name === 'vision') && !a2.tools.some((t) => t.name === 'web_search'),
    `tools=${a2.tools.length} (resident read/write/edit+pwsh+vision; web_search filtered)`)
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
  check('final: ≥8 steps after write → true', core.finalCheckDue([...mkSteps(3), writeEv, ...mkSteps(9, 60), userMsgEv(99)], {}) === true, 'due')
  check('final: relaxed text carries contrast principle', core.STEER_FINAL_CHECK.includes('对照参考核验') && core.STEER_FINAL_CHECK.includes('仅下载或检索不算'), 'contrast+flow')
  check('final: relaxed text carries self-score line', core.STEER_FINAL_CHECK.includes('自评或外部评分不等于交付依据'), 'score line')
  const hh = makeHarness()
  const s = { id: 's6', events: [
    ...mkSteps(14),
    { type: 'user/message', seq: 20, data: userMsg('task', complexText) },
    writeEv,
    ...mkSteps(9, 70),
  ] }
  hh.agentOf(s)
  const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('checkpoints: reflection injected', d1.messages.some((m) => m.content[0].text.includes('Cadence 自省')), 'reflection')
  check('checkpoints: final check injected', d1.messages.some((m) => m.content[0].text.includes('Cadence 验收')), 'final')
  for (const m of d1.messages.filter((m) => m.source?.kind === 'plugin')) s.events.push({ type: 'user/message', seq: s.events.length + 1, data: m })
  const d2 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('checkpoints: idempotent', !d2.messages.some((m) => m.content[0].text.includes('Cadence 自省') || m.content[0].text.includes('Cadence 验收')), 'no repeat')
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
  check('converge: steer injected via pre-step', d1.messages.some((m) => m.content[0].text.includes('Cadence 收敛')), 'steer')
}

// ── 11. reloader + trace_status (lean) ──────────────────────────────────────
{
  const rel = await import('../preset/cadence-reloader.mjs')
  check('reloader: shape', rel.name === 'cadence-reloader' && rel.inject.includes('loader') && typeof rel.apply === 'function', 'shape')
  const hh = makeHarness()
  const s = { id: 's11', events: [{ type: 'user/message', seq: 1, data: userMsg('u11', '写个脚本') }, { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } }] }
  hh.agentOf(s)
  const names = hh.registered.map((t) => t.name)
  check('tools: trace_status + tool_search registered',
    JSON.stringify(names.sort()) === JSON.stringify(['tool_search', 'trace_status'].sort()), names.join(','))
  const status = hh.registered.find((t) => t.name === 'trace_status')
  const out = await status.execute()
  check('trace_status: lean fields', /build=v4\.5/.test(out) && /blockP50=0/.test(out) && !/band=|budget=|frequent=|requested=/.test(out), out.replace(/\n/g, ' | '))
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
      { name: 'dev_inject_plugin' }, { name: 'workflow' }, { name: 'trace_status' }, { name: 'tool_search' },
    ],
    contexts: [],
  }))
  const names = a1.tools.map((t) => t.name)
  check('R1: resident + unlocked (vision) visible', names.includes('read') && names.includes('ask_user_question')
    && names.includes('vision') && names.includes('tool_search'), names.join(','))
  check('R1: heavy tools filtered until unlocked', !names.includes('web_search') && !names.includes('dev_inject_plugin')
    && !names.includes('workflow'), names.join(','))

  // R1: subagents keep the full catalog.
  const sub = { id: 's12s', header: { delegationDepth: 1 }, events: [] }
  const agentS = hh.agentOf(sub)
  const aS = await hh.h('system-prompt/assemble')[0](null, { agent: agentS }, async () => ({
    sections: [{ name: 'persona', text: 'x' }], tools: [{ name: 'read' }, { name: 'dev_inject_plugin' }, { name: 'workflow' }], contexts: [],
  }))
  check('R1: subagent keeps full catalog', aS.tools.length === 3, `tools=${aS.tools.length}`)

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
    tools: [{ name: 'read' }, { name: 'vision' }, { name: 'web_search' }, { name: 'ask_user_question' }, { name: 'tool_search' }],
    contexts: [],
  }))
  const cNames = aC.tools.map((t) => t.name)
  check('R2: post-compaction → resident only (vision stays resident, unlocked filtered)',
    cNames.includes('read') && cNames.includes('ask_user_question')
    && cNames.includes('vision') && !cNames.includes('web_search'), cNames.join(','))

  // R3: bootstrap-phase strip + instruction hint.
  const hh3 = makeHarness()
  const s3 = { id: 's12d', events: [{ type: 'user/message', seq: 1, data: userMsg('u', complexText) }] }
  hh3.agentOf(s3)
  const d1 = await hh3.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [
    userMsg('m1', '任务'),
    { id: 'instr', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS digest' }] },
    { id: 'skill', role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skills' }] },
  ] }))
  const kinds = d1.messages.map((m) => m.source?.kind)
  check('R3: bootstrap strips injected context', !kinds.includes('agent-instructions') && !kinds.includes('skill-catalog')
    && kinds.includes('user'), kinds.join(','))
  // R3: AFTER promotion the strip is OFF (injected context passes through).
  const hh3b = makeHarness()
  const s3b = { id: 's12db', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
  ] }
  hh3b.agentOf(s3b)
  const d1b = await hh3b.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [
    userMsg('m1', '任务'),
    { id: 'instr', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS digest' }] },
  ] }))
  const kindsB = d1b.messages.map((m) => m.source?.kind)
  check('R3: promoted phase does NOT strip injected context', kindsB.includes('agent-instructions'), kindsB.join(','))
  const hh4 = makeHarness()
  const s4 = { id: 's12e', events: [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
  ] }
  hh4.agentOf(s4)
  const d2 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('R3: instruction hint injected once after promotion',
    d2.messages.some((m) => m.content?.[0]?.text?.includes('Cadence 指令提示')), 'hint')
  for (const m of d2.messages.filter((m) => m.source?.kind === 'plugin')) s4.events.push({ type: 'user/message', seq: s4.events.length + 100, data: m })
  const d3 = await hh4.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [] }))
  check('R3: hint idempotent', !d3.messages.some((m) => m.content?.[0]?.text?.includes('Cadence 指令提示')), 'no repeat')
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
    check('F1: complex core on the very first request (no event yet)',
      JSON.stringify(names(a1).sort()) === JSON.stringify(['edit', 'glob', 'grep', 'pwsh', 'read']), names(a1).join(','))
    check('F1: complex persona on the very first request',
      a1.sections.find((x) => x.name === 'cadence-persona').text.includes('end each reasoning block with a decision'), 'complex persona')
  }
  // F1: warm-up stays 0 tools + SIMPLE persona even after complex pre-classify.
  {
    const hh = makeHarness()
    const s = { id: 's13w', events: [] }
    const agent = hh.agentOf(s)
    agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
    hh.prepended = []
    hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r1', complexText) })
    const w1 = await assemble(hh, agent, [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }])
    check('F1: warm-up 0 tools + simple persona',
      w1.tools.length === 0 && w1.sections.find((x) => x.name === 'cadence-persona').text.includes('Match your effort'),
      `tools=${w1.tools.length}`)
  }
  // F1: simple insert does NOT upgrade; plugin insert never classifies.
  {
    const hh = makeHarness()
    const s = { id: 's13s', events: [] }
    const agent = hh.agentOf(s)
    hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r1', simpleText) })
    const a1 = await assemble(hh, agent, [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }])
    check('F1: simple insert → simple core (4 tools)', names(a1).length === 4 && !names(a1).includes('vision'), names(a1).join(','))
    const hh2 = makeHarness()
    const s2 = { id: 's13p', events: [] }
    const agent2 = hh2.agentOf(s2)
    hh2.h('agent/inbox/inserted')[0]({ agent: agent2, message: { source: { kind: 'plugin' }, content: [{ type: 'text', text: complexText }] } })
    const a2 = await assemble(hh2, agent2, [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }, { name: 'vision' }])
    check('F1: plugin insert never classifies', names(a2).length === 4, names(a2).join(','))
  }

  // F1: the warm-up pre-step (batch contains no user message → effectiveClass
  // simple) must NOT downgrade the inserted pre-classification.
  {
    const hh = makeHarness()
    const s = { id: 's13m', events: [] }
    const agent = hh.agentOf(s)
    agent.inbox.prepend = (_t, m) => hh.prepended.push(m)
    hh.prepended = []
    hh.h('agent/inbox/inserted')[0]({ agent, message: userMsg('r1', complexText) })
    // warm-up assemble consumes anchorZeroTools, then the warm-up pre-step
    // runs (batch contains only plugin messages → effectiveClass simple).
    const w1 = await assemble(hh, agent, [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }])
    check('F1: warm-up assemble 0 tools before pre-step', w1.tools.length === 0, 'warm-up')
    const d1 = await hh.h('agent/pre-step')[0]({}, async () => ({ kind: 'enter', messages: [
      { id: 'w', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Cadence 热身' }] },
    ] }))
    check('F1: warm-up pre-step does not downgrade complex', d1 !== undefined, 'ran')
    const a1 = await assemble(hh, agent, [
      { name: 'read' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' }, { name: 'pwsh' }, { name: 'write' },
    ])
    check('F1: complex survives warm-up pre-step → complex core',
      JSON.stringify(names(a1).sort()) === JSON.stringify(['edit', 'glob', 'grep', 'pwsh', 'read']), names(a1).join(','))
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
      { name: 'vision' }, { name: 'read' }, { name: 'pwsh' }, { name: 'web_search' }, { name: 'tool_search' }, { name: 'subagent' },
    ])
    check('V4.3: vision in promoted surface (resident)', names(a1).includes('vision') && !names(a1).includes('web_search'), names(a1).join(','))
    check('V4.3: request_tool NOT registered', hh.registered.find((t) => t.name === 'request_tool') === undefined, 'removed')
    // post-compaction: vision stays (resident).
    const sC = { id: 's13visc', events: [
      { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
      { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
      { type: 'compaction/end', seq: 10, data: { compactionId: 'c', turn: null } },
    ] }
    const agentC = hh.agentOf(sC)
    const aC = await assemble(hh, agentC, [{ name: 'read' }, { name: 'vision' }, { name: 'web_search' }, { name: 'tool_search' }])
    check('V4.3: vision stays in post-compaction surface', names(aC).includes('vision') && !names(aC).includes('web_search'), names(aC).join(','))
  }

  // V4.3 (F4): finalCheckDue counts the in-flight step — a session ending
  // exactly `finalCheckAfterSteps` steps after its last write still fires.
  {
    const mkSteps = (n, startSeq = 1) => Array.from({ length: n }, (_, i) => ({ type: 'step/start', seq: startSeq + i, data: {} }))
    const writeEv = { type: 'tool/call', seq: 50, data: { name: 'write', arguments: '{}' } }
    // 7 steps after the write → not yet (7+1=8 < 8? no: 8 >= 8 → due at 7!)
    check('F4: 6 steps after write → false', core.finalCheckDue([...mkSteps(3), writeEv, ...mkSteps(6, 60)], {}) === false, '6 steps')
    check('F4: 7 steps after write → true (in-flight step counts)', core.finalCheckDue([...mkSteps(3), writeEv, ...mkSteps(7, 60)], {}) === true, '7 steps')
  }
}

// ── 14. V4.3/V4.4: verification texts + resident additions ────────────────
{
  check('V4.3: real-form line in reflection', core.STEER_REFLECTION.includes('真实形态'), 'reflection ④ real-form')
  check('V4.3: real-form lines in final check', core.STEER_FINAL_CHECK.includes('完整形态')
    && core.STEER_FINAL_CHECK.includes('真实形态') && core.STEER_FINAL_CHECK.includes('字符摘要'), 'final check')
  check('V4.3: no failure-turn remnants', core.STEER_FAILURE_TURN === undefined
    && !core.STEER_FINAL_CHECK.includes('连续失败'), 'no F5')

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
  check('V4.4: todo_write in promoted surface (resident)', n.includes('todo_write') && n.includes('vision') && !n.includes('web_search'), n.join(','))

  // V4.1 R1: tool_search execute behavior (catalog from assemble, query filter).
  const hhT = makeHarness()
  const sT = { id: 's14t', events: [{ type: 'tool/call', seq: 1, data: { name: 'read', arguments: '{}' } }] }
  hhT.agentOf(sT)
  await hhT.h('system-prompt/assemble')[0](null, { agent: hhT.agentOf(sT) }, async () => ({
    sections: [], tools: [{ name: 'vision', description: 'look at images' }, { name: 'read', description: 'read files' }, { name: 'pwsh', description: 'run shell' }], contexts: [],
  }))
  const ts = hhT.registered.find((t) => t.name === 'tool_search')
  const out1 = await ts.execute({ query: 'image' })
  check('R1: tool_search finds by description', out1.includes('vision') && !out1.includes('read'), out1.replace(/\n/g, ' | '))
  const out2 = await ts.execute({ query: 'no-such-tool' })
  check('R1: tool_search miss returns empty note', out2.includes('no tools match'), out2)
}

// ── 15. V4.5: token-AND tool_search + means-level detection ─────────────────
{
  // matchCatalog: token-AND semantics (session-19 regression: "vision image"
  // was a whole-string substring and never matched).
  const cat = [
    { name: 'vision', description: 'Analyze one or more images through an external vision-language model (VLM) and return a plain-text description.' },
    { name: 'read', description: 'Read a UTF-8 text file.' },
    { name: 'pwsh', description: 'Execute a PowerShell command.' },
  ]
  check('V4.5: "vision image" matches vision (regression)', core.matchCatalog('vision image', cat).some((t) => t.name === 'vision'), 'vision image')
  check('V4.5: "vision image" excludes read', !core.matchCatalog('vision image', cat).some((t) => t.name === 'read'), 'no read')
  check('V4.5: multi-word AND "vision analyze description" matches', core.matchCatalog('vision analyze description', cat).some((t) => t.name === 'vision'), '3 words')
  check('V4.5: unrelated words miss', core.matchCatalog('screenshot photo', cat).length === 0, 'miss')
  check('V4.5: empty query returns empty', core.matchCatalog('', cat).length === 0, 'empty q')
  check('V4.5: empty catalog returns empty', core.matchCatalog('vision', []).length === 0, 'empty cat')

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

  // Soft layer threshold: 3 runs / 5 min fires the soft steer (hard silent).
  const softRuns = slowRuns.slice(0, 6)
  const softInj = core.pendingInjections({
    events: [{ type: 'user/message', seq: 1, data: userMsg('u', complexText) }, { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } }, ...softRuns],
    batchMessages: [], cls: 'complex', promoted: true, cfg: {}, nowMs: 0,
  })
  const softTexts = softInj.map((i) => i.text).join(' ')
  check('V4.5: 3 slow failing runs → cost steer only', softTexts.includes('Cadence 手段成本') && !softTexts.includes('Cadence 手段复查'), 'soft only')

  // pendingInjections: markers injected once, idempotent.
  const base = [
    { type: 'user/message', seq: 1, data: userMsg('u', complexText) },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: '{}' } },
    ...slowRuns,
  ]
  const inj1 = core.pendingInjections({ events: base, batchMessages: [], cls: 'complex', promoted: true, cfg: {}, nowMs: 0 })
  const texts1 = inj1.map((i) => i.text).join(' ')
  check('V4.5: unconverged steer injected', texts1.includes('Cadence 手段复查') && texts1.includes('重新评估该手段本身'), 'hard steer')
  check('V4.5: cost steer NOT injected when hard fires', !texts1.includes('Cadence 手段成本'), 'no soft when hard')
  const withCost = [...base, ...inj1.filter((i) => i.marker).map((i) => ({ type: 'user/message', seq: 999, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: i.text }] } }))]
  const inj2 = core.pendingInjections({ events: withCost, batchMessages: [], cls: 'complex', promoted: true, cfg: {}, nowMs: 0 })
  check('V4.5: steer idempotent', !inj2.some((i) => i.marker === 'Cadence 手段复查'), 'idempotent')
}

console.log(results.join('\n'))
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`)
