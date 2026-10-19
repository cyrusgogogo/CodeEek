# AGENTS.md

## 项目定位

本仓库是 `dsh-code-reading`：DSH 原生代码阅读插件，由 Node.js Host、独立 Agent preset 和 React Client 组成，不是独立 Web 应用。

- 代码沿用 JavaScript ESM（`.mjs`）、React JSX 和原生 CSS；构建使用 esbuild。依赖、运行时要求和命令以 [package.json](<package.json>) 为准。
- 用户交互默认使用中文。新增界面文案沿用“阅读项目、阅读会话、知识点、证据、批注”等现有术语。
- “只读”指插件运行时对**被阅读仓库**的约束，不禁止按开发任务修改本插件源码。
- 当前阅读流程按问题或选区组织内容，每轮一个知识点；`stage` 是兼容状态，不是必须依次完成的五阶段向导。理解自查按用户需要开展。

## 开始任务

1. 查看工作树现状，区分已有改动与本次改动；当前任务不授权清理、回滚或提交其他人的工作。
2. 根据下表读取对应入口及回归，确认改动涉及的契约和持久化字段后再编辑。产品行为以当前源码和 [README](<README.md>) 为依据，历史验收报告不代表当前版本结果。
3. 优先在现有模块内完成局部修改；引入框架、运行时依赖、数据迁移或扩大工具权限前，先说明必要性和兼容影响。

| 修改范围 | 先读这些入口 |
| --- | --- |
| Host、API、生命周期、模型调用 | [Host](<src/index.mjs>)、[API Client](<src/client/api.mjs>)、[Host 兼容回归](<test/host-compatibility.test.mjs>)、[接线回归](<test/integration.test.mjs>) |
| Agent 工具、输入校验、阅读行为 | [preset](<src/preset.mjs>)、[契约](<src/contracts.mjs>)、[导师 skill](<skills/code-tutor/SKILL.md>)、[阅读回归](<test/reading.test.mjs>) |
| 档案、证据、并发、阅读位置 | [store](<src/store.mjs>)、[文件边界](<src/filesystem.mjs>)、[位置回归](<test/reader-state.test.mjs>) |
| 源码工作台、选区、批注 | [Host 工作台](<src/workspace.mjs>)、[批注锚点](<src/anchors.mjs>)、[阅读器](<src/client/reader.jsx>)、[工作台回归](<test/workspace.test.mjs>) |
| 阅读页面、主题、展示 | [页面入口](<src/client/index.jsx>)、[知识点工作台](<src/client/workbench.jsx>)、[基础样式](<src/client/style.css>)、[工作台样式](<src/client/workbench.css>) |

## 运行时安全与一致性

修改上述模块时保持以下不变量；改变不变量属于协议或安全边界变更，须明确说明并补充回归。

- **仓库隔离**：仓库绑定不可随普通 DSH 工作区切换而改变；所有源码操作校验项目、会话和 `repoId` 的归属。产物根与源码根互不重叠、互不嵌套。
- **文件边界**：复用 [filesystem](<src/filesystem.mjs>) 的路径、链接、文件身份、UTF-8 和资源预算检查；搜索保持有界字面量匹配。截断结果须显式报告，不能解释为完整扫描。
- **工具边界**：白名单以 [contracts](<src/contracts.mjs>) 的 `TOOL_NAMES` 为准；同时保留 Host 根守卫和 preset 守卫，停用后保留的工具也必须拒绝执行。源码读取不执行被阅读项目的代码。这是插件边界，不宣称是 OS 沙箱或原子跨仓快照。
- **证据与批注**：证据绑定实际读取字节的 SHA256、仓库、路径和行号；打开及发布时重新核验。源码变化时保留失效或待复核状态，批注仅提供候选位置，由用户确认或重绑，不静默猜测新行号。
- **持久化与并发**：状态修改沿用 store 锁、原子文件提交、revision/CAS 和事件幂等机制；阅读位置 revision 独立于阶段 revision。扩展档案格式时兼容旧记录，并保留取消、停用和迟到响应的准入检查。
- **模型与隐私**：使用宿主会话控制器和认证传输。首次调用及提供方、模型或绑定变化时重新确认源码发送范围；不能仅凭模型名称判断本地部署。阅读位置只存元数据，不把源码或对话新增到浏览器持久化存储；网络结果未确认时先核对状态，不盲目重发写操作。

## Client 修改约定

- 使用 DSH 原生模块工厂与 slots 集成；React/ReactDOM 由宿主提供并在构建中 external，保持 [构建脚本](<scripts/build.mjs>) 对重复打包的检查。
- 样式限定在阅读插件命名空间，复用宿主主题 token。交互保留明暗主题、键盘操作、可见焦点、窄屏适配与减少动态效果支持；改文件工作台前读 [工作台 UI 约定](<docs/UI-FILE-WORKSPACE.md>)。
- 源码高亮 token 通过 React 文本节点展示；Markdown 保持 HTML 和外部媒体限制。Mermaid 保留输入校验、SVG 清洗、CSP 与受限 iframe。入口见 [代码高亮](<src/client/code-tokens.mjs>)、[Markdown](<src/client/index.jsx>)、[图表](<src/client/mermaid.jsx>)。
- 图标从有限本地映射获取，仓库文件名不转为资源 URL 或动态 import；调整第三方图标时先读 [来源与许可证](<src/client/icons/NOTICE.md>)，同步维护来源、哈希和许可清单。

## 验证流程

在仓库根目录运行命令。环境准备和完整命令说明见 [README 开发与验证](<README.md#开发与验证>)；推荐支持 zstd 的 Node.js 24 LTS。依赖缺失时按文档使用冻结锁文件和禁用安装脚本的方式安装，不自行改变全局包管理器设置。

1. **定向回归**：为行为变更补充对应测试，先运行受影响的回归，例如：

   ```powershell
   node --test test/reader-state.test.mjs
   ```

2. **代码验收**：运行 `pnpm run check`，覆盖构建、Node 回归、隔离浏览器和 doctor。浏览器回归读取真实 Client 构建，单独运行时先执行 `pnpm run build`。浏览器路径可由 `DSH_TEST_BROWSER` 指定；缺少 Chrome 或 zstd 时明确报告未覆盖项，不将跳过称为全部通过。
3. **文档分支**：仅修改本文等非构建输入时，检查内容、链接和 `git diff --check` 即可；修改 [构建脚本](<scripts/build.mjs>) 中 `publishedInputs` 所列文档或导师 skill 时，还需重新构建并运行 `pnpm run doctor`，避免输入哈希过期。
4. **验收边界**：浏览器测试拦截 HTTP、使用模拟模型，是隔离组件测试，不是已登录 DSH GUI 的端到端测试。仅在确实安装并验证后，才报告运行中应用已更新。

测试临时数据放在 [.test-output](<.test-output/>) 下；验证默认不触碰真实用户阅读档案、不发起真实模型请求。

## 构建、发布与宿主更新

- [src](<src/>) 和 [scripts](<scripts/>) 是修改入口；[lib](<lib/>) 是生成目录，通过构建更新，不手改 bundle、sourcemap 或构建哈希。[.reference](<.reference/>) 是本机提取的参考材料，不是可发布源码。
- 版本由 [package.json](<package.json>) 经 [version](<src/version.mjs>) 读取。升级 DSH 兼容版本时同步核对 engines、相关 peer、锁文件和兼容回归；保留 Host/Client 版本门禁。
- 只有任务要求发布时才执行 `pnpm run pack:release`；[releases](<releases/>) 中既有归档、校验文件和报告保持不可变。发布新内容先提升包版本，重复演练使用仓库内新的测试输出目录，不通过删除旧包绕过覆盖保护。
- 静态归档检查使用 `verify:package`；`test:package -- --trusted` 会执行包内代码，只用于已确认可信的归档。细节见 [README 包验证](<README.md#开发与验证>)。
- 安装、升级、回退或 Host/Client 不一致时，先读 [安装手册](<docs/INSTALL.md>)。修改源码或构建不会自动更新已安装 DSH；按安装器要求完整重启 Host 或刷新 Client，不能承诺自动 HMR。
- 默认只在本仓库开发验证；安装进当前 DSH、修改已安装程序、启动替代服务器或请求真实模型，须由用户明确要求。

## 完成标准

交付时说明修改内容、实际运行的验证及结果、未覆盖项；区分“源码已改”“构建已生成”“插件已安装”“运行中 GUI 已验证”。当前任务不涉及发布时，不顺带升级版本或重打发布归档。
