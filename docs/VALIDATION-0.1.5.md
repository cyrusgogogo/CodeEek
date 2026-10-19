# 0.1.5 · DSH 升级兼容验收

日期：2026-10-17。发布对象：**dsh-code-reading 0.1.5**；精确目标：**DSH 0.2.1-rc.1**。开发验收使用 Node.js 24.21.0（含 zstd）与 pnpm 11.7.0。

## 结论与根因

旧版精确声明 `engines.dsh: 0.2.0-rc.2`，因此被新版 DSH 的原生版本门禁正确拒绝；这条警告本身不是实际崩溃或数据丢失的证据。对安装 ASAR 中实际接口的静态核对，没有发现插件当前使用的 Host、preset、Client 契约必须重写。

本次将[包声明](<../package.json>)中的版本提升为 `0.1.5`，精确宿主目标与五个可选 Host peer 同步为 `0.2.1-rc.1`，更新锁文件并完整重建。未设置版本豁免，未扩大到未来预发布版。运行时[版本模块](<../src/version.mjs>)由包声明派生 Host/Client 版本与兼容目标。

[原生兼容回归](<../test/host-compatibility.test.mjs>)实际调用 DSH `0.2.1-rc.1` SDK 的 `evaluatePluginCompatibility`，覆盖旧包拒绝、新包无需豁免通过、其他宿主版本继续拒绝，以及 peer 后备检查。发布完成后，另从真正归档读取清单再次调用原生门禁，结果为 `accepted without exemptions`。

## 自动验收结果

| 检查 | 结果与范围 |
| --- | --- |
| 源码回归 | **113 通过、0 失败、0 跳过**，包含 4 项原生兼容门禁回归与 zstd 日志回归。 |
| 源码 Client 浏览器 | **22 项基础检查 + 23 项文件工作台检查通过**；HTTP 全拦截，没有外部 HTTP 或页面错误。 |
| 真实 tarball 静态验证 | **17 个包内文件**；导出入口、共享 chunk、skill、原生 Client 工厂、文档、版本与 SHA256 全通过。 |
| 可信归档副本 | Host/preset 导入成功；**24 项模拟 Host 接线回归通过**，为源码回归子集，不重复计入 113 项。 |
| 归档内 Client 浏览器 | **22 项基础检查 + 23 项文件工作台检查通过**，实际加载本次归档内的构建。 |
| 原始复现命令 | `node scripts/doctor.mjs --dsh-version 0.2.1-rc.1` 修复前拒绝，修复及重建后通过，无警告。 |
| 最终源码快照 | 归档构建元数据中的 **109 个输入哈希**均与发布后工作区源码／随包文档一致。 |
| 开发依赖 | `pnpm peers check` 通过，未再使用旧版 Cordis 解析。 |
| 旧版保护 | 旧 0.1.4 归档 SHA256 仍为 `b6d19980dbf646375a8789d43e6c3d6ae4c945a8323f78e82f940e9fc36e4413`，未覆盖。 |

完整发布入口为 `pnpm run pack:release`。机器可读结果见[发布报告](<../releases/dsh-code-reading-0.1.5.release.json>)；源码与归档内浏览器报告分别见[源码浏览器报告](<../.test-output/browser/report.json>)、[包内浏览器报告](<../.test-output/package-browser/report.json>)。

### 发布过程中额外发现的检查问题

- 目录展开后按右方向键，原先未限定作用域的后代选择器可通过外层祖先匹配回当前目录。最小 DOM 复现后，[阅读器](<../src/client/reader.jsx>)改为查询当前目录的直接子项；原浏览器回归现已通过。
- 选中项通过背景、前导标记与字重区分，不要求普通文字和选中文字具有不同色相；检查继续要求 `aria-current`、持久标记及 AA 文本对比度。
- 深色主题令牌变化会使文字立即变色、按钮背景继续过渡约 150ms。最小浏览器案例证明即时取样会读到混合状态；[文件工作台检查](<../scripts/browser-workspace-check.mjs>)等待相关真实 CSS 动画完成后再测量，没有降低 4.5:1 对比度门槛或用固定延时掩盖问题。

## 交付

- [0.1.5 安装包](<../releases/dsh-code-reading-0.1.5.tgz>)：1,620,508 字节。
- [SHA256 校验文件](<../releases/dsh-code-reading-0.1.5.tgz.sha256>)。
- SHA256：`77567e6ee3c34d80401768b4319b3756b204870b6bf8d66c758c35dee2abe9a1`。

安装器使用的绝对路径：

```text
D:\code\dsh-codeeek\releases\dsh-code-reading-0.1.5.tgz
```

先停止阅读并备份档案，在当前 DSH 管理界面按提示卸载不兼容旧版、安装并启用本包。提示 `restart-required` 时完整退出并重开 DSH，不是只刷新网页。进入“阅读代码 → 安装与使用”确认 Client、Host 都为 `0.1.5`，目标为 `0.2.1-rc.1`，原项目列表加载完成。详见[安装手册](<INSTALL.md>)。

## 未做事项与边界

- **未卸载、安装或重启正在运行的 DSH；未在真实登录 GUI 内验收新插件；未调用真实模型；未改写真实阅读档案。** 隔离 Chrome 使用模拟原生服务，不等于真实应用端到端验证。
- 原生版本门禁通过和静态 API 对照，不能证明全部新版服务生命周期与真实模型链路已实测。真实 Tools／preset registry 的 retained revision、停用和重新加载仍建议安装后专项验证。
- 新版 exact Fetch route 只向 owner Peer 开放；不承诺非 owner／共享访问。运行时 Zod Config 可用，但原生静态配置 schema 导出仅覆盖 Schemastery；不把该静态工具限制误称为运行时加载故障。
- 保留既有数据根、阅读档案与批注格式、五工具白名单和只读边界。继续使用相同数据根，不自动迁移或删除档案。

## 本机开发环境恢复记录

开发依赖原先包含指向旧项目目录的 junction，已在当前工作区重新安装，不执行安装期脚本。pnpm 自动生成的工作区配置只包含精确版本的 release-age 例外；未改 DSH 应用安装或其 profile。

参考目录一度出现 Windows 写入拒绝。经授权的诊断给当前用户补充了该参考目录的完全控制，回读验证通过，未改文件内容或所有者；原受限提取仍失败，后来在用户切换的完全权限模式下完成。该记录**不声称受限模式问题已全部修复**。

[权限诊断报告](<D:/code/dsh-codeeek-acl-recovery/acl-report-079e4aa5dc404a03869f8d83e36f5739.jsonl>)与[独立恢复脚本](<D:/code/dsh-codeeek-acl-recovery/acl-backup-84e2e6e7474248fbbb1b80758faa3dcf.json.ps1>)保留在工作区旁。如需撤销该项权限补充，可使用诊断打印的命令：

```powershell
pwsh -NoProfile -File 'D:\code\dsh-codeeek-acl-recovery\acl-backup-84e2e6e7474248fbbb1b80758faa3dcf.json.ps1' -Path 'D:\code\dsh-codeeek\.reference' -AllowRoot 'D:\code\dsh-codeeek' -Restore 'D:\code\dsh-codeeek-acl-recovery\acl-backup-84e2e6e7474248fbbb1b80758faa3dcf.json'
```

本验收记录在归档发布后单独保存，不回写或覆盖已发布安装包。
