# DSH 插件开发学习笔记

> 采集日期：2026-10-15。入口：[官方开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)。
>
> 范围：完整阅读开发导航的 **18 页**，补读入门导航的 **7 页**，并结合插件开发相关参考文档与本地 `0.2.0-rc.2` 提取件核对。这里不声称逐页通读官网全部子系统、生成目录的每一个字段，或已在当前桌面版实测全部 API。官网是可变化的在线文档，不能自动等同于项目锁定的版本。
>
> 源码版本锚点：采集时官方 `master` 为 [`571902028a75c64c1d767f4ae5fd099485f0ddf0`](https://github.com/deepseek-ai/deepseek-harness/commit/571902028a75c64c1d767f4ae5fd099485f0ddf0)，提交说明为同步 `0.2.1-alpha.3`，其中 CLI 与根包的版本变更也可由 [GitHub API](https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/571902028a75c64c1d767f4ae5fd099485f0ddf0)核对。这不证明文档站部署恰好对应此 commit，更不等于本机已升级。
>
> 本次仅研究和新增笔记；未修改运行时代码、安装插件、启动替代服务器、发起模型验证请求或更改当前 DSH 配置。参考 API、客户端扩展和版本差异另见[研究附录](<dsh-plugin-reference-notes.md>)。

## 1. 总体模型：先选择正确的扩展点

DSH 的工具、模型适配器、持久化、策略、Web 界面以及 agent loop 都通过 Cordis 插件组合，而不是把插件理解为对一个特权核心打补丁。一个需求应先确定它属于服务、事件、工具、客户端扩展还是应用组合。[架构](https://deepseek-harness.github.io/deepseek-harness/reference/)；[能力设计](https://deepseek-harness.github.io/deepseek-harness/develop/practice/index.md)

| 需求 | 优先机制 | 核对入口 |
| --- | --- | --- |
| 让模型获得新能力 | `ctx.tools.register(...)` | [工具教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool.md) |
| 提供可替换后端 | Service Definition / Provider / Consumer | [三种角色](https://deepseek-harness.github.io/deepseek-harness/develop/practice/index.md) |
| 拦截模型请求、工具调用、审批 | 对应事件及其声明的分发模式 | [事件教程](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events.md) |
| 提供新模型路由 | `ctx.llm.registerAdapter(...)` | [LLM 适配器](https://deepseek-harness.github.io/deepseek-harness/develop/practice/llm-adapter.md) |
| 扩展页面、侧边栏、工具卡片 | Client 模块 + 类型化 Slots | [客户端模块](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)；[Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md) |
| 持久保存插件启用与配置 | bundle patch + profile / Plugin Manager | [打包安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md) |
| 观察可回放事实 | `session/event` 和会话事件日志 | [架构](https://deepseek-harness.github.io/deepseek-harness/reference/) |
| 给不同会话不同能力 | agent preset、服务 realm、作用域注册 | [架构](https://deepseek-harness.github.io/deepseek-harness/reference/)；[作用域](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/scope.md) |

工程原则：先使用已有扩展点，只有确实缺失契约才考虑修改框架。简单工具不预防性拆成多个包；角色需要独立替换或演进时再拆分。[能力设计](https://deepseek-harness.github.io/deepseek-harness/develop/practice/index.md)

## 2. 插件、Fiber 与资源生命周期

### 2.1 插件的三种形态

- 函数插件：Loader 常用命名导出的 `apply(ctx, config)`；代码内也可以直接 `ctx.plugin(fn)`。
- 对象插件：带 `apply`，可声明 `name`、`inject` 等元数据。
- 类插件：`Service` 子类；适合向其他插件发布命名服务。

`name` 导出是诊断元数据，不等于 Loader 行的模块指定符，也不等于稳定行 `id`。TypeScript 声明合并只提供类型，不会创建服务、注册监听器或加载插件。[第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/index.md)；[Cordis 第 1 章](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/01-first-plugin.md)

### 2.2 状态与依赖

```text
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

- 必需服务未满足时，Fiber 合法地保持 `PENDING`，不运行 `apply`。
- 配置校验或初始化抛错导致 `FAILED`。
- 必需服务被卸载时，消费方的活动实例随之清理；服务恢复后可重新激活。
- 配置行并发启动，YAML 排列顺序不保证 `apply` 先后；依赖通过 `inject` 表达。
- 单纯 `PENDING` 不会维持 Node 事件循环，因此教程可能无输出、以状态码 0 退出；这不等于插件已成功工作。

来源：[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md)；[服务教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/03-services.md)

### 2.3 Effect 的真实边界

`ctx.on()`、子插件以及具备 Cordis 生命周期接线的内置注册 API，会随所属插件释放。原生 `setInterval()`、文件 watcher、网络连接、普通 DOM 监听器等不会因为写在 `apply` 内就自动变成 effect；需显式包装。[Cordis 第 2 章](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/02-lifecycle-and-effects.md)

```ts
ctx.effect(() => {
  const timer = setInterval(() => heartbeat(), 5000)
  return () => clearInterval(timer)
})
```

`await fiber.dispose()` 会等待子插件及异步清理完成。多个 disposer 按注册逆序开始调用，但异步 disposer 可并发完成；需要“先停止生产、再关闭连接”的顺序时，放在同一个 async disposer 中依次 `await`，不能依赖不同 effect 完成顺序。[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md)

## 3. 服务、依赖与隔离：三个概念不要混淆

1. **Cordis 服务依赖**：`inject = ['tools']` 等待服务，使用 `ctx.tools`。可选服务可在使用处通过 `ctx.get('serviceName')` 探测，不应把必需能力缺失静默吞掉。[服务与依赖](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service.md)
2. **Cordis realm / `isolate`**：让不同组看到同名服务的不同实例；它解决服务解析和实例隔离问题。[隔离示例](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service.md#service-isolation)
3. **DSH scope / preset**：感知 scope 的工具、提示词等贡献按 agent 或 preset 继承和遮蔽；不是每个任意服务调用都会因此被隔离，更不是 OS 安全沙箱。[作用域](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/scope.md)；本地 [Scope 参考](<../../.reference/dsh-scope/README.zh.md#L25-L46>)、[限制](<../../.reference/dsh-scope/README.zh.md#L95-L103>)

本地 preset 参考还说明：活动 Agent 持有其已绑定代际；更新或移除定义不代表所有旧 Agent 立即换实现。最后一个引用释放后才销毁退役插件树，重启恢复则按 preset ID 查找当前定义。[本地 preset 参考](<../../.reference/dsh-agent-preset-registry/README.zh.md#L46-L58>)

**安全结论**：隐藏模型可见工具、选择 preset、服务隔离和限制执行权限是不同层。真正的只读模式还需执行入口守卫、文件与进程能力约束、必要的 OS 沙箱。不能用“模型没有看见某个工具”代替执行授权。[Scope 的非安全目标](<../../.reference/dsh-scope/README.zh.md#L58-L60>)；[preset 的非安全目标](<../../.reference/dsh-agent-preset-registry/README.zh.md#L91-L95>)

## 4. 事件：分发模式就是接口契约

| 模式 | 语义 | 常见误用 |
| --- | --- | --- |
| `emit` | 同步广播，不等待返回的 Promise、不收集返回值 | 把异步初始化放入 emit 并假设调用方会等待 |
| `parallel` | 并发运行所有监听器并一同等待 | 假定监听器按顺序完成 |
| `serial` | 依次等待；首个非 `null` / `false` / `undefined` 的返回值短路 | 观察者意外 `return` 一个业务对象 |
| `bail` | serial 的同步版本 | 把 `0` 或空字符串当作“继续” |
| `waterfall` | `(...args, next)` 环绕中间件 | 日志监听器忘记 `return next()`，吞掉默认行为 |

只负责观察或标注的 waterfall 监听器必须委托；只有明确拥有拒绝或替换决策的监听器才主动短路。异步 waterfall 的返回值仍应按事件签名 `await`；不要把概念表的“无需 await”理解为所有 waterfall 都同步。[Cordis 第 4 章](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/04-events.md)；[事件参考](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md)

### 持久事实与运行时钩子

- `agent/*`、`tools/*` 等是运行时扩展事件，必须查所属子系统的具体签名和模式。
- `turn/start`、`step/end`、`tool/call`、`tool/result` 等是持久会话事件类型，不是同名 `ctx.on` 事件。
- 观察持久事件时应监听 `session/event` 再判断 `event.type`。
- 模型可见历史以日志为来源；新模型可见输入应走公开准入路径，不能只偷偷修改发给模型的临时数组。

来源：[框架事件](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events.md)；[架构与模型可见即已记录原则](https://deepseek-harness.github.io/deepseek-harness/reference/)

## 5. 配置：Schema、热更新与部署边界

### 5.1 Config 必须是运行时验证器

导出 TypeScript `Config` 类型与同名 schema；Cordis 接受 Standard Schema，官网主要演示 Schemastery。普通对象或仅有 interface 不提供运行时校验。schema 应声明必填、默认值和自足约束；资源引用则在所需依赖就绪、能够解析时明确拒绝错误。[基础配置](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config.md)；[Cordis 第 5 章](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/05-config.md)

本项目实际用 Zod 4 导出 schema，而不是 Schemastery；这应按 Standard Schema 支持判断，不能机械地把文档示例库当作唯一合法实现。[Host Config 实现](<../../src/index.mjs#L9-L20>)

### 5.2 普通字段与 volatile 字段

- 普通字段：配置变化通常走原有更新流程，可能卸载并重建实例。
- `.volatile()`：运行时配置包含稳定引用，使用 `.get()`；仅合法的 volatile 值变化可原位提交并发出 `loader/volatile-update`，不重挂载目标实例。
- 单次操作可以保存读到的快照（包括跨 `await`），不能把它当作以后每次操作都最新的值。
- 对象/数组值脱离输入并递归冻结；独立引用的嵌套位置有限制，不能任意嵌入 union、数组元素等位置。
- 无效候选不替换当前引用；普通字段同时变化、依赖变化和代码重载不承诺保留该引用。
- 更新通知使用 `emit`，不等于异步外部资源已重配置完成。

来源：[volatile 完整契约](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/05-config.md#volatile-fields)。本地 `0.2.0-rc.2` 提取实现确实使用 `selectedDefault: z.string().volatile()` 与 `.get()`，但这只证明该用法存在，不证明已在本任务中回归测试全部边界：[实现](<../../.reference/dsh-agent-preset-registry/lib/types/index.js#L60-L90>)。

### 5.3 `!!js` 不是任意元数据模板

表达式在 `config` 中于声明依赖激活后求值；`disabled` 在挂载决策时基于 Loader 上下文求值。`name`、`id`、`inject` 等其他元数据保持静态字面值。不要用 `!!js` 拼动态模块名或把来自不受信任用户的数据当作可执行配置。[配置教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/05-config.md)；[Loader 配置](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.md#loader-configuration)

## 6. 工具：参数、规范输出、模型结果与 UI 四层分开

`defineTool` 根据参数 DSL 推导参数类型、产生模型 schema，并在执行前校验输入。`execute` 返回 `output.schema` 声明的规范值；`output.render` 把规范值转为模型消费、可持久化的结果内容。不要把任意 ToolResult、React 元素或格式不符的字符串当成规范值混在一起。[工具教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool.md)；[进入 Harness](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/07-into-the-harness.md)

### 最小组合示例（阅读模板，未在本任务运行）

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'example-greeting'
export const inject = ['tools']
export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
})

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  ctx.tools.register(defineTool({
    name: 'example_greet',
    description: 'Greet a person by name.',
    parameters: {
      name: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `${config.greeting}, ${args.name}!`
    },
  }))
}
```

独立测试不一定要调用模型：教程第 7 章直接经 `ctx.tools.execute` 驱动真实工具流水线，携带 branded `callId`、参数和取消信号。最小组合还需 `systemPrompt` 提供方，否则 `tools` 自己可能等待依赖。[无需密钥的测试教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/07-into-the-harness.md)

更复杂工具还需核对取消、幂等、审批、guard、后台 jobs、PTC 与结果回放。自定义 Web 工具卡片走客户端 keyed slot，而不是假定 Host `presentCall` / `presentResult` 会被内置 Web Client 渲染。[工具编写参考](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.md)；详见[研究附录](<dsh-plugin-reference-notes.md>)。

### 关键执行边界

当前在线参考给出的主路径是 `pre-execute → monotonic guards → execute → projectContent → post-execute → finalizeContent → tools/result`。Guard 只能追加拒绝，不能强制 allow 覆盖其他拒绝；`restrict` 过滤继承工具，但不约束该 scope 自己注册的工具，因此不能把它当作唯一安全白名单。参数在策略前物化并冻结，不应通过中间件偷偷改写已记录输入。[工具执行参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)

成功的规范 `value` 是执行期数据，持久日志保存的是结果 `content`、结构化错误及 `meta` 等投影，而不是承诺保存完整规范中间值；仅替换模型可见 `content` 不会擦除程序调用方已取得的值。`execute` 必须观察或转发 `exec.signal`，在其拥有的异步工作停稳后才结算；`timeoutMs` 依赖对应策略且属于协作式取消，不是强制杀死同进程代码。作者侧 DSL 与原始 JSON Schema 都有受支持子集，不支持的关键字应被拒绝，不是“写进去就会验证”。[工具执行与 Schema 参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)

## 7. 能力三角色：接口与实现不要互相绑死

- **Definition**：声明服务名、方法及 Request / Result 类型。
- **Provider**：实现服务，如本地文件系统、远程执行后端。
- **Consumer**：消费服务，如模型工具、UI 或其他插件。

Provider 与 Consumer 只依赖 Definition，不互相依赖。完整能力的三种角色共同构成 seam，单个包或单个角色本身不等于 seam。默认值和目标解析尽量通过显式 `resolve(request): Spec` 完成，不在真正执行时藏一串不透明回退。[能力三角色教程](https://deepseek-harness.github.io/deepseek-harness/develop/practice/index.md)

## 8. LLM 适配器：协议、取消、元数据都属于实现责任

基础模式是继承 `LlmAdapter`，实现 `stream(options): AsyncIterable<StreamChunk>`，并向 `ctx.llm` 注册 provider 路由。`provider` 选择适配器，`model` 是适配器拥有的模型 ID，不应另造核心模型枚举。[LLM 适配器教程](https://deepseek-harness.github.io/deepseek-harness/develop/practice/llm-adapter.md)

必须遵守：

1. 内容块以 `block-start` 开始、以携带完整 block 的 `block-end` 结束；index 从 0 递增。
2. 文本使用 `text-delta`；工具参数使用原始 JSON 文本增量 `argumentsDelta`，完整 block 保留完整参数文本。
3. `usage` 在 `finish` 前；`finish` 为最后一个分片，区分正常停止与需要执行工具。
4. 支持的 `GenerateOptions` 字段必须映射；无法支持时抛带稳定 code 的 `LlmError`，不能静默丢弃。
5. 流请求及异步模型解析传递取消信号；每个提供方 HTTP 请求合并 `attributionHeaders()`。
6. `resolveModel()` 返回权威 provider/model 身份、可选 context 和 reasoning 元数据；reasoning ID 是适配器拥有的不透明字符串，保留其顺序与 `off` 等合法选择。
7. `listModels()` 用于公布可选模型；完整字段以目标版本类型为准，示例不是整个协议实现。

来源同上；模型发现与路由选择的用户行为另见[模型配置指南](https://deepseek-harness.github.io/deepseek-harness/guide/providers.md)。本次未接入真实新提供方，未对网络取消、分片错误等进行实测。

## 9. Bundle、Profile 与 patch：分发和应用组合

- bundle 是声明 `dsh.bundle.patch` 的 npm 包，描述“贡献什么配置层”。patch 可以是一个文件或按顺序应用的文件列表。
- profile 是 Harness home 下的应用组装，`dsh.profile.bundles` 描述“按什么顺序组合哪些 bundle”；不是另一个普通插件包。
- 只有安装 npm 依赖而没有 bundle 元数据，不会自动激活其配置。
- `files`、`exports`、构建入口和 patch 引用要一致；共享运行时实例的 DSH 依赖按官方规则声明 peer 与开发依赖，不能把另一个宿主实例随意打包进去。

来源：[发布教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md)

### 层优先级

```text
空配置树
  → profile.bundles 中各 bundle（顺序应用）
  → profile/cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → 各 --patch overlay（命令行顺序）
```

**配置覆盖替换目标行的整个 `config`，不是对象深合并。** 修改已有 provider、preset 或业务插件前先读取完整现值，保留仍需存在的字段。稳定 `id` 用于识别同一行；无 `id` 的配置在重读时可能获得新身份，造成无关实例重挂载。[发布教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md)；[组合教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr.md)

### 路径语境不要混用

- 外部 `--patch` 的入门例子要求本地插件绝对路径，overlay 本身不自动把 Loader 基准切到其目录。
- 已安装 bundle 可以按包名或公开子路径引用模块；bundle 内 patch 的相对路径规则由发布教程单独说明。
- 裸 Cordis 教程的启动器直接从当前目录加载配置，所以其中 `./hello.ts` 不能直接证明任意外部 overlay 都按 overlay 目录解析。

[基础入口](https://deepseek-harness.github.io/deepseek-harness/develop/basic/index.md)与[基础配置页](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config.md)存在例子衔接不一致：后者又写了 `./src/my-plugin.ts`。开发时应先明确 Loader/profile 解析基准，不凭示例猜路径。

### 安装与生效不是一个状态

源码 Git 安装不天然包含构建产物。使用 `prepare` 可能需要 pnpm 显式批准安装期代码执行，该权限不在模型执行沙箱之内；可信发布产物或预构建 tarball 可以避免这种构建授权。[发布教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md)

持久插件管理必须区分 `application: applied` 与 `restart-required`。后者表示保存成功但尚未在当前进程激活；需要按宿主要求重启，不能只告诉用户“已经能用”。[持久化插件实践](https://deepseek-harness.github.io/deepseek-harness/develop/practice/dynamic-cordis.md)

## 10. Client 插件与 HMR：先确认谁在构建、谁在加载

客户端模块声明 `dsh.client`、导出 `./client`，运行构建后的浏览器 bundle。模块 factory 的注册和真正物化是两件事，纯类型 import 不形成运行时依赖；React 等平台共享模块不可随意复制另一份。[客户端模块官方参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)；[本地模块说明](<../../.reference/dsh-client-modules/README.zh.md#L32-L50>)

内置 Slot 有 `single`、`list`、`keyed`、`chain` 四类；声明决定渲染授权和子 Slot 生命周期。不要臆造插槽名、随意覆写已有子槽，或用未经声明的 React props 替代框架推导 props。[Slots 官方参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)；[本地 Slot 说明](<../../.reference/dsh-client-ui-slots/README.zh.md#L25-L46>)

HMR 至少分开判断：

1. Loader 是否观察配置，配置能否动态应用；
2. Host 插件源码是否处于被观察、可重载的范围；
3. Client bundle 是否实际重建，并由当前页面的模块系统接收；
4. 静态 shell / 平台共享模块是否需要重新构建与页面刷新；
5. 当前桌面 profile 的安装事务是否要求完整进程重启。

教程启用源文件 HMR 的配置包含 logger、timer 与 HMR；缺 timer 会使 HMR 保持 PENDING。架构页又明确 base 默认是“仅监视配置”，因此“加载了 HMR 插件”不自动推出“所有源码保存后都会更新”。[HMR 教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr.md)；[架构](https://deepseek-harness.github.io/deepseek-harness/reference/)

对当前项目，已读到的发布约定是重新构建、打包、安装，按结果重启 Host 或刷新 Client；没有在本任务中验证开发 watcher，因此不承诺当前页面会自动更新。[项目兼容性说明](<../../README.md#L84-L105>)；[实际构建器](<../../scripts/build.mjs#L14-L19>)

## 11. 入门指南补读：与插件开发有关的运行边界

- 模型凭据不应经普通 settings 明文读回；指南描述凭据存储与脱敏 descriptor，模型设置在下一次请求生效。[配置模型](https://deepseek-harness.github.io/deepseek-harness/guide/providers.md)
- 自定义 API 协议、图片能力、reasoning 和兼容开关必须与端点真实能力匹配；UI 声明不是能力探测或保证。[配置模型](https://deepseek-harness.github.io/deepseek-harness/guide/providers.md)
- 代理变量在启动时读取；不应允许不受信任仓库的项目 `.env` 控制流量出口。Workflow/PTC、遥测等有单独的出站限制，不能推断所有网络路径统一代理。[网络代理](https://deepseek-harness.github.io/deepseek-harness/guide/network-proxy.md)
- Python SDK 也通过 DSH profile 和有序 patch 组合；示例的 `sdk-minimal` 明确不继承 base，默认权限很宽，不应拿普通 web 组合的安全假设套用。[Python SDK](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk.md)
- Webhook 返回 `202` 只表示已接受签名/JSON并调度规则，不保证 Session 创建或任务完成，也不保证幂等交付。[GitHub 评审](https://deepseek-harness.github.io/deepseek-harness/guide/github-review.md)
- Schedule 已投递记录表示消息持久写入收件箱，不表示模型执行成功；不承诺恰好一次。该可选 bundle 并非发布 Web profile 的默认能力。[提醒指南](https://deepseek-harness.github.io/deepseek-harness/guide/schedule.md)
- MCP 客户端负责 stdio 生命周期或连接已运行的 HTTP 服务，并公开 `mcp__<serverName>__<tool>`；不负责替第三方安装服务、迁移数据或选择其模型。[记忆 MCP](https://deepseek-harness.github.io/deepseek-harness/guide/mcp-memory.md)

## 12. 与当前项目的对应关系（不是本次代码审计结论）

| 已读取位置 | 对应知识点 | 后续开发时要保持的边界 |
| --- | --- | --- |
| [包声明](<../../package.json#L7-L38>) | Host / preset / Client 多入口、bundle patch、运行时 peer | 以目标 `0.2.0-rc.2` 契约核对，不直接升级到官网最新示例 |
| [组合 patch](<../../cordis.patch.yml#L1-L4>) | 安装一个独立插件行 | 不替换普通工作区与默认编码 preset |
| [Host 入口](<../../src/index.mjs#L9-L54>) | Standard Schema、inject、工具 guard、事件、preset 注册 | 工具可见性与执行授权分开；依赖消失和启停后仍需 fail closed |
| [阅读 preset](<../../src/preset.mjs#L7-L34>) | preset 内工具与提示词贡献、原生工具规范值 | 不把旧 Agent 的保留代际误认成新定义；取消/结束轮次用公开执行接口 |
| [构建器](<../../scripts/build.mjs#L14-L19>) | Host ESM 与 Client 模块 factory 分开构建、共享 React | 保持 Host/Client 代码边界与实际产物协议一致 |
| [Client 接线](<../../src/client/index.jsx#L112-L116>) | `slots.inject` 等待声明，注册左侧入口与 keyed 主面板 | 贡献原生 Slot，不替换整个 DSH 外壳；样式随 effect 清理 |
| [既有验收记录](<../../VALIDATION.md>) | 项目已记录的真实轮次和隔离组件验证 | 该记录是历史证据，不代表本次重新执行过测试或点击过当前页面 |

本地提取件的一个版本锚点是 [Agent 包元数据](<../../.reference/dsh-agent/package.json#L1-L15>)。本任务尝试直接枚举安装提示中的 `app.asar/dsh` 路径，工具返回路径不存在；没有绕过权限或声称已经读取这个虚拟目录，源码核对使用了现有提取件和可访问的官方资料。

## 13. 后续实际开发的验收顺序

以下是本次整理的实施检查表，不代表已运行这些步骤：

1. **版本锚定**：确认宿主、目标 profile、已安装包版本与实际导出类型；记录在线文档与目标版本差异。
2. **扩展点选择**：确定 Host / Client / 工具 / 服务 / 事件的归属，以及全局、preset、agent 哪一层拥有能力。
3. **最小实现**：显式 `inject`；Config 使用 Standard Schema；资源归属于 effect；模型输出与持久事实走公开接口。
4. **离线验证**：配置错误、PENDING、依赖移除/恢复、工具参数/输出、取消、卸载/重载、重复注册、失败清理。
5. **策略验证**：执行 guard 不依赖提示词；真实读写/进程路径经过预期策略；跨会话和作用域泄漏、停用后的旧会话都需测试。
6. **分发验证**：先检查 tarball 文件清单与导出，再检查最终配置树；不覆盖整份用户 patch，不批准不必要的安装期脚本。
7. **当前宿主验证**：区分保存、激活与 restart-required；在现有 DSH 地址验证 Host API、实际 Client 资源、组件接线和错误回退，不以另起 dev server 冒充插件生效。
8. **记录证据**：分开写明自动化测试、隔离组件验证、真实运行观察和未验证范围。

这份检查表依据[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md)、[发布教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md)、[工具教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/07-into-the-harness.md)与[持久插件实践](https://deepseek-harness.github.io/deepseek-harness/develop/practice/dynamic-cordis.md)综合整理。

## 14. 开发导航完整阅读清单（18/18）

| 编号 | 页面 | 覆盖主题 |
| --- | --- | --- |
| D01 | [第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/index.md) | apply、inject、绝对路径 overlay、插件形态 |
| D02 | [开发一个工具](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool.md) | defineTool、参数 DSL、规范输出 |
| D03 | [插件配置](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config.md) | Standard Schema、默认值、部署参数 |
| D04 | [打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md) | bundle/profile、解析、覆盖、安装构建授权 |
| D05 | [插件与生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md) | Fiber、effect、依赖、异步 teardown |
| D06 | [服务与依赖](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service.md) | Service、声明合并、可选依赖、isolate |
| D07 | [事件系统](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events.md) | 分发模式、持久事件与钩子的区别 |
| D08 | [能力三角色](https://deepseek-harness.github.io/deepseek-harness/develop/practice/index.md) | Definition / Provider / Consumer |
| D09 | [LLM 适配器](https://deepseek-harness.github.io/deepseek-harness/develop/practice/llm-adapter.md) | 流式协议、取消、错误、模型元数据 |
| D10 | [持久化插件配置](https://deepseek-harness.github.io/deepseek-harness/develop/practice/dynamic-cordis.md) | Plugin Manager、MCP、applied 与重启 |
| D11 | [Cordis 教程总览](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/index.md) | 裸框架启动器与真实 Harness 的区别 |
| D12 | [第 1 章：第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/01-first-plugin.md) | 模块、组合、加载错误与解析失败 |
| D13 | [第 2 章：生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/02-lifecycle-and-effects.md) | 自定义资源、递归 dispose、清理顺序 |
| D14 | [第 3 章：服务](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/03-services.md) | PENDING、依赖跟踪、命名与类型 |
| D15 | [第 4 章：事件](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/04-events.md) | 五种模式、waterfall 的有意短路 |
| D16 | [第 5 章：配置](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/05-config.md) | volatile、快照、通知、`!!js` |
| D17 | [第 6 章：组合与 HMR](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr.md) | id、group、isolate、logger/timer、诊断 |
| D18 | [第 7 章：进入 Harness](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/07-into-the-harness.md) | 无模型执行真实工具流水线 |

## 15. 入门导航完整补读清单（7/7）

[G01 Web UI](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart.md) · [G02 模型](https://deepseek-harness.github.io/deepseek-harness/guide/providers.md) · [G03 代理](https://deepseek-harness.github.io/deepseek-harness/guide/network-proxy.md) · [G04 Python SDK](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk.md) · [G05 GitHub 评审](https://deepseek-harness.github.io/deepseek-harness/guide/github-review.md) · [G06 Schedule](https://deepseek-harness.github.io/deepseek-harness/guide/schedule.md) · [G07 记忆 MCP](https://deepseek-harness.github.io/deepseek-harness/guide/mcp-memory.md)。

## 16. 已知局限与后续查证原则

- 本次学习建立可复用的知识索引，不等于修改模型权重或永久记忆。后续新会话可重新读取本笔记，关键 API 仍需查当前目标版本。
- 官网示例有路径上下文衔接、HMR 简化描述等差异；附录另列参考内部的版本漂移。优先目标版本公开类型、实现与可重复测试，不猜测“兼容”。
- 本机提取件属于参考快照；它们不是当前安装进程已加载模块的逐项证明。
- 未执行官网的克隆、安装、模型调用、MCP 接入及 HMR 实验；未把既有项目的验收记录冒充本次测试。
- 生成配置目录、工具目录、事件目录和各子系统数量较大，本次补读以插件相关接口为主；未将整个官网和所有源码逐行阅读声明为完成。

## 17. 情景自测：能否用契约解释现象

以下是依据已引来源整理的判断题，不是本次运行实验的输出。

| 现象或方案 | 判断与定位 |
| --- | --- |
| 把提供方移到 YAML 第一行，消费方就一定先后有序吗？ | 不一定。配置行并发挂载，应检查 `inject` 和对应服务是否就绪。 |
| 插件无日志、进程状态码 0，能说明它已激活吗？ | 不能。缺少服务时 Fiber 可以一直 PENDING，且不维持事件循环；检查 registry/fiber 与模块解析日志。 |
| 只记录日志的 `agent/request` 监听器不调用 `next()`，有问题吗？ | 有。它会短路 waterfall；观察者必须委托，拥有明确拒绝决策才故意短路。 |
| 两个 async disposer 按逆序注册，就能保证连接在写入全部结束后才关闭吗？ | 不能。它们可并发完成，需要在同一个 disposer 中先等待写入停稳再关闭连接。 |
| patch 只写 `config.timeoutMs`，其他配置键会自动保留吗？ | 不会由 patch 机制深合并；覆盖会替换整个目标 `config`，必须保留其他所需键。 |
| 工具的输出 schema 是 string，`execute` 返回 text block 数组是否正确？ | 不正确。执行体返回规范字符串，`output.render` 再返回内容块数组。 |
| 模型工具列表没有 `bash`，就可以删掉执行 guard 吗？ | 不可以。可见性与执行授权不是同一个边界；还需防止其他调度入口或作用域贡献绕过设计。 |
| 后置策略只把 `content` 改成“已脱敏”，就能阻止 PTC 程序拿到规范值吗？ | 不能。内容替换保留规范值；保密需要在值产生/分发之前约束，或按公开契约 block/替换值。 |
| `plugin_manager` 返回 `restart-required`，刷新浏览器就足够吗？ | 不一定。Host 配置尚未激活时需按安装结果重启进程，浏览器刷新不等于重载 Host。 |
| 直接升级到官网最新示例中的类型，就能兼容当前插件吗？ | 不能这样推断。先锚定宿主和依赖版本，核对公开导出与实际实现，再测试变更。 |

题目依据：[服务](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/03-services.md)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/index.md)、[事件](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/04-events.md)、[发布](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md)、[工具执行](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md)、[持久插件管理](https://deepseek-harness.github.io/deepseek-harness/develop/practice/dynamic-cordis.md)。
