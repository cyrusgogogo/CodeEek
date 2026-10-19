# 阅读代码 0.1.2 · 本轮验收记录

日期：2026-10-15。对象：当前源码和本轮新生成的 **dsh-code-reading 0.1.2** 归档；目标兼容声明 **DSH 0.2.0-rc.2**。

## 结论与边界

**源码检查、真实发布包静态检查及可信归档副本的隔离验收通过。没有将 0.1.2 安装进用户正在运行的 DSH，没有改动真实阅读档案，没有发送真实模型请求。**

本页不延续旧版本的真实运行结论。[0.1.1 历史验收](<../VALIDATION.md>) 与两个既有研究文档保持原样；0.1.1 归档也未覆盖。当前页面是否已加载新插件，仍需用户安装、按提示完整重启，并检查 Host/Client 版本。

## 一、交付与完整性

| 项目 | 结果 |
| --- | --- |
| [0.1.2 安装包](<../releases/dsh-code-reading-0.1.2.tgz>) | 1,530,458 字节，17 个包内文件 |
| [SHA256 校验文件](<../releases/dsh-code-reading-0.1.2.tgz.sha256>) | 与最终路径归档重新读取的哈希一致 |
| [发布机器报告](<../releases/dsh-code-reading-0.1.2.release.json>) | 静态检查及 source/browser/可信副本阶段完成；live DSH 与真实模型均为 false |
| [可信副本报告](<../.test-output/package-smoke-report.json>) | Host/preset 可导入，模拟接线与包内 Client 浏览器通过 |
| [安装与升级手册](<INSTALL.md>)、[使用手册](<USAGE.md>)、[更新记录](<../CHANGELOG.md>) | 随包交付 |

新包 SHA256：

```text
88b8b779300d98251f17fbebfe1b14ca8a3a063f7ba6543aa85d48b930054a78
```

原 [0.1.1 安装包](<../releases/dsh-code-reading-0.1.1.tgz>) 在本轮前后比较的 SHA256 保持为：

```text
c0f5c606f58fec1c424195dbc277cc718150afced45ecabfdfc529db1df13a70
```

SHA256 是字节完整性检查，不是发布者签名。静态包校验不能证明未知来源代码安全。

## 二、72 项源码回归

**72 通过、0 失败、0 跳过。** 最终发布管线重新执行，非仅沿用初次结果。

| 测试模块 | 数量 | 主要覆盖 |
| --- | ---: | --- |
| [客户端 API](<../test/client-api.test.mjs>) | 12 | 原生传输／同源认证、HTML 404、认证、服务器及网络故障、取消、畸形 JSON、旧 Host 与版本握手 |
| [安装配置](<../test/installation.test.mjs>) | 6 | manifest／精确版本、无安装期脚本、绝对数据根、Windows 盘符与 UNC、环境优先级 |
| [Host 接线](<../test/integration.test.mjs>) | 21 | 五工具／只读模式、只读 status、统一 HTTP 错误、UTF-8 体积、启停与异步准入、CAS／幂等、模型来源、审计与事件重放 |
| [包契约](<../test/package.test.mjs>) | 16 | 缺 chunk／skill、错误导出、旧文档、哈希、PAX、截断、链接／路径／类型冲突、有界读取及增长、祖先 junction、不可覆盖 |
| [阅读与文件边界](<../test/reading.test.mjs>) | 14 | 多仓同名文件、仓库／证据归属、路径／硬链接、源码失效、发布／留痕、锁和恢复、非白名单工具拒绝 |
| [原生日志工具](<../test/session-log.test.mjs>) | 3 | 多帧 zstd、中文跨帧、损坏后继帧、解压字节预算 |

真实缺陷采用失败回归后修正，包括：HTML 被误当 JSON、缺兼容声明／相对数据根、Host 停用后的旧路由与排队请求、锁内等待期间停用或升级后仍发生副作用、中文请求按字符而非字节计数、模型目录恢复后残留失败通知、档案重试不恢复主题／仓库，以及 tar 类型冲突和发布祖先链接。

## 三、22 项 Chrome 隔离检查

[源码浏览器报告](<../.test-output/browser/report.json>) 与 [归档 Client 浏览器报告](<../.test-output/package-browser/report.json>) 均通过，后者明确记录 `clientSource: extracted release archive`。

- 实际原生 Client 工厂、外置 React、侧边栏与主插槽。
- Host 404 HTML、旧版本混用、加载中的列表、失败列表和档案的可恢复状态；未就绪不开放创建和发送。
- 模型目录空／失败／恢复，不静默切换全局默认；成功恢复后清除过期通知。
- 创建项目不触发 prompt，项目已保存但会话失败可以继续；迟到的初始模型目录不会清除已创建会话。
- 首次／重试统一恢复主题和仓库，跨项目切换不会沿用旧仓库，常规刷新不擦除主题草稿。
- 历史分页处理中禁止重复提交，按会话代次保存消息；切换后不显示前一会话历史。
- 实际会话模型在切换与面板重挂载后保持；普通工作区变化不重绑阅读项目。
- 文件结果保留原仓库身份；人工阶段变更与 revision 更新。
- 五类 Mermaid 的净化 sandbox SVG、非法语法源码回退、Markdown 图片与危险资产／HTML／点击指令拒绝。
- 480px 窄屏无页面横向溢出，DSH token 浅色／深色截图；Client disposer 撤销所拥有的样式与插槽。
- 两轮浏览器均为 **0 意外 HTTP 请求、0 页面错误、0 prompt 调用**。

视觉复核：[安装检查](<../.test-output/package-browser/installation-help.png>)、[首次使用](<../.test-output/package-browser/first-reading.png>)、[Host 未就绪](<../.test-output/package-browser/host-unavailable.png>)、[窄屏深色](<../.test-output/package-browser/installation-dark.png>)。均来自网络被拦截的组件夹具，不是当前登录 GUI 截图；未启动替代 Web 服务器。

## 四、真正发布包的验收顺序

1. 同名归档、checksum 或报告存在时在构建前拒绝。
2. 构建运行代码、原生 Client、notices 和逐文件／输入哈希。
3. 重跑全部 72 项回归与源码 Client 的 22 项浏览器检查。
4. 检查源码／随包文档新鲜度，再由 pnpm 11 真实打包到新建暂存目录。
5. 有界读取实际 gzip/tar，检查 17 个文件、入口／共享 chunk、skill、工厂、版本、文档和逐文件 SHA256，不解包／执行。
6. 对本次自己构建的**可信归档**另外解包到隔离测试目录，实际导入 Host／preset；将其中 Host 交给模拟 Cordis Context，重跑 **21 项接线测试，0 跳过**；将其中 Client 交给 Chrome，再跑 **22 项浏览器检查**。
7. 成功后排他发布新文件，写 SHA256 与报告，再清理自己新建的暂存／解包目录。
8. 对最终路径重新执行文档中的 doctor／verify:package；实测再次发布以预期退出码 2 拒绝，且新包、旧包及构建元数据哈希均未变化。

21 项归档接线是上述 72 项的子集，不重复累计需求数。发布 JSON 的 `execution: static-only` 描述第 5 步静态检查；第 6 步独立的可信代码执行见 `validation.extractedPackageHostAndBrowser` 和可信副本报告。不能把 `verify:package` 与 `test:package --trusted` 当作同一个安全等级。

## 五、可复现命令与环境

环境：Windows、Node.js **24.21.0**（zstd 支持已确认）、pnpm **11.7.0**、本机 Chrome。开发最低 Node 声明 `>=22.18.0`，完整发布仍要求可用 zstd；不支持时明确停止，而非把跳过测试伪装成通过。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run doctor -- --dsh-version 0.2.0-rc.2
pnpm run verify:package -- releases/dsh-code-reading-0.1.2.tgz
# 仅针对自己信任的本仓库归档：此命令执行包内代码，不安装进 DSH。
pnpm run test:package -- --trusted releases/dsh-code-reading-0.1.2.tgz
```

冻结依赖安装已实测通过，锁文件未改变。离线试跑曾因本地 store 缺官方依赖 tarball 而失败；随后按同一冻结锁文件联网补齐，安装脚本始终禁用。因此不宣称在任意未缓存环境中可完全离线安装。

同版本归档已经存在；`pack:release` 再运行会拒绝覆盖，这是预期。修改发布内容应提升版本；演练可选择仓库内新的 `.test-output` 输出目录，不接受链接祖先或源码／依赖／运行目录。

## 六、尚未做及不承诺的内容

- 未向用户应用执行安装事务、重启或刷新；未验证 0.1.2 在真实登录 GUI 的从安装到模型轮次 E2E。兼容版本是固定声明，不是对当前进程的自动探测。
- 未读取／改写真实阅读档案来做升级迁移，不宣称已验证用户特定档案的回退兼容；升级前仍须停止阅读并备份。
- 无真实模型调用、目标项目代码执行或用户仓库写入；框架模型网络访问仍按用户所选提供方处理。
- 读写边界与脚本路径检查不是 OS 沙箱，不能抵御同账户恶意并发目录替换；没有跨进程同根写入锁或跨文件完全原子事务保证。
- 未宣称秘密检测／DLP、AI 结论正确性、AST 调用图或跨仓一致性快照。

安装后的人工完成标志与恢复步骤见 [安装手册](<INSTALL.md#3-安装启用与生效>)。
