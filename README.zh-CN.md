# dsh-cadence-standard

[English](./README.md)

一个实验性的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
智能体预设：对整个会话的思考预算进行节奏管理 —— **Cadence Standard v2.3.1**（思考预算节奏）。

这是一个社区项目，并非 DeepSeek 官方预设，与 DeepSeek 无隶属或背书关系。

## 作者

- **xiaobright** — 作者与维护者
- GitHub：[lgr1230](https://github.com/lgr1230)
- 联系：在本仓库提交 Issue

## 功能说明

Cadence Standard 通过 agent pre-step 瀑布流注入静态、幂等的引导文本，并暴露两个只读诊断工具（`trace_status`、`trace_style`）与一个仅调节预算的工具（`trace_tune`）。预设本身**不注册任何 fs/shell/权限工具**。

| 机制 | 说明 |
|---|---|
| **锚定首轮** | 真实任务开始前先执行一个零工具、低预算的热身轮（"Cadence 热身"），消除首轮思考停滞。 |
| **预算感知** | 常量中性预算段 + 档位消息（small 2048 / medium 4096 / large 充裕），在档位变化时注入——模型在开始思考**之前**就知道自己的输出上限。 |
| **截断恢复** | 某步耗尽全部预算导致截断时，下一请求释放预算并注入恢复消息。 |
| **单调分类** | 默认 simple；首条用户消息设定类别，后续复杂消息永久升级。pre-step 阶段批感知。 |
| **平台档案** | win32 提供 PowerShell 指引 + shell 语法错误检测；支持 `auto \| win32 \| posix` 覆盖（用于测试）。 |
| **plan-forward 利用** | 进度缓慢时引导模型把已规划的独立验证工作提前——绝不新增动作。 |
| **验证过的死锁阶梯** | 怀疑 (L1) → 指纹验证 (L2) → 通过 `ask_user_question` 暂停询问 (L3) → 有界提醒 (L3b) → 可选升级 (L4，plan-mode 安全，cancel 不带指令)。 |
| **委派顾问** | 复杂修码会话建议一次独立评审委派（只读纪律；含定向数值评审变体）。 |
| **子代理超时提醒** | 委派的子代理运行过久时提醒（默认 15 分钟）。 |
| **todo 同步顾问** | 长时间并行工作导致模型自身 `todo_write` 节奏停滞时，保持 UI 待办列表真实。 |
| **视觉深化** | 检测到视觉相关工作负载时，温和引导截图 + `read_image` 验证。 |
| **轨迹诊断** | `trace_status` / `trace_style` 提供节奏状态与轨迹风格指标；`trace_tune` 仅调整输出预算。 |

所有注入均为静态文本、幂等（持久标记），并经 `agent/pre-step` 瀑布流路由（先剥离、后注入）。会话记录到首个持久提升信号后（`promoteOn: either`——首次工具调用或首条助手消息），暴露完整 Standard 工具目录。

## 安装

DSH 从 `~/.dsh/.agent-presets/<名称>/` 加载预设。将本仓库 `preset/` 目录内容复制过去：

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

然后**重启 harness 进程**。预设 `.mjs` 模块经 ES module 缓存每个进程只加载一次，因此修改 `cadence-core.mjs` 或 `cadence-bootstrap.mjs` 后必须重启；YAML 配置则随每次会话加入重新读取。在 DSH Web GUI 中为会话选择 `Cadence Standard (experimental)` 预设（order 6）。

## 配置项

`preset/agent.cordis.yml` → `cadence-bootstrap` 中的关键选项：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `simpleBootstrapMaxTokens` | 2048 | small 档上限 |
| `simpleCapMaxTokens` | 4096 | medium 档上限 |
| `complexBootstrapMaxTokens` | 16384 | 复杂引导上限 |
| `promoteOn` | `either` | 提升触发：`tool-call` \| `assistant-message` \| `either` |
| `anchorFirstTurn` | `true` | 启用零工具热身轮 |
| `platform` | `auto` | `auto` \| `win32` \| `posix` |
| `subagentTimeoutMin` | 15 | 委派子代理超时提醒 |
| `todoSyncAdvisor` | `true` | todo 列表同步顾问 |
| `escalateAfterIgnore` | (见 yml) | 多次忽略后的 L4 升级 |

## 测试

```bash
npm test        # node --test（test/cadence.test.mjs，93 项断言）
npm run check   # 语法检查预设模块后运行测试
```

测试套件用最小化的 fake Cordis 上下文逐一验证 bootstrap 注册的每个监听器，并对核心检测逻辑做纯函数测试。

## 引用说明

本预设参考了以下开源工作：

- [`yjh051108/dsh-router-standard`](https://github.com/yjh051108/dsh-router-standard)（MIT）——预设结构、首轮锚定机制与 agent 可见调优思路。
- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)（MIT）——首轮锚定机制（零工具热身轮、窄首请求）基于其 bootstrap filter。

详见 [NOTICE](./NOTICE)。

## 许可证

[MIT](./LICENSE) —— Copyright (c) 2026 xiaobright；部分 Copyright (c) 2026 DeepSeek。
