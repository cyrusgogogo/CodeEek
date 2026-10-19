# DSH 插件 API 与扩展机制研究笔记（Reference 专项）

> 采集日期：2026-10-15。开发导航的完整阅读、当前项目版本锚点与情景自测见[开发学习笔记](<dsh-plugin-development-notes.md>)。

## 0. 范围、证据与限制

本笔记服务于“学习 DSH 官方文档并掌握插件开发”的整体任务；本研究代理只负责 **Reference 导航及必要的官方源码/类型证据**，不替代主代理对 Develop 全部章节的阅读，也不声称已通读官方仓库、所有 Reference 子系统实现或完成实践认证。

证据标记：

- **【契约】**：本次实际获取并阅读的官方 Reference 正文、生成类型或 API 签名明确规定的行为。表示“文档如此规定”，不是已在本机运行测试。
- **【源码片段】**：本次实际取得的官方 manifest 或已解码的小段源码；不外推为整份实现已审计。
- **【推断/建议】**：由上述契约推导的设计判断、实施建议，未作为现成 API 或运行结果。
- **【差异/待核对】**：官方页面之间、页面与源码片段之间不一致；保留矛盾，不替官方臆断哪一方已经发布。

**访问方式与安全边界。** 从 [Reference 首页](https://deepseek-harness.github.io/deepseek-harness/reference/) 获取导航，再访问同站的 `.md` 正文，避免重复页面侧栏；网页中的维护命令仅作为资料，未作为本次执行指令。未安装依赖、构建、启动服务器或修改应用安装目录。目标笔记经 glob 两次确认不存在后才创建；只创建了它所需的工作区目录及本文件。

**本机源码限制。** 指定的 `C:\Users\cyrus\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\` 不能用普通文件系统 glob 访问，返回“系统找不到指定的路径”；上级目录实际存在一个 [app.asar 归档文件](<C:/Users/cyrus/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar>) 和 unpacked 资源。这是归档虚拟路径与普通目录的差别，**不是一次已证实的沙箱权限拒绝**。本次未解包，因此没有确认本机已安装的 DSH 包版本、源码或 `.d.ts`。官方 GitHub raw/blob 对多份源码请求返回 `fetch failed`；可用的 GitHub contents API 及 manifest 证据详见第 13 节。任何线上 `master` 事实都不等于本机安装版事实。

官方 [子系统索引](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/index.md)说明：`ts type-equiv` 类型与源码声明等价，由项目自己的漂移检查维护；每页 `Cordis API` 小节则由源码生成。本笔记利用这些已发布类型，但**没有亲自运行生成器或验证门禁**。

---

## 1. 架构心智模型：不是给内核打补丁，而是组合插件

### 1.1 三层分工

【契约】Cordis 提供 Context、依赖注入、事件、Fiber 生命周期；Harness 各功能——包括 agent loop、工具注册表、LLM、Session——也是插件。可替换能力常按 **Service Definition → Service Provider → Consumer** 拆分，消费方依赖稳定的 `ctx` 能力而不是具体实现。不是所有包都必须机械拆为三包：单一用途插件、组合包和独立服务有不同角色。[架构](https://deepseek-harness.github.io/deepseek-harness/reference/index.md)、[能力地图](https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams.md)、[新增包](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-package.md)

【契约】核心回路可概括为：`agents/agent-loop` 接收输入 → Session 日志打开轮次 → `systemPrompt` 组装 → `llm` 流式输出 → `tools` 分派 → 将模型可见事实记回 Session。`scope` 是无服务的原语库。扩展插件应依赖公开的 `dsh-agent`，不要依赖具体 `dsh-agent-loop`。[核心](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md)

### 1.2 Profile、Bundle 与配置覆盖

【契约】Profile 是具名组装，Bundle 是可 patch 的配置项及挂载代码分发格式；它们分别在 manifest 的 `dsh.profile`、`dsh.bundle` 声明。按 Profile 列出的顺序叠加 Bundle，再应用 Profile patch、home patch 和显式 `--patch`。Patch 按 id 定位条目，替换整份 config 或插入条目。不能把这个“整份 config 替换”误认作任意深度字段自动 merge。[架构](https://deepseek-harness.github.io/deepseek-harness/reference/index.md)

【契约】官方应用启动经过具名 `dsh` Profile；桌面应用还拥有保留的 Desktop Profile。CLI 与 Desktop 共享产品数据，但包安装、启用选择和锁文件不是同一套；公开 CLI 不能管理 Desktop Profile。[架构](https://deepseek-harness.github.io/deepseek-harness/reference/index.md)

【推断/建议】设计插件前先回答四个问题：运行在 Host 还是 Client；提供能力还是消费能力；状态归 Session 日志还是普通领域存储；生命周期归根 Fiber、某 Agent 还是某 UI owner。这个分解通常比先写一个巨型 `apply()` 更可靠。

---

## 2. Context、服务注入与 Fiber：API 的共同地基

### 2.1 插件入口与依赖

【契约】插件入口支持函数、类和 `{ apply }` 对象；元信息包括 `name`、`Config`、`inject`、`provide`、`intercept`。`Config` 使用 Standard Schema 约定，配置先校验再启动。`ctx.plugin(plugin, config)` 返回 `Fiber & PromiseLike<Fiber>`，await 等待加载，配置/启动错误会 reject。[Plugin Registry](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/registry.md)

【契约】`inject` 是服务依赖，不是模块 import 列表；数组表示依赖名，对象还能携带服务拦截配置。`ctx.inject(deps, callback)` 是临时依赖插件的简写：必需服务更换时卸载并重跑 callback，不能把它当只执行一次的 Promise。[Plugin Registry](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/registry.md)

【契约】`Service` 子类构造时调用 `super(ctx, name)`，立即登记具名 `ctx.<name>`，所属 Fiber 卸载时移除。`Service.init/check/config/invoke/extend/tracker/resolveConfig` 是各自有语义的 symbol，不是任意魔法字符串。服务类型通过 Context 声明合并进入类型系统；运行时仍必须真正提供服务。[Service](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/service.md)、[Context](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/context.md)

### 2.2 Context 的三种派生不要混用

| API | 已核对的用途 |
|---|---|
| `ctx.extend(meta)` | 派生子 Context，以 own metadata 遮蔽继承成员；不改父 Context。 |
| `ctx.isolate(name, label?)` | 为某服务另建解析作用域；同 label 可加入同一个隔离域。 |
| `ctx.intercept(name, config)` | 为下游插件添加某服务的拦截配置；按祖先到后代合并，不改父 Context。 |

来源：[Context](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/context.md)。

【契约】这与 Harness 的 **Agent scope** 不是同一个概念：`dsh-scope` 用不透明 `ScopeKey`、`scopeTarget`、`Scoped<T>` 将注册可见性与事件路由关联起来；`Scope` 同时拥有注册 Context 和完全停稳的 dispose 边界。当前公开契约用 `agent.ctx` 做该 Agent 的注册，不能仅按 SessionId 字符串或任意 `ctx.extend()` 自称已经得到相同作用域。[Scope](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/scope.md)、[核心](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md)

### 2.3 生命周期与清理

【契约】`ctx.effect(execute, label?)` 立即执行并收集其产生的清理工作；主动 dispose 或 Fiber 卸载时按逆序启动清理，但多个异步 disposer 可并发完成，需要顺序依赖时应在同一个 disposer 中串行等待；重复 dispose 无作用；失活 Fiber 上创建 effect 会抛 `INACTIVE_EFFECT`。`ctx.on/once` 的监听器、工具注册、适配器注册等遵循所属 Fiber 生命周期。[Fiber](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/fiber.md)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md)、[Events](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/events.md)、[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)

【推断/建议】不要把“拿到 disposer”误当“已经注册到生命周期”。对明确自动 effect 化的注册 API，遵循其返回契约；对裸订阅、第三方资源或需要特定拆卸顺序的资源，用一个明确的 effect/composite 管理，避免重复拥有、泄漏或重载后双注册。

---

## 3. Events 与 Hooks：先判断事件模式，再写监听器

### 3.1 五种模式的精确差别

| 分发 API | 契约 |
|---|---|
| `emit` | 同步调用监听器，不等待其异步工作，忽略返回值。 |
| `parallel` | 并发运行全部监听器，返回等待其完成的 Promise。 |
| `serial` | 按序 await，遇第一个 bail 值即停止。 |
| `bail` | 同步按序调用，遇第一个 bail 值即停止。 |
| `waterfall` | 最后一个参数是 `next`；每个监听器包裹下游，调用 `next()` 才继续，不调用就是短路。返回类型由具体事件决定。 |

【契约】bail 值指 **非 null、非 undefined、非 false**，不是笼统的 JavaScript truthy。`on/once` 返回移除监听器的函数；`EventOptions` 包括 `prepend`、`global`。`global` 能绕过 Context filter，不能随意用于只应服务单 Agent 的监听器。[Events](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/events.md)

【差异/待核对】[Cordis primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md) 的模式表把 waterfall 的 await 一栏写成“否”，但多个具体 waterfall 签名返回 Promise。稳妥解释是它不是一套自动 await 全部监听器的 parallel 协议；**是否等待、如何返回必须遵循该事件的实际类型和 continuation**，不能从表格推导“所有 waterfall 都同步”。

【契约】原生 hook 就是监听扩展点的普通 Cordis 插件，不需要外部 hook 协议；“hook 插件”不等于“权限门禁”。只观察/标注的 waterfall listener 应委托 `next()`；有意拥有决策的 listener 才短路。对于结果型 continuation，通常应 `return next()` 或显式保留下游结果，不能无意吞掉它。[扩展模式](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook.md)

### 3.2 重要扩展点速查

| 扩展点 | 模式与适用情境 |
|---|---|
| `agent/pre-step` | waterfall；决定拟进入步骤的完整 `UserMessage[]`，可 reject；返回决策才是权威。 |
| `agent/request` | waterfall；决定模型调用配置；不是修改已冻结历史的后门。 |
| `agent/request-error` | waterfall；失败恢复，拥有恢复者返回 `{ kind: 'retry' }`。时序文档存在差异，见第 13 节。 |
| `agent/turn-stopping` | serial；终止检查点；需要继续时通过 steering 提供数据，不能把任意 listener 返回值当强制续跑命令。 |
| `agent/assistant-stream` | emit；只作实时 token/状态呈现，不是持久 transcript。 |
| `session/event` | 已提交 Session 事实的主要观察通路；回放与可重建 transcript 用它。 |
| `session/flush` | parallel；await 全部持久化检查点监听器，无 waterfall 否决。 |
| `system-prompt/assemble` | waterfall；提示词/工具/动态 context 组装。 |
| `llm/stream` | waterfall；包裹模型 stream；loop 生成的 request 已冻结，不允许改写。 |
| `tools/pre-execute` | waterfall；可重排 allow/deny/ask 策略。 |
| `tools/execute` | waterfall；环绕 dispatch，适合超时/重试/度量。 |
| `tools/post-execute` | waterfall；显式结果转换。 |
| `tools/result` | emit；观察冻结的最终权威结果；不能在此修改结果。 |
| `approval/request`、`user-questions/request` | scoped waterfall；回答自己负责的请求，否则 next。 |
| `fs/write-intent`、`fs/edit-intent` | waterfall 决策；先读后写等新鲜度策略位于这里。 |

来源：[核心](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle.md)、[Session](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session.md)、[System Prompt](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/system-prompt.md)、[LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md)、[Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)、[审批](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/approval.md)、[用户交互](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions.md)、[文件系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/filesystem.md)。

### 3.3 外部 Claude Code/Codex hook 桥接的已知边界

【契约】配置目录中两种桥接插件都注入 `shell` 与 `sessionProjections`。`configPath` 是**进程级、加载时读一次**，相对路径基于进程启动 cwd；逐 Session 项目本地 hook 文件发现仍在配置注释中标为 TODO。不能认为换工作区就会自动换 hook 文件。默认单 hook timeout 的文档值是 600000ms；`stderrSummaryMaxChars` 控制持久错误摘要。[配置目录：Claude Code](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog.md#deepseek-aidsh-hooks-claude-code)、[配置目录：Codex](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog.md#deepseek-aidsh-hooks-codex)

【契约】`hook/invoked`、`hook/result` 是 Session 的 log-only 记录，不是 surface 事件。[Session](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session.md)

【未覆盖】未取得两个桥接包 README/实现正文，故没有确认完整外部 hook 事件名映射、退出码兼容表或所有 payload 字段；不要将“能桥接”外推为完全兼容原工具所有 hook 特性。

---

## 4. Agent 与输入：持久事实和实时协调分开

【契约】`ctx.agents.create/resume` 返回拥有者持有的 `AgentHandle { agent, dispose }`；`ctx.agents.get(id)` 只返回裸 Agent，不授予 teardown 能力。`dispose()` 会停循环、等其退出、撤注册、移除内存 Session 并拆作用域。创建期 `setup(agentCtx, agent)` 在发布前完成，失败回滚，不要在发布之后才补装首次请求必需的工具。[核心](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md)

| 输入方法 | 契约 |
|---|---|
| `followup(UserMessage)` | 排入普通下一轮输入并唤醒 driver；该普通消息独占其自己的轮次。 |
| `steer(UserMessage)` | 投递最近步骤；idle 时唤醒，running 时在下一步骤边界消费。 |
| `inject(UserMessage)` | 排入下一 pre-step 的模型可见上下文，**不唤醒** idle Agent。 |

【契约】这些方法接收带 id/source 的 `UserMessage`，当前公开类型返回 void；不是“发送提示词并返回最终答案”的调用。`whenIdle()` 观察整个 Agent，不自动把某个 MessageId 与未来 Assistant 输出/turn-end 配为一对。`running` 也不证明某轮次仍打开；Agent status 只有 `idle | running`，disposed 是撤注册及事件而非第三个 status。[核心](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md)

【契约】实时 stream frame 是瞬态的；成功 `assistant/message` 或失败/取消等 `assistant/attempt` settlement 才把精确紧凑 stream 写进日志。进程在 settlement 前硬中断，不保证存在持久 attempt stream。[生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle.md)

【推断/建议】后台通知要判断是仅注入信息，还是确实应开启新轮；不能依赖 `inject()` 唤醒。自动化驱动若要定义“一次 run”，必须拥有明确的输入到 idle 区间，而不是按最近一次文本回包猜测结束。

---

## 5. 工具 API：把规范值、模型内容和 UI 分成三个面

### 5.1 当前最小形态（示意，未在本机编译）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'reference-echo'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'reference_echo',
    description: 'Return the supplied text.',
    parameters: {
      text: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return args.text
    },
  }))
}
```

【契约】`defineTool` 是类型化辅助；`ctx.tools.register()` 也接受原始 JSON Schema 的 `ToolDefinition`，例如 MCP 来源。工具注册本身 effect 化，卸载 Fiber 即撤销；不要改注册后借用的只读定义，需要替换时撤旧注册再注册。[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)、[Tools 类型](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)

### 5.2 三个面

1. **模型 schema**：模型可见的 name/description/parameters 等，由 `schemas()` 显式投影；`execute`、`output`、调度和展示回调不能泄漏进模型请求。
2. **规范 JSON 结果**：`execute(args, exec)` 只返回 `output.schema` 声明的规范值；注册表做无损 JSON 快照、校验与冻结，再交给纯 `output.render(args, value)` 生成 Native/模型内容。成功领域状态即便不理想，也应放规范值；基础设施异常则抛出，由注册表转为 `isError`。
3. **展示**：可用 `output.presentationMeta` 投影有界、可回放 JSON 事实；Host presenter 与 Web Client renderer 不是同一套机制。

来源：[Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)、[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)。

【契约】不要让 PTC 调用方从自然语言解析 job id、资源 id 或字段；这些应出现在规范 JSON 结果中。当前规范值不应被误认为一律完整持久化到每个 `tool/result`；需要回放的卡片事实使用专门的持久 presentation metadata。[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)

### 5.3 Schema、输入身份和取消

【契约】类型化 DSL 执行前校验类型、required、字面量、嵌套和 exactly-one 分支联合。显式 object 节点必须指定 `additionalProperties: true | false`；隐式参数根保持开放。DSL 表达不了的非空、正数、跨字段规则仍要手写校验。**直接注册原始 JSON Schema 工具并不自动获得 defineTool 的输入校验责任代办。**[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)

【契约】一次调用的 `callId/name/arguments/agent/token/signal/parent` 身份受保护，arguments 是分离的冻结无损 JSON；只有 around-dispatch 包装器可替换并恢复必填 `signal`，不能移除它。`parent` 是关联 token，不是直接访问活跃外层执行的对象。[Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)

【契约】异步工具必须遵守 `exec.signal`，且在自己拥有的工作停稳后才 settle。注册表不能硬杀同进程无限循环；只返回一个超时 Promise 并丢下后台副作用不等于已正确取消。[Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)

### 5.4 策略与最终结果的顺序

```text
记录 tool/call
  → tools/pre-execute（allow / deny / ask）
  → 必要时一次性 approval；非 allowed-once 均拒绝
  → 单调 guards（只能 deny 或 abstain）
  → tools/execute（around dispatch）→ 工具体
  → projectContent（准备内容投影）
  → tools/post-execute（可显式改写结果）
  → 外层错误/快照规范化
  → finalizeContent（最后的同步 content-only 不变式）
  → tools/result（冻结权威结果的通知）
  → 记录 tool/result → Web 回放/呈现
```

【契约】`projectContent` 在后置策略前安装内容，后置策略仍可替换；绕过 post 的流水线失败可以跳过 project。`finalizeContent` 在规范化后对包括失败在内的结果执行最后一次同步 content-only 处理，要求 total、不抛异常。`tools/result` 是观察点，不能当结果重写点；其监听失败受到 containment。[执行流水线](https://deepseek-harness.github.io/deepseek-harness/reference/tool-execution-pipeline.md)、[Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)

【推断/建议】不可被其他插件撤销的安全底线使用 `guard`，可组合政策用 pre，超时/重试/度量用 execute，显式内容替换用 post；不要把不可绕过的策略仅写成一个可重排的 pre listener。

### 5.5 并发、PTC 与任务

【契约】工具调度涉及 barrier 和有界 rolling pool，并在启动前重新分类；声明并发安全是一项语义承诺，不应仅因实现 `async` 就开启。PTC 的 `run_code` 及其子调用仍进入受守卫的工具流水线，子调用有 parent 关联，拒绝必须是有约束力的失败，不是可忽略字符串。[生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle.md)、[工具目录](https://deepseek-harness.github.io/deepseek-harness/reference/tool-catalog.md)、[PTC](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/ptc-runtime.md)

【差异/待核对】presentationMeta 是否仅对顶层调用执行，官方正文与当前源码注释不一致，详见第 13 节；不要把本节的概念分层当成已确定的嵌套 metadata 行为。

---

## 6. Tool UI：Host presenter 不等于 Web 卡片

**【契约，重要】内置 Web Client 不消费 Host `presentCall/presentResult`。** Session 的 page/follow 传输原始 `tool/call`、`tool/result` 及 result meta；Client 插件在 keyed slot **`tool.call.toolview`** 按 wire 工具名注册自己的组件，基于参数、内容、isError、metadata、PTC parentCallId 和 Session 路径事实推导 props。[工具编写：Web Client 展示](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)

【契约】Client 必须本地校验这些 wire 值；畸形/不支持的数据要回退 generic 行。`presentationMeta` 保存结构事实，不保存 React props、预选卡片或组件；不能把 Host 工具实现导入浏览器 bundle，也不能另立一套 Client presenter registry。只加 Host 展示回调不会自动得到专用 Web 卡片。[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)

【推断/建议】一个“带专用 Web 卡片的工具”至少分成：Host 工具/规范输出与可回放事实、浏览器 wire decoder、slot renderer。为旧日志缺 metadata、新字段缺省、错误结果和不支持版本分别设计 fallback，不要只测实时成功路径。

---

## 7. 浏览器扩展：Client Modules、Slots、Conversation、Resource

### 7.1 Client 模块如何到达浏览器

【契约】Host 扫描启用 Loader 条目中声明 `dsh.client` 的包，组合 `window.__DSH_BOOT__`；发布构建好的 `./client`。浏览器 bundle 是 **lazy-CJS factory 注册脚本**，不是任意 ESM 文件。模块图顺序解决 factory/import 的可物化性，Cordis inject 另行决定激活顺序。[Client Modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)、[Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md)

【契约】包的浏览器半只挂在说明符恰为**裸包名**的根行；子路径导出的行不携带浏览器半。把多行子插件都塞在一个包里，不代表它们的 UI 有独立生命周期；关闭根行会卸载由它贡献的页面。仓库外包还需自己实现等价 lazy-CJS 构建：内部 `clientBundle` preset 不是已发布公共包 API。[新增设置页](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card.md)

【契约】图的 row rev 来源是产物 mtime/ctime/size，而非可执行字节哈希；显式 rebuilt 是产物变化进入图的通路。[Client Modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)

【推断/建议】源码改动不会凭空成为正在运行的浏览器产物；有 HMR receiver 也不证明构建 watcher 正在工作。本次没有验证 watcher、没有承诺免刷新，更没有另启一个服务器去冒充当前 GUI。

### 7.2 Slots 的所有权与四种 cardinality

【契约】`SlotMap` 声明合并规定 key、cardinality、scope、props；运行时由实际 owner 的 `children` 声明位置。未声明的位置不能注册，同一个 child 不能被两个存活 owner 同时拥有。`root` 是唯一内建声明和 context 级直接渲染入口；其他位置由被授权的 parent renderer 渲染。[Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)

| cardinality | 语义 |
|---|---|
| `single` | 一个 cell，取 priority 胜者；不是列表。 |
| `list` | 必填 id 定址，按 order 再注册顺序排列。 |
| `keyed` | owner 提供 entryKey，选择对应 cell 与 props。 |
| `chain` | 按 priority 执行纯 select，首个非 null matched 胜出；全拒绝用 owner fallback。 |

【契约】priority 数字越小越先；增量贡献优先新 list id/未占用 keyed key，复用已有 single/keyed cell 是有意替换。Scope 为 `root`、`session-maybe`、`session`；严格 Session binding generation 变化会影响挂载语义。插件向别人的位置贡献时应 `ctx.slots.inject(key, callback)` 等待 owner；owner 折叠会撤掉贡献，再挂载时重新运行。[Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)

【契约】组件不接收 `ctx`。输入来自 owner props、被授权 child renderer、视图 store、inject face、locale 以及 chain matched。业务/传输状态在 service/model；Slot store 只拥有共享视图/交互状态。功能包之间只用 type import 共享声明，跨功能运行时能力经服务、跨功能 React 经 slots。[Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)、[Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md)

### 7.3 Conversation 节点不是随手扫描日志的组件

【契约】Session Controller 拥有逻辑事件 window；Conversation assembler 处理 durable event 与 transient live chunk，按稳定 `(kind,id)` 关联、回放 State 与 Location；Chat、Trajectory 等 target 拥有各自 Definition、snapshot 与渲染，不共享某个 target 的最终 UI 数据。[Conversation](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/conversation.md)

【契约】业务 Chat 节点贡献要同时有 `ConversationNodeDefinition` 和 keyed `conversation.chat.node` renderer；renderer 读取 node data 与受限 Location hook，不应自己扫描事件窗口。target source 的创建/读取不自动激活 builder；显式选择或首订阅才激活，已激活集合单调增长。[Conversation](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/conversation.md)、[扩展模式](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook.md)

### 7.4 Resource 与 Sidebar 扩展

【契约】`ctx.resources` 用 `dsh-resource://<protocol>/...` 地址连接提供方和任意组件；协议类型通过 `ResourceProtocolMap` 合并，一个协议一个提供方。`open(address,{signal})` 产出首个当前状态及后续 `RemoteResult` 帧；错误应为 `ok:false`，流抛出被文档视为编程错误。订阅或 pin 持有资源，最后一个持有者释放会中止并丢弃值；单纯读 source snapshot 不持有它。[客户端资源](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-resources.md)

【契约】资源状态有 `none/loading/live/failed`；failed 保留上一个成功 value。Sidebar tab 类型需同 id 的静态 `sidebarRightTabs` 定义和 keyed 正文 slot 注册；dockkit 是内部布局实现，不是稳定扩展接口。[资源](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-resources.md)、[Sidebar](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right.md)

【差异/待核对】Sidebar 刷新持久性在同页自相矛盾，不能据此许诺刷新恢复，详见第 13 节。

---

## 8. Host ↔ Client：服务、Remote、model、UI 的边界

【契约】Host service 拥有权威状态、持久化、mutation 顺序与访问策略；Gateway/Connection 拥有调用/流载体；Client model 拥有 identity 稳定、不依赖 React 的镜像；UI adapter 将 model 适配为 Slot source；组件只呈现。[Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md)

【契约】只有 `@Remote`、`@RemoteScope` 标记方法进入可调用贡献。普通 `@Remote` 从根 Host Context 取服务；`@RemoteScope(key)` 先解析 scoped Context。Host 对象不直接跨 wire，业务通过 `TypertLookupMap`、`TypertContextMap` 声明 wire identity，并注册 resolver。继承 `TypertRemoteService` 或显式 `bindTypertRemote()` 绑定服务 key 与 namespace。[API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway.md)、[Typert](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/typert.md)

【契约】可取消方法的最后一个 Host 参数是 `signal: AbortSignal`；它走带外载体而不进业务 args。stream 方法生成 `RemoteStreamHandle`，Client→Host uplink 在 Host 通过 invocation 读取，并先由 codec 校验。不能把任意浏览器值当已经可信。[API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway.md)

【契约】Client 是具体函数，不是 JS Proxy：根调用 `ctx.remote.<namespace>`，Session scoped 调用 `agentCtx.remote.<namespace>`。实际调用方的 inject 同时声明 `remote` 与 `remote.<namespace>`；assembly 挂贡献不等于替所有消费方声明依赖。[API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway.md)

【契约】Host 生成 descriptor、codec、声明合并、source map 后，Client build 再消费生成文件；只编译前端不能从 Host decorators 推导新 API。Client 应用的 remotes assembly 明确选择业务 `/remote` contribution，功能组件不运行时导入 Host 实现。[API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway.md)

【契约】WebServer 是 HTTP 载体，路由 exact 优先、再最长 prefix、最后唯一 fallback；它本身不拥有 TLS/认证/Origin 策略。Connection 与组合层负责这些安全边界；不能把“绑定 loopback”当成所有业务授权已完成。[HTTP Server](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server.md)

---

## 9. 持久化与存储：四种状态不要混成一个数据库

### 9.1 Session 日志：模型历史唯一真源

【契约】Session 是 append-only、连续 seq、无损 JSON 的事件日志，消息历史由日志派生。`SessionEventMap` 可声明合并；surface 事件参与模型历史，log-only 事件用于审计/领域事实，不因写入日志就自动让模型看见。自定义 `ContentBlockMap` 新模态还必须同时考虑适配器、UI、compaction 与回放支持。[Session](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session.md)、[LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md)

【契约】`SessionPersistence` 是独立 seam；`create/open` 返回 `SessionHandle`，每次读写经 handle，而非按 id 的全局 append。handle 同时承担 write lease/单写者所有权；read handle 修改抛运行时错误，关闭幂等，关闭后操作失败。append 与 flush 的承诺应按其精确文档区分，不可将“内存事件已观察到”当已落盘。[会话持久化](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/persistence.md)

【契约】`turn/end` 不由 loop 等待持久 flush；checkpoint policy 拥有每请求耐久检查点，storage 读取方在 `whenIdle()` 后若要求已持久化前缀，需要自己做显式 flush。idle 本身不是 durability barrier。[Session](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session.md)

【契约】持久化目录记录 header/envelope/event 类型及 SHA-256 结构指纹；指纹覆盖声明的结构，不覆盖不透明 payload 内部语义、或类型不变的行为变化。外部插件类型不在仓库自带目录范围内，需要独立声明/兼容策略。[持久化目录](https://deepseek-harness.github.io/deepseek-harness/reference/persistence-catalog.md)

### 9.2 Session Projection：只读模型，不是第二份真源

【契约】`ctx.sessionProjections` 驱动纯同步 `ProjectionDefinition`：`init`、`apply`、可选 wire `view`、`stateSchema`、`stateVersion`。State 必须 plain JSON；不相关事件应返回原 state 引用以避免下游工作；wire 是完整当前值而非要求 Client 再折叠领域事件。状态字段或 fold 语义变更要递增缓存版本。[Session Projection](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-projection.md)

### 9.3 普通领域数据：Storage Domain

【契约】`ctx.storage` 是后端/数据形式枢纽，本身不做 IO；`json/sqlite` 后端可并存，后端路由属于消费数据形式配置，不是一个全局数据库开关。产品数据走 `ctx.storageDomain`（与 `ctx.storage.domain` 为同一 facility），不要绕领域层直接摸 backend。后端只注销名字不自动代替其插件 close；tear-down 所有权必须明确。[Storage](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/storage.md)

【契约】`domain/changed` 严格在后端确认 durability 后发出，同域写链有序；这与 Session 的实时 `session/event` 不是同一种耐久承诺。底层 unit 不负责跨调用串行化，单次调用原子且 resolve 后持久。[Storage](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/storage.md)

### 9.4 大文本：Spill，不等于领域存储或消息日志

【契约】`ctx.spillStore.saveText` 原样保存全文并返回不透明 locator、bytes、retrievalHint；消费方不能假定 locator 永远是本地文件路径。spill policy 决定保留预览/替换结果，本地后端只存储；保存失败时政策可保留原内联结果，不把成功工具硬变错误。fork 继承日志中既有 locator，不复制或改 owner。[Spill](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/spill.md)

---

## 10. LLM、提示词与凭据扩展

### 10.1 Adapter 契约

【契约】继承 `LlmAdapter` 实现 `stream(GenerateOptions)`，通过 `registerAdapter(providerRoutes, instance)` 注册；一条路由一个实现，多路由注册全成或全失败。provider 选实例，model 是该提供方的模型 id；模型列表是 selector 元信息，不是请求白名单。[新增 LLM Adapter](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-an-llm-adapter.md)、[LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md)

必须遵守：

- usage 在 finish 之前，finish 之后不再发 chunk。
- 工具参数保留原始 JSON string，流片段走 argumentsDelta；同块 index 稳定并按首次出现分配。
- 传输/协议故障可 throw 稳定 code 的 `LlmError`；提供方带内故障可 finish error/aborted；不能混为“所有失败都只一种出口”。
- 不支持的显式选项抛 `UNSUPPORTED_OPTION`，不静默丢弃；遵守 signal。
- 原生 replayState 必须是最小无损 JSON，并在重放时校验；Runtime 只在历史 route 与目标 route 当前归**同一个 adapter 实例**时转交它，兼容范围由 adapter 决定。

来源：[Adapter 指南](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-an-llm-adapter.md)。

【契约】`resolveModel` 公开确切身份、可选 context/reasoning 元信息；reasoning effort 是 adapter 自有的不透明有序 id，不应在 UI 硬编码某家 wire spelling 或擅自纠正不支持值。`prepareCall` 将解析/请求头记录/分派绑定到同次 adapter 注册；loop 派生的请求是冻结的日志函数，`llm/stream` listener 读取而不改写它。[LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md)

### 10.2 系统提示与动态 context

【契约】`ctx.systemPrompt` 注册 `PromptSection`、tool provider、动态 PromptContext 等贡献；section 按 order 再名称排序，runtime context 有独立次序分配。`complete` 是特殊整份提示词贡献，同一有效作用域多个 complete 会失败。组装后由 loop 把渲染文本记录成 `system/message` surface，而非另一个不可回放请求字段。[System Prompt](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/system-prompt.md)

【契约】`MessageSourceMap` 是 merge-extensible，生产方各自声明 kind；当前 LLM 类型明确写着 **没有通用 catch-all `plugin` kind**。`kind` 表示谁产生，`form` 表示 instructions/catalog/snapshot/notice/relay/recall 等语义，不应编码颜色图标等 UI 决策。[LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md)

【差异/待核对】旧 cookbook 的 `{ kind:'plugin', plugin:'...' }` 注入例子与上述类型注释冲突；实现时先核对目标版声明，声明自己生产者 kind，并创建真正的 `UserMessage`，不要照抄旧对象形状。

### 10.3 配置与凭据不是同一层

【契约】当前 credentials seam 的配置持有 `CredentialRef`（POSIX 风格环境变量名）而不是秘密值；消费方每个操作重新 `resolve(ref)`，不跨操作缓存，这才支持轮换。`describe` 只返回 configured/source/writable，不泄漏值；空存储值视为不存在。[Credentials](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/credentials.md)

【差异/待核对】Adapter cookbook 还描述 Config/env 注入密钥；应区分“不能读取私约密钥文件”这条原则与当前 credentials seam 的具体接入方式，不能据旧简例推导所有当前 adapter 都直接保存 apiKey。

---

## 11. 文件系统、沙箱、子进程与 Jobs 的安全/取消边界

### 11.1 FS 是能力，先读后写是政策

【契约】`ctx.fs` Definition、local Provider、`tool-fs` Consumer 与 observation policy 分离；不装 observation policy 时裸 write/edit 是无条件操作。默认先读后写/编辑来自 `fs/*` 决策，不是整个文件系统 API 天生保证。`FsTargetKey/FsVersion` 都不透明；不要解析为本地路径，要用 provider 的 processPath/fileUrl/contains 等跨能力接口。[Filesystem](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/filesystem.md)

【推断/建议】可替换执行世界（例如远端）中，直接 `node:fs`、`child_process` 往往绕开了部署选择与政策；面向 Harness 执行能力的插件应优先消费相应 seam，确需 Host 本地 IO 时显式说明边界。

### 11.2 Sandbox 只承诺文件效果，不包办网络隔离

【契约】模式是 `read-only/workspace-write/danger-full-access`；前两种交给 confined backend，full-access 消费方直接走原始 argv。SandboxMode 不定义网络与进程可见性。后端可报告 `full/partial` enforcement；当前文档特别指出 Windows ACL 和旧 Landlock ABI 的不完整情形，不能把 partial 当 full。[Sandbox](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sandbox.md)

【契约】逐调用 policy 携带 mode/workspaceRoot/可选 sessionId；显式已批准 override 高于 Session 日志覆盖，高于部署默认。Session cwd 是 workspace-write 边界，提供方在自身执行世界规范化路径。[Sandbox](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sandbox.md)

【契约】审批 outcome 只有 `allowed-once/rejected/cancelled/unavailable`，后三者都拒绝；`never` 在应答链之前拒绝，prepend listener 不能把它变成 ask。人类问答也要求确切 live runtime root；被另一个 Agent 拥有的 delegated caller 不具有人类 answerer，不能靠持久 parentSession 关系猜授权。[Approval](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/approval.md)、[User Questions](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions.md)

### 11.3 子进程、Shell 与 PTC

【契约】Subprocess spec 显式给 argv/cwd/env/stdio/grace/signal；清理继承凭据并管理 `DSH_*` 命名空间，不能让 ambient 旧值冒充当前可信事实。输出收集是有界 tail，可带完整 spill；shell 是更高层 request→resolve(spec) 能力，并不自己注册通用 job。[Subprocess](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subprocess.md)、[Shell](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/shell.md)

【契约】PTC 的 `resolve` 补全并校验执行选择，`run` 返回程序结果，程序失败是结果的 error 字段；错误输入仍可能执行前拒绝。PTC provider 承诺能硬停止程序本体，但已发出的 Host binding 调用仍由调用方等待停稳，不能将“runtime 已杀掉代码”当所有 Host 副作用结束。[PTC](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/ptc-runtime.md)

### 11.4 后台工作生命周期归 Jobs

【契约】`ctx.jobs` 拥有 id、访问围栏、状态与输出环；producer 拥有执行资源。`JobSpec.run` 在预检后同步返回 hooks，`cancel` 同步发起取消，`done` 需在资源清理后完成且不 reject。owner 当前契约为 **SessionId**；有 owner 的作业在其 live Agent dispose 时取消并等待。没有服务其 owner 的 controller 时，start 拒绝。[Jobs](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/jobs.md)

【契约】后台 id 发布之后，producer 使用任务自有取消能力，不再把外层 `exec.signal` 当作该 job 的全生命周期；取消外层等待不等于 kill 已发布任务。job 的 kill、owner dispose、service teardown 才拥有它的拆卸。前台工作仍遵守外层 signal。[工具编写](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)

【差异/待核对】工具 cookbook 的简例仍写 `owner: exec.agent`，而 Jobs 类型明确 `owner?: SessionId`；这是具体会导致类型/行为错位的地方，应按目标版 JobSpec 提供 SessionId，不照抄这个简例。

---

## 12. 其他扩展入口与配置 UI

| 需求 | 已核对的方向 |
|---|---|
| 人类 slash 命令 | `ctx.commands` 注册；适配器直接针对 Agent 调用 handler，不自动成为模型消息。持久 `command/run/done` 与直接呈现的结果各有职责。 |
| Skills | `ctx.skills` 注册 provider；全局+scope 分层，异步发现、完整性和 invalidation 由目录协议明确表达；不是必须为每个 skill 自造一套插件机制。 |
| Compaction | 独立可替换 seam；`compaction/start/summary/end` 是 log-only，摘要对模型的作用由另一条带 surface replacement 的 user/message 实现。 |
| 可观测不变式 | `ctx.invariants.register(packageName, installer)`；专属 child Fiber 管理检查，断言权威事件或可变数据关系，不是“方法存在就说明正常”。 |
| 遥测/脱敏 | `session-telemetry/record` waterfall 转换导出副本，不改 canonical log；ledger 与 ops 身份/去重语义不同，交接不等于已送达。 |

来源：[Commands](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/commands.md)、[Skills](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills.md)、[Compaction](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction.md)、[Invariants](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/invariants.md)、[Telemetry](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-telemetry.md)。

### 12.1 Volatile Config 与设置页

【契约】即时字段由 schema 的 `.volatile()` 声明，对应 `Volatile<T>` 引用；消费者在每次操作开始读 `.get()`，需要一致性时一次捕获快照。`loader/volatile-update` 面向消费者刷新注册，`settings/document-updated` 面向表单失效通知。普通字段不进入即时设置表单。[新增设置页](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card.md)、[Settings](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/settings.md)

【契约】namespace 是 Profile 中唯一条目 id，不是 npm 包名；多个实例可有独立表单。update merge、replace 重置即时字段后应用、mutate 做有序路径编辑并保留未回显的秘密；完整 Config 校验及 stale revision 拒绝在持久化前完成。`role('secret')` 不进入远端读取响应；`.check()` 跨字段验证由 Host 执行，不混入序列化表单 schema。[Settings](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/settings.md)、[设置页手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card.md)

【契约】给他人插件详情贡献 UI，可用 `plugins.detail.actions/badge/section`，按 subject 判定是否返回内容；不要通过导入他人的页面组件耦合。页面生命周期也需等待实际 slot owner。[设置页手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card.md)

---

## 13. 导出、版本与本次发现的差异

### 13.1 有限但可定位的源码证据

【源码片段】本次实际获取的 [tools manifest](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/package.json) 声明：

- 包名 `@deepseek-ai/dsh-tools`，版本 **`0.2.1-alpha.3`**，ESM，入口 `lib/index.js`，类型 `lib/types/index.d.ts`。
- 导出包括根入口、`./types`、`./presentation`、`./src/*`、`./package.json`、locale。
- `files` 列表是 locale、lib JS 与 lib/types JS/声明；manifest 有 `./src/*` export **不等于发布产物一定包含 src**。
- 未出现 `private: true`。

这些是当次 `master` manifest 内容，不是已安装版本，也不是长期 semver 兼容承诺。生产插件应优先用公开 package export/type entry，不能仅因仓库 path 存在就依赖内部源码布局。

【源码片段】[GitHub contents API：tools/src/index.ts](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/tools/src/index.ts?ref=master) 返回 blob SHA **`0970c7e2b04748074525faa3f7206fabf6b4d2aa`**、size 91055、base64 内容。本次只对 `ToolOutputDefinition.presentationMeta` 的一个注释片段进行了内存解码，得到：

```ts
/** Pure replayable presentation projection for native and nested calls. */
```

没有解码/审读整个文件或追踪调用实现，因此不能从这一句推出 nested 调用的实际执行、持久化或 UI 语义已经是什么。

### 13.2 差异清单（必须带到后续开发）

| 项目 | 两侧证据 | 可得结论与开发处理 |
|---|---|---|
| **presentationMeta 的 nested 行为** | [Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md) 的类型注释为 “computed only for top-level calls”；[adding-a-tool](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md) 说 nested 跳过。上述 [source API](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/tools/src/index.ts?ref=master) 解码注释却写 native and nested。 | 已确认正文/类型副本与源码注释不一致；未核对调用路径。必须以目标安装版实际定义及测试决定，暂不承诺 PTC metadata。 |
| **通用 plugin source** | [LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md) 明确没有 catch-all `plugin`；[工具手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)、[扩展 cookbook](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook.md) 仍用 `{kind:'plugin',plugin:...}`。 | 示例形状至少与当前公开类型说明不一致。先声明自己的 producer kind，使用当前 UserMessage 构造方式，不能把旧对象强转过去。 |
| **JobSpec.owner** | [Jobs](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/jobs.md) 明确 `owner?: SessionId`；[工具手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md) 简例传 `exec.agent`。 | 不应照抄。用目标版 JobSpec 核对，并提供正确 owner identity。 |
| **Sidebar 刷新后布局** | [Sidebar 同页](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right.md) 的定位段说刷新恢复保存布局；末尾“不做”说仅内存、刷新折叠。 | 页面内部自相矛盾。持久恢复尚未由本次源码/运行证实。 |
| **request-error 所处步骤** | [生命周期图](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle.md) 描述在 open step 内重试；[Core 的拦截说明](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md) 写失败步骤关闭之后执行。 | 不根据 prose 硬编码事件闭合时序；后续需查 driver 实现及恢复测试。 |
| **包 private/publishing 规则** | [新增包手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-package.md) 列 `private:true` 不变式；实际 [tools manifest](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/package.json) 没该键，并有 public publishConfig。 | 规则与实例不一致；仓库内约束和树外可发布插件也不是同一场景，不能把 private:true 当普适发布要求。 |
| **密钥接入说明** | [Adapter cookbook](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-an-llm-adapter.md) 的 Config/env 简例，对比 [Credentials](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/credentials.md) 的引用+逐操作解析。 | 至少是层次/演进说明不齐；具体 adapter 以当前 credentials/type 接口为准，不自行发明密钥文件。 |
| **waterfall await 表格** | [primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md) 表格写否，对比 [Events](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/events.md) 泛型及各 subsystem 的 Promise 返回。 | 不把“waterfall”理解为一律同步；按具体签名返回 continuation。 |

【推断/建议】这些差异说明“生成参考存在”不等于每段人工教程、中文对侧、网站部署和最新 master 都处于同一 revision。实践开发先固定 **安装版/依赖锁/源码 commit**，再看其 `.d.ts`、export manifest 与行为测试；本笔记不编造哪次 release 引入或修复了这些差异。

---

## 14. 实施前检查表（建议，非本次已执行结果）

1. 固定目标 DSH 版本，确认 Host/Client 包版本和 Cordis peer 范围；不要把官网 master 直接当本机版本。
2. 用最小 profile/overlay 验证服务注入、重复注册、缺 provider、依赖更换与 Fiber dispose；检查没有残留监听/工具/UI。
3. 工具覆盖参数错误、规范值错误、renderer 异常、取消、并发、pre deny/ask、monotonic guard、post 替换、pipeline 失败与最终观察。
4. 如支持 PTC，验证规范返回值、嵌套 denial、parent 身份、Host binding 停稳；单独核对第 13 节的 metadata 分歧。
5. 专用 Web UI 验证实时和回放、旧日志缺 meta、畸形 wire、generic fallback；只加 Host presenter 不算交付了 Web 卡片。
6. 自定义 Session 事件验证 append/derive/replay/fork/resume、未知事件与格式兼容；UI 状态由 projection/Conversation 派生，不另开真源。
7. 使用明确 flush 验证耐久性，不把 idle 或 `session/event` 当落盘确认；Domain 则验证其提交后变更通知顺序。
8. 外部进程验证 sandbox partial/full、执行世界路径、凭据清理、超时和实际资源停止；不可仅看 Promise 已返回。
9. Client 验证 lazy-CJS 产物、dsh.client manifest、裸包根行生命周期、slot owner 关闭重开；构建 watcher 与 HMR 必须实际观察。
10. Settings 验证多个实例、完整 Config 校验、stale revision、secret redaction、volatile `.get()` 快照与重启恢复。

---

## 15. 实际阅读记录与未覆盖范围

### 15.1 实际获取并用于本笔记的官方 Reference

“重点核对”表示已阅读与本文相关的正文/签名，不声称该大型页面每一行均已审计；“抽查”明确不是通读。URL 的 fragment 只用于定位，不冒充服务端仅返回该节。

| 组 | 实际页面 | 阅读范围 |
|---|---|---|
| 入口 | [Reference 首页](https://deepseek-harness.github.io/deepseek-harness/reference/)、[架构正文](https://deepseek-harness.github.io/deepseek-harness/reference/index.md)、[子系统索引](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/index.md) | 导航、组合与扩展地图、生成参考说明；架构页部分长内容未逐条审计。 |
| Cordis 概念 | [primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md)、[能力地图](https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams.md) | primer 核心段落；能力图按关键 ctx/owner/provider 抽查，未逐边核对整图。 |
| Cordis API | [Context](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/context.md)、[Events](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/events.md)、[Fiber](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/fiber.md)、[Registry](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/registry.md)、[Service](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/service.md)、[Inherited](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/inherited.md) | 重点核对入口、注入、effect、事件模式、派生 Context 与服务符号；Fiber 所有诊断字段未逐项展开。 |
| 实操参考 | [新增包](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-package.md)、[新增 Tool](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)、[LLM Adapter](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-an-llm-adapter.md)、[设置页](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card.md)、[扩展模式](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook.md) | 重点核对公开形状、工具/UI 分层、配置与加载。没有执行其中任何命令。 |
| 回路与工具 | [Agent 生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle.md)、[Tool 流水线](https://deepseek-harness.github.io/deepseek-harness/reference/tool-execution-pipeline.md)、[Core](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core.md)、[Scope](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/scope.md)、[Tools](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md) | 图与主要契约；Core/Tools 较长，重点类型/事件/取消，不声称所有 helper 的实现均核对。 |
| 模型上下文 | [LLM](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming.md)、[System Prompt](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/system-prompt.md)、[Compaction](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction.md)、[Skills](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills.md) | adapter/source/request 与 section/目录/日志扩展；未穷举 StreamChunk 每一字段或具体 provider 算法。 |
| 日志与数据 | [Session](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session.md)、[Persistence](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/persistence.md)、[Session Projection](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-projection.md)、[Storage](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/storage.md)、[Spill](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/spill.md) | 真源/句柄/flush/纯投影/普通数据与大文本边界；未审计全部崩溃恢复及 migration 实现。 |
| 浏览器 | [Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md)、[Client Modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)、[Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)、[Conversation](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/conversation.md)、[Resources](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-resources.md)、[Sidebar](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right.md) | 重点扩展协议、owner、生命周期及明确限制；大型 slot 树和 Conversation 所有 group 类型未逐项摘录。 |
| 跨端 API | [API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway.md)、[Typert](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/typert.md)、[WebServer](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server.md) | decorators、生成顺序、wire identity/cancel/stream、路由与安全分层；未审计物理 carrier 实现。 |
| 执行能力 | [Filesystem](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/filesystem.md)、[Sandbox](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sandbox.md)、[Subprocess](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subprocess.md)、[Shell](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/shell.md)、[Jobs](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/jobs.md)、[PTC](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/ptc-runtime.md) | seam、政策与资源所有权、信号和结果；未逐平台验证。 |
| 交互与配置 | [Approval](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/approval.md)、[User Questions](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions.md)、[Commands](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/commands.md)、[Settings](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/settings.md)、[Credentials](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/credentials.md) | 审批/问答边界、命令与即时表单、秘密引用；账号计费/赠金等细节未深入。 |
| 诊断 | [Invariants](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/invariants.md)、[Session Telemetry](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-telemetry.md) | 注册与不变式含义、脱敏/交接/耐久身份；未审计具体 exporter。 |
| 生成目录 | [Config Catalog](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog.md)、[Tool Catalog](https://deepseek-harness.github.io/deepseek-harness/reference/tool-catalog.md)、[Persistence Catalog](https://deepseek-harness.github.io/deepseek-harness/reference/persistence-catalog.md) | 获取并抽查目录原则、tool-package map、hooks Config、header/envelope/事件指纹；页面非常大且获取结果有截断，**未逐工具、逐配置、逐展开类型通读**。 |

### 15.2 失败、未读取与未验证的部分

- `/reference/subsystems/hooks.md`、`extensions.md`、`boot.md`、`mcp.md` 本次均得到 **HTTP 404**；不能据此断言功能不存在。索引对 boot/mcp 指向 GitHub 文档，并非保证这些站点路径已发布。
- 多次官方 raw/blob 请求（包括 LLM message 源、tools index/types、vendor/root manifest、hooks README 以及部分 GitHub docs 源文件）失败；没有将失败请求列为“已读”。GitHub API 返回大份 base64 也没有被冒称整份源码已审读。
- 未专门阅读的细分参考包括：Session query/reference/title、token meter、terminal、LSP、Web provider、workflow/subagent、permission presets/plan、goal/schedule、attachment/MCP/SSH、Office 转换、feedback/deliverables、OTel/product telemetry 等；虽在导航/相关页面见到链接或摘要，**摘要不等于已读这些页面**。
- 未审计 Runtime 底层安全实现、全部机器生成 slot catalog、测试套件、历史格式迁移或所有导出包。未确认本机 GUI 实际使用的 Client 产物 revision。
- 未进行编译、测试或可运行插件交付。本笔记是可追溯研究基础；“已精通”仍需通过目标版本的实现与验证闭环来证明。
