# dsh-cadence-standard

一个实验性的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
智能体预设：对整个会话的思考预算进行节奏管理 —— **Cadence Standard v4.5**（思考预算节奏，LEAN）。

这是一个社区项目，并非 DeepSeek 官方预设，与 DeepSeek 无隶属或背书关系。

## 引用说明

本预设参考了以下开源工作：

- [`yjh051108/dsh-router-standard`](https://github.com/yjh051108/dsh-router-standard)（MIT）——预设结构、首轮锚定机制与 agent 可见调优思路。
- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)（MIT）——首轮锚定机制（零工具热身轮、窄首请求）基于其 bootstrap filter。
- [`chenmzh/dsh-orchestrator-standard`](https://github.com/chenmzh/dsh-orchestrator-standard)——常驻工具目录、压缩纪元与 pre-execute 拒绝模式。

详见 [NOTICE](./NOTICE)。

## 功能说明

Cadence Standard 通过 agent pre-step 瀑布流注入静态、幂等的引导文本，并暴露只读诊断工具（`trace_status`、`tool_search`）与内置热重载工具（`cadence_reload`）。预设本身**不注册任何 fs/shell/权限工具**。

| 机制 | 说明 |
|---|---|
| **锚定首轮** | 真实任务开始前先执行一个零工具、低预算的热身轮（"Cadence 热身"），消除首轮思考停滞。 |
| **首请求分类修复（F1）** | 任务在 inbox 插入时即完成预分类，首个任务请求就携带复杂 persona + 复杂核心工具面（消除"简单 persona 配复杂引导"的信号矛盾）。 |
| **首任务窄面** | `promoteOn: tool-call`——热身回复不触发提升；首个任务请求运行在窄核心面（read/edit/glob/grep + shell），首次工具调用后提升。 |
| **单调分类** | 默认 simple；复杂永久升级。pre-step 批感知；绝不下调（热身 pre-step 不会抹掉预分类状态）。 |
| **常驻目录（R1）** | 提升后工具面停留在常驻集：核心工作工具 + `vision` + `todo_write` + 安全阀（subagent/ask_user_question/list_agents/interrupt_agent/send_message）+ 预设工具。较重工具经 `tool_search` 发现、首次使用后解锁。仅条件化——沙箱/审批栈才是安全边界。 |
| **压缩纪元（R2）** | 成功压缩后工具面回落至常驻集，直到边界之后出现新进展。 |
| **引导期剥离 + 指令提示（R3）** | 引导期剥离自动注入上下文（agent-instructions / skill-catalog）；提升后注入一次简短静态指令提示，取代完整 AGENTS.md 摘要。 |
| **进程自我保护（R4）** | 会终止/重启 harness 进程本身的 shell 命令在 `tools/pre-execute`（原生 deny）被拦截，直到用户确认。 |
| **每消息引导** | 每条真实用户消息获得一条引导：复杂任务为完整的"输入驱动方法对比"（数据/参考驱动 vs 闭路自造），简单任务为一句直行提示。 |
| **元认知检查点** | 任务中自省（四问，含真实形态验证）+ 交付前验收（对照任务原文逐项核对；必须作用于产物完整形态）。 |
| **手段成本引导（V4.5）** | 同一执行/验证手段多次未成功且累计耗时较长时（默认 3 次 / 5 分钟，复杂任务），注入一次"评估手段本身"的提醒——单次成本、受限运行方式、可缩小范围、更低成本替代路径。 |
| **手段复查（V4.5）** | 硬性兜底（默认 5 次 / 15 分钟，任意任务）：同一手段重复多次、累计耗时很长、最近一次仍失败时，要求重新评估手段本身（成本/运行方式/范围/替代路径），而非只加大预算。按手段指纹（平台命令 + 首个脚本路径）统计，穿插写入不重置；累计耗时为门槛，快速重试不误伤。基于 6 个已记录会话校准（19 号在第 5 轮触发，约省 50 分钟；05/06/16/17/18 全部静默）。 |
| **推理块收敛转向** | 会话运行中推理块中位数越过 2500 时注入一次"收敛"提示（基于 11 个已记录会话校准）。 |
| **验证过的死锁阶梯** | 怀疑 (L1) → 指纹验证 (L2) → 通过 `ask_user_question` 暂停询问 (L3) → 有界提醒 (L3b) → 可选升级 (L4，plan-mode 安全，cancel 不带指令)。 |
| **子代理超时提醒** | 委派的子代理运行过久时提醒（默认 15 分钟，感知已结算状态）。 |
| **热代码重载** | `cadence_reload` 从临时副本验证预设模块、清除 Node ESM 缓存并更新组合戳——下一个新会话挂载新代码，无需重启。 |
| **诊断** | `trace_status`（会话状态：复杂度、阶段、自我保护统计、块 p50、转向计数）与 `tool_search`（全工具目录发现）——均为只读。 |

所有注入均为静态文本、幂等（持久标记），并经 `agent/pre-step` 瀑布流路由。

## 安装

DSH 从 `~/.dsh/.agent-presets/<name>/` 加载预设。将本仓库 `preset/` 目录内容复制过去：

```powershell
# Windows (PowerShell)
$dst = "$env:USERPROFILE\.dsh\.agent-presets\cadence-standard"
New-Item -ItemType Directory -Force -Path $dst
Copy-Item -Recurse -Force .\preset\* $dst
```

```bash
# macOS / Linux
mkdir -p ~/.dsh/.agent-presets/cadence-standard
cp -r preset/* ~/.dsh/.agent-presets/cadence-standard/
```

`agent.cordis.yml` 的配置值在每次会话加入时重新读取——新会话立即生效，无需重启。代码文件（`cadence-core.mjs` / `cadence-bootstrap.mjs` / `cadence-reloader.mjs`）每个进程只加载一次（ES module 缓存）：在任意会话中运行 `cadence_reload` 即可热重载（先验证后生效，下一个新会话挂载新代码），或重启 harness。在 DSH Web GUI 中为会话选择 `Cadence Standard (experimental)` 预设（order 6）。

## 配置

`preset/agent.cordis.yml` → `cadence-bootstrap` 的关键选项：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `anchorFirstTurn` | `true` | 启用零工具热身轮 |
| `anchorCapMaxTokens` | 2048 | 唯一剩余的 cap：热身请求 |
| `promoteOn` | `tool-call` | 提升触发：`tool-call` \| `assistant-message` \| `either` |
| `reflectionAfterSteps` | 12 | 自省触发的步数阈值 |
| `finalCheckAfterSteps` | 8 | 最后一次 write 后验收触发的步数阈值 |
| `residentTools` | （17 个工具） | 提升后的常驻目录（仅条件化） |
| `subagentTimeoutMin` | 15 | 子代理超时提醒 |
| `blockP50Threshold` | 2500 | 收敛转向阈值（推理块中位数） |
| `escalateAfterIgnore` | `false` | 反复忽略后的 L4 升级（plan-mode 安全） |
| `meansCostAdvisor` / `meansCostRuns` / `meansCostMinSec` | `true` / 3 / 300 | 手段成本软引导（复杂任务；次数 / 累计秒数） |
| `unconvergedDetector` / `unconvergedRuns` / `unconvergedMinSec` | `true` / 5 / 900 | 手段复查硬兜底（任意任务；次数 / 累计秒数） |

## 测试

```bash
npm test        # node --test（test/cadence.test.mjs，138 项断言）
npm run check   # 语法检查预设模块后运行测试
```

测试套件用最小 fake Cordis 上下文练习 bootstrap 注册的每个监听器，并覆盖核心检测逻辑的纯函数测试：分类、persona、引导、锚定 + F1 预分类、提升、常驻目录 + 压缩纪元 + 剥离/提示、元认知检查点、死锁阶梯 L1–L4 全链、进程自我保护矩阵、子代理超时、收敛转向（fixture + 校准）、验证文本、手段检测（V4.5，含 19 号回归）、重载器 + trace_status + tool_search。

## License

[MIT](./LICENSE)
