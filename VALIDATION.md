# 阅读代码 0.1.1 · 验收记录

## 结论

**重启后的真实阅读轮次已核验通过。** 插件在当前桌面 DSH 中运行，不再处于等待重启的状态。本次续验只读检查既有结果，没有向阅读会话追加 prompt、执行目标项目或修改其源码。

- 插件：`dsh-code-reading@0.1.1`；目标 DSH：`0.2.0-rc.2`，profile：`desktop`。
- 原主进程 PID `6068` 已退出；新主进程 PID `65180` 启动于本地时间 `2026-10-15 11:16:30`。
- 当前 Client 已注册 `sidebar.panellist` 的 `code-reading` 入口，顺序 `10`；未替换普通工作区或对话入口。
- 安装通过 DSH Plugin Manager 完成，未修改 DSH 核心源码、运行依赖安装脚本或授予版本豁免。

## 一、真实项目与原生轮次

检查对象是用户重启后已创建并运行的“工具小程序”项目，不是测试夹具。

| 检查项 | 已观察结果 |
| --- | --- |
| 绑定 | 1 个真实仓库，绑定 revision 保持 `1` |
| 当前阅读状态 | 发现业务，状态 revision `7` |
| 人工阶段操作 | 6 次，均有审计记录 |
| 已发布知识点 | 1 个 |
| 源码证据 | 12 条，归属和范围校验通过，12 条当前 SHA256 全部匹配 |
| 原生工具调用 | 23 次，全部属于五个专用工具；其中 14 次读取调用产生 12 条成功证据 |
| 工具可见性 | 请求头恰好只含 `reading_catalog/files/search/read/publish`，无 shell、任意写文件或子代理工具 |
| 原生 preset | `code-reading` |
| 原生 cwd | 与该会话固定产物目录完全一致，不是目标源码目录 |
| 生效沙箱模式 | 在模型请求前已设为 `read-only` |
| 原生结束原因 | `completed` |
| 审计 | 27 条完整 JSONL 记录 |
| 最终文本归档 | 用户、助手各 1 条；隐藏推理没有复制进插件消息档案 |
| 原生事件与插件归档 | 完整读取 71 个 zstd 帧、116 个连续事件；归档高水位 `115` 与末事件一致 |
| Mermaid 原文 | 本轮有 1 个内嵌 Mermaid 代码块，原文保存在知识点 Markdown 中 |

原生初始化历史包含框架最初的 `workspace-write` 事件；插件在 `seq=3` 切换为 `read-only`，早于模型请求。这里的主安全边界仍是专用工具白名单、执行守卫和受控 Host 实现，而不只是模式字符串。

本轮没有独立 `.mmd` 文件，因为导师把图放在 Markdown 代码块中。原文已保存在笔记与结构化知识点中；使用专门的 `mermaid` 字段发布时才额外生成独立图文件。

可查看本轮的 [状态及证据索引](<C:/Users/cyrus/.dsh/code-reading/projects/project-b4f73c4a-8f50-4fcf-9f29-be2bc033f5c6/sessions/reading-6c4d09a1-3f58-4ad4-bec4-fb1d590bccdc/state.json>)、[知识点笔记](<C:/Users/cyrus/.dsh/code-reading/projects/project-b4f73c4a-8f50-4fcf-9f29-be2bc033f5c6/sessions/reading-6c4d09a1-3f58-4ad4-bec4-fb1d590bccdc/notes/lesson-dd1ab9fd-a010-4deb-ba07-e4f0cd713101.md>) 与 [审计记录](<C:/Users/cyrus/.dsh/code-reading/projects/project-b4f73c4a-8f50-4fcf-9f29-be2bc033f5c6/sessions/reading-6c4d09a1-3f58-4ad4-bec4-fb1d590bccdc/audit.jsonl>)。

机器验收结果见 [只读真实归档报告](<.test-output/live/archive-verification.json>)。验收脚本只向开发测试输出目录写报告，不写上述阅读档案。

## 二、自动化回归

- **29 项测试全部通过**：26 项插件单元／接线回归，加 3 项原生日志验收工具回归。
- **实际安装副本的 12 项接线回归通过**：使用模拟 Cordis Context，是上述插件测试的子集，不重复累计为独立需求。
- **Chrome 隔离组件测试通过**：实际 Client 工厂、主面板／侧边栏注册、模型恢复、阶段交互、同名文件的原仓库身份。
- **普通工作区变化 + 面板卸载重挂载**：原阅读会话、仓库集合和实际模型仍保持不变。
- **五类 Mermaid**：时序图、流程图、类图、状态图、ER 图均生成净化后的 sandbox SVG；非法语法保留源码回退。
- **安全回归**：Markdown 图片、Mermaid 图片／图标资产、HTML、外链、点击和配置指令攻击被拒绝；记录中无意外 HTTP 请求或页面错误。
- **真实档案内容复验**：把上述知识点 Markdown 交给实际 Client 代码，在隔离 Chrome 中确认其内嵌 Mermaid 生成 SVG；不是仅测试专门的 `mermaid` 字段。

可查看 [浏览器报告](<.test-output/browser/report.json>)、[组件截图](<.test-output/browser/reading-panel.png>) 和 [真实档案内容复验截图](<.test-output/browser/archived-lesson.png>)。这些截图均来自网络被测试夹具拦截的隔离浏览器，**不是当前登录页面的截图**。没有启动替代服务器、复制认证凭据或绕过登录。

## 三、构建与安装一致性

已用相等断言比较实际安装副本，而不是只看终端显示的哈希前缀：

| 产物 | SHA256 |
| --- | --- |
| [Host](<lib/index.js>) | `738C62F7F42A55C76FF21542620096C9F17A998FE4A6708DBAD35CAE16B4B111` |
| [阅读 preset](<lib/preset.js>) | `B2770F0356AE498E1DC15C6AF889EF863236F519954EAA128D5D18EA14E9DB57` |
| [Client](<lib/client.js>) | `A9638663997087723124E5543EBD8D3F502EC6A8B1D635BDBD7B469963529516` |
| [code-tutor skill](<skills/code-tutor/SKILL.md>) | `551845AD0DCC169D1B3596B537A06EF390872C439F6028E9DD9B48F3EC1846C6` |

续验只增加开发测试脚本和更新工作区文档，没有更改上述运行时代码，也没有覆盖已安装所引用的原安装包，避免破坏本地归档依赖的完整性。

## 四、验收范围与限制

- 真实项目目前只绑定了一个仓库。多仓同名路径、证据隔离、普通工作区变化与重挂载由自动化夹具验证；没有为此额外发起真实跨仓模型轮次。
- 不声称已通过系统辅助功能或浏览器自动化从头到尾点击当前登录页面。真实流程结论来自用户已产生的档案、原生事件和证据核验；渲染与交互回归另用隔离浏览器。
- 哈希和引用可追溯不代表 AI 的每个业务结论必然正确，也不是跨仓原子快照。
- 当前大仓扫描有资源上限；自定义缓存目录可能占用预算。出现截断时应直接指定已知入口文件读取，不能据此断言其他业务文件不存在。
- 这是插件工具边界，不是抵御同账户恶意本地并发目录替换的 OS 沙箱。远程阅读模型会收到所读取的源码片段。

完整使用方式与信任边界见 [使用说明](<README.md>)；当前已安装的独立插件归档为 [0.1.1 安装包](<releases/dsh-code-reading-0.1.1.tgz>)。
