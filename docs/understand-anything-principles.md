# Understand-Anything 原理笔记：结构提取、Agent 编排与 JSON 图谱消费

## 0. 阅读范围与证据口径

调研日期：**2026-10-20**。本文固定到官方仓库 **Egonex-AI/Understand-Anything** 的提交 **`f2d0164f72fe678805c34245a6df36acededfebd`**，基于本次实际读取的官方源码与说明，不以浮动的 `main` 代表被分析版本。下文源码引用均为完整的 pinned GitHub blob URL；插件源码位于 `understand-anything-plugin/` 下，仓库根的 [README](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/README.md>) 是路径例外。行号锚点来自已读取的固定提交源码。

为避免把提示词当作执行证明，本文使用三种标记：

- **【源码事实】**：已读取的函数、类型、分支或调用能直接支持的实现结论；不等于本次已运行验证。
- **【编排规范】**：skill/agent 文档要求宿主 Agent 采取的步骤、约束与产物；实际执行仍依赖宿主及模型遵守规范。
- **【推导/限制】**：根据前两类证据得到的解释、适用范围或尚未验证的边界。

**本次仅做静态调研与笔记整理：未运行 Understand-Anything 的第三方代码、安装器或分析流水线，未安装依赖，未修改当前插件源码，未验证运行中的 Dashboard。** 文中的 JSON 路径是对上游运行时产物的说明，不表示本次已经生成这些产物。

## 1. 总体模型：宿主生成知识图谱，Dashboard 消费知识图谱

**【编排规范】** 主体不是“浏览器打开仓库便实时理解源码”，而是 **AI 编程宿主执行 skills/agents，调用确定性脚本提取和整理结构，让 LLM 补充语义，最后保存 JSON**。[主 skill](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L259-L341>) 规定扫描、分批和 file-analyzer 派发；[保存阶段](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L807-L840>) 规定保存图谱与指纹基线。

**【源码事实】** Dashboard 的入口请求 `knowledge-graph.json`，检查 HTTP 结果、解析 JSON、调用 `validateGraph`，成功后 `setGraph`；store 再建立节点/层索引和搜索引擎。这条已核实的加载链路是“读取既有分析产物”，不是在浏览器重新扫描和解析整个代码仓库。[App.tsx:144–194](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/App.tsx#L144-L194>)；[store.ts:367–394](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/store.ts#L367-L394>)。

据此，可把代码库分析主链路概括为以下结构；这只是原理示意，不是本次执行记录：

```text
被分析仓库
    │
    ▼
宿主 Agent 按 /understand skill 编排
    │
    ├─ 文件清单、语言/类别、项目内部 importMap
    ├─ import 图社区分批 + 跨批邻居上下文
    ├─ file-analyzer
    │    ├─ 确定性结构提取：解析器 → 函数/类/import/export/调用信息
    │    └─ LLM 语义补充：摘要、标签、复杂度、部分语义关系
    ├─ 合并、规范化、关系修复
    ├─ 全量 assemble-reviewer → architecture-analyzer → tour-builder
    └─ 最终校验与保存
         │
         ▼
   knowledge-graph.json
      ├─ Dashboard：加载、校验、索引、搜索、布局、交互
      └─ /understand-chat：按关键词与邻接关系抽取子图，组织回答
```

**【源码事实 / 推导】** core 中名为 [llm-analyzer.ts](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/analyzer/llm-analyzer.ts>) 的模块，实际包含文件/项目分析提示词构造与模型响应 JSON 提取、解析、默认值处理。**该文件本身不是模型服务调用器**，不能仅凭名称将 core 描述为独立运行整个分析流程的 LLM 后端；当前已核实的主流程编排证据在 skill/agent 定义中。

## 2. 数据契约：图不仅有节点和边，还带有架构分组与学习路线

**【源码事实】** `KnowledgeGraph` 的根结构如下，`kind` 可选，其余所列根字段必需。架构分层和导览是持久化数据的一部分，不只是 Dashboard 临时画出的装饰。[types.ts:96–115](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L96-L115>)。

```text
KnowledgeGraph
├─ version
├─ kind?              codebase | knowledge | design
├─ project            项目名、语言、框架、描述、分析时间、Git commit
├─ nodes[]            实体与语义描述
├─ edges[]            有类型的实体关系
├─ layers[]           架构层/逻辑分组
└─ tour[]             有序导览步骤
```

| 对象 | 已核实字段与含义 | 固定提交证据 |
| --- | --- | --- |
| `GraphNode` | `id/type/name/summary/tags/complexity`；可选 `filePath/lineRange/languageNotes` 及领域、知识、设计元数据 | [types.ts:54–67](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L54-L67>) |
| `GraphEdge` | `source/target/type/direction/weight`，可选 `description`；`weight` 注释范围为 0–1 | [types.ts:69–77](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L69-L77>) |
| `Layer` | `id/name/description/nodeIds`；显式列出成员节点 | [types.ts:79–85](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L79-L85>) |
| `TourStep` | `order/title/description/nodeIds`，可选 `languageLesson` | [types.ts:87–94](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L87-L94>) |

**【源码事实】** 类型联合覆盖代码、非代码、领域、知识和设计实体；边也不只包含 `imports/calls`，还包含结构、行为、数据流、部署、领域与知识关系。不能拿早期简化 schema 当成当前完整类型集。[types.ts:1–21](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L1-L21>)。

**【编排规范】** 新项目使用 `.ua/`；若项目已有 `.understand-anything/`，继续使用旧目录，解析规则不是一律优先新目录。chat 与 file-analyzer 都明确要求先统一解析数据目录并复用。[chat skill:34](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand-chat/SKILL.md#L34>)；[file-analyzer:35](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L35>)。

**【推导/限制】** 这是一个可持久化、可复用的“代码理解中间表示”，但并非完整证据账本：已读 `GraphNode/GraphEdge` 类型没有把每条边的源码证据、内容哈希、推断来源或置信度单独设为必需字段。`weight` 也不能自动解释成经过校准的“关系真实性概率”；agent 规范按关系类别给定惯用权重。[图类型](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L54-L77>)；[边生成表](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L258-L273>)。

## 3. 全量流水线：需要区分两次 review

下表描述 **【编排规范】**，不是声称这些阶段已在本次机器上成功执行。

| 阶段 | 主要职责 | 固定提交证据 |
| --- | --- | --- |
| Pre-flight / Ignore | 决定全量或增量；全量流程先让用户确认忽略规则 | [主 skill:186–226、240–255](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L186-L255>) |
| Phase 1：SCAN | 派发 `project-scanner`，获得后续分析所需的项目清单与上下文 | [主 skill:259–263](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L259-L263>) |
| Phase 1.5：BATCH | 调用随 skill 提供的分批脚本，而非让模型自由切分 | [主 skill:306–312](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L306-L312>) |
| Phase 2：ANALYZE / merge | 按批次派发 `file-analyzer`，规范要求最多 5 个并发；再合并与规范化批次图 | [主 skill:333–395](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L333-L395>) |
| Phase 3：ASSEMBLE REVIEW | **全量流程还派发 `assemble-reviewer`**；普通增量跳过此全图 LLM 步骤 | [主 skill:441–466](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L441-L466>) |
| Phase 4：ARCHITECTURE | `architecture-analyzer` 生成层；全量及要求重跑架构的增量会执行 | [主 skill:470–478](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L470-L478>) |
| Phase 5：TOUR | `tour-builder` 生成导览；普通 PARTIAL 不重写叙事 | [主 skill:555–561](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L555-L561>) |
| Phase 6：REVIEW | 默认最终 review 是内联确定性校验；传 `--review` 才派发完整 LLM `graph-reviewer` | [默认路径](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L680-L690>)；[LLM 路径](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L765-L788>) |
| Phase 7：SAVE | 保存图谱，建立结构指纹后再推进 meta；校验未通过时不自动启动 Dashboard | [保存与基线顺序](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L807-L840>)；[启动条件](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L876-L877>) |

**【推导/限制】** “默认最终 review 不用 LLM”不等于“全量流程没有 LLM reviewer”，更不等于整条流水线确定性。这里有独立的 assemble review、语义分析、架构解释与 tour 生成；不要把 [README 的简化 agent 表](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/README.md>) 当成完整执行图。

## 4. 结构提取与语义分析的边界

### 4.1 解析器负责什么

**【源码事实】** [结构提取脚本](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/extract-structure.mjs#L79-L150>) 从带 `treeSitter` 配置的语言建立 Tree-sitter 插件，再向 `PluginRegistry` 注册它及非代码解析器；逐文件读内容，调用 `analyzeFileWithOutcomes`，汇总结构/调用图结果及成功、失败、跳过状态并输出 JSON。

**【源码事实】** 未能读取文件与没有注册解析器不是同一状态：输出同时区分 `filesSkipped` 和其不可读子集 `filesUnreadable`；整批全部不可读会抛错。不能把路径错误包装成“这种语言不支持”。[extract-structure.mjs:97–114](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/extract-structure.mjs#L97-L114>)；[156–172](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/extract-structure.mjs#L156-L172>)。

**【源码事实 / 推导】** Tree-sitter 插件有同一次 parse 返回 structure 与 callGraph 的接口，实际结果依赖语言对应的 extractor。由此能确认它使用语法解析而不只是临时正则，但不能推出“所有语言、所有动态调用、全程序类型/元编程都已经准确解析”。[TreeSitterPlugin:318–342](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/plugins/tree-sitter-plugin.ts#L318-L342>)；[symbol gate 的分析边界说明](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L423-L437>)。

### 4.2 LLM 负责什么，以及哪些边仍是推断

**【编排规范】** file-analyzer 先运行随包提供的提取脚本，再基于结构结果形成摘要、标签、复杂度和关系。规范并不要求无条件重读每个源文件；仅在跳过、结构未捕捉的模式或需要深入理解时补读。[file-analyzer:29–31](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L29-L31>)；[148–152](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L148-L152>)；[478–485](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L478-L485>)。

**【编排规范】** `imports` 必须逐条使用已经解析的项目内部 `batchImportData`，不由 analyzer 自行重算路径；但 `calls` 的规则明确允许在有把握时从 imports 与函数名推断。因此“有确定性结构提取”不等于“最终所有边均为确定性证明”。[file-analyzer:264–273](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L264-L273>)；[295–303](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L295-L303>)。

**【源码事实】** 合并脚本还会从扫描 `importMap` 恢复遗漏的 import 边；实际实现要求源、目标都能映射到整文件节点，跳过自环与已有边，并报告缺少端点的情况。这是针对模型漏写关系的确定性补偿，而不是让 LLM 的每次输出天然相同。[merge-batch-graphs.py:1066–1149](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/merge-batch-graphs.py#L1066-L1149>)。

### 4.3 图谱不是完整全符号索引

**【编排规范】** 函数/类节点存在显著性筛选：

- 函数或方法达到 **10 行及以上**；
- 类有 **2 个及以上方法**，或达到 **20 行及以上**；
- 或者该函数/类为 **exported**；
- 跳过平凡 one-liner、类型别名、简单 re-export 和自动生成样板。

以上来自 [file-analyzer:241–250](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L241-L250>)。所以 [README](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/README.md>) 中“every file/function/class”应作为产品概述理解，不能当作逐符号完备性保证。

**【编排规范】** 增量更新有例外：`previousSymbols` 中已经存在且当前源码仍保留的符号，必须越过显著性过滤，重新生成语义并保留身份；不能因为函数变短就悄悄删除节点，也不能复制旧摘要和旧边来凑齐。[file-analyzer:252–254](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L252-L254>)。

## 5. 分批：依据 import 图社区，而不是固定 20–30 文件

**【源码事实】** 分批脚本对代码文件和内部 import 关系构造无向图，排序输入并调用 `louvain(g, { randomWalk: false })`。这里的“semantic batches”主要指依赖社区划分，不是先计算文本向量再做 embedding 聚类。[compute-batches.mjs:291–308](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs#L291-L308>)。

该固定提交的规则是：

| 规则 | 解释 | 固定提交证据 |
| --- | --- | --- |
| Louvain 代码社区上限 **35** | 超限按字母序拆成大小受限的块；35 是这里代码社区拆分的上限，不应泛化为所有非代码分组的全局上限 | [compute-batches.mjs:487–509](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs#L487-L509>) |
| 小批合并 | 可合并且少于 **3** 个文件的批次被收集，misc 合并目标为 **25**；非代码语义组 A–D 不因小而被合并，Group E 兜底组可参与 | [compute-batches.mjs:324–354](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs#L324-L354>) |
| Louvain 失败回退 | 先按 **12 文件/批** 做 count-based 分组，并明确警告语义边界丢失；不应承诺任何情况下都是社区划分 | [compute-batches.mjs:466–478](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs#L466-L478>) |
| 跨批 `neighborMap` | 收集 imports-out 和 imported-by-in 的 1-hop 邻居，排除本 payload 中已分析的文件，并携带导出符号上下文；邻居数有 **50** 的软上限及截断警告 | [构造与截断](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs#L558-L615>)；[analyzer 使用规则](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L56-L66>) |
| 增量批次 | 按完整图的分批结果筛出 changed files，保留原 batchIndex，并保留对未变邻居的上下文引用 | [compute-batches.mjs:620–638](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs#L620-L638>) |

**【推导】** 这种设计同时控制上下文预算、减少跨批断链与过多小任务开销。具体批次大小不能照抄 [README 的“20–30 files per batch”](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/README.md>)；实际规则应以上述脚本为准。单批文件数有界也不等于 token 数有严格上界，文件长度和邻居上下文仍会影响成本。

## 6. 增量更新：结构指纹、分级计划与严格符号门禁

### 6.1 指纹判定不等于业务语义等价

**【源码事实】** 指纹包含内容 SHA-256 以及函数、类、imports、exports 等结构信息。比较先检查内容哈希；缺少结构分析或存在未解析的 owner 时，内容变化会保守归入 `STRUCTURAL`。函数签名、所属类型、导出状态等变化会形成结构差异，函数行数比例 `> 1.5` 或 `< 0.5` 也会触发显著大小变化。[fingerprint.ts:31–40、80–132](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/fingerprint.ts#L31-L132>)；[142–215](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/fingerprint.ts#L142-L215>)。

**【源码事实】** `COSMETIC` 在这里不是“只改空格/注释”的同义词：内容已变但被比较的结构未变时，返回理由明确是 `internal logic changed (no structural impact)`。[fingerprint.ts:268–273](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/fingerprint.ts#L268-L273>)。

**【推导/限制】** 因此某些函数内部业务逻辑变化可能走零语义重分析路径，旧摘要、复杂度或语义边未必同步刷新。不能将“结构指纹未变”“元数据已推进”解释为“代码含义没有变化”或“全部叙述都保持最新”。这是此类成本优化的重要代价。

### 6.2 分类器的精确阈值与优先级

**【源码事实】** 令 `S = structurallyChangedFiles.length + newFiles.length + deletedFiles.length`，`N = totalFilesInGraph`。分类按下表顺序短路，阈值都是严格大于，不是大于等于。[change-classifier.ts:21–93](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/change-classifier.ts#L21-L93>)。

| 优先级 | 条件 | action | 架构 / tour |
| --- | --- | --- | --- |
| 1 | `S === 0` | `SKIP` | 不重跑 |
| 2 | `S > 30`，或 `N > 0 && S / N > 0.5` | `FULL_UPDATE` | 转全量流程 |
| 3 | 未命中全量，且顶层目录集合变化或 `S > 10` | `ARCHITECTURE_UPDATE` | 都重跑 |
| 4 | 其余有结构变化的情况 | `PARTIAL_UPDATE` | 都不重跑 |

这里的目录变化比较的是文件路径**第一段顶层目录**的前后集合，并非任意深度子目录变化都会触发。删除计入 `S`，但返回的待重分析文件只包括结构变化文件和新增文件，不包括已删除文件。[change-classifier.ts:65–145](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/change-classifier.ts#L65-L145>)。

**【源码事实】** 准备脚本还会按当前清单过滤待分析路径，绑定 base/head 写出符号基线、指纹补丁和更新计划；最终脚本对“只有分析生成物变化”的 `SKIP` 明确不推进基线。[prepare-incremental.mjs:593–718](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/prepare-incremental.mjs#L593-L718>)；[finalize-incremental.mjs:395–421](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/finalize-incremental.mjs#L395-L421>)。

### 6.3 丢符号不能用“差不多的图”掩盖

**【编排规范】** 对重分析文件，不只比较节点总数，还要比较缺失节点 ID/名称，包含类方法。缺失符号对照 base/current 源码做严格判断：只有确认源码删除才允许消失；仍存在或无法确认的符号阻止发布。[主 skill:401–437](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L401-L437>)。

**【编排规范】** 未决文件只允许一次定向重分析修复，必须完整替换这些文件的分析结果，不能简单附加缺失节点，也不能拼回旧语义边绕过门禁。二次 merge 或修复失败即停止，不推进已发布图谱、指纹与 meta。[主 skill:427–435](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L427-L435>)。

**【源码事实】** 最终保存函数在检查文件覆盖及架构/tour 产物后，针对**即将保存的确切 graph** 再调用 `validateIncrementalSymbols`；`ok` 为假立即抛错。通过后才写 graph，再补丁指纹，最后推进 meta。此前成功的 merge 报告不能代替这次检查。[finalize-incremental.mjs:424–482](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/finalize-incremental.mjs#L424-L482>)。

**【推导/限制】** 这里是有顺序的单文件原子替换，不应扩张成“graph、fingerprints、meta 三文件事务整体原子提交”的保证：写入 helper 使用临时文件加 rename，而主函数依次写各产物；本次也未做故障注入。[atomicWriteJson](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/finalize-incremental.mjs#L65-L70>)；[保存顺序](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/finalize-incremental.mjs#L472-L482>)。

**【编排规范 / 限制】** 自动确认删除既需要确定性解析器，也需要声明覆盖适配器。当前规范列出的覆盖包括 JS/JSX、TS/TSX、Ruby、Python、Go、Rust、C++；其他 grammar 即使解析成功也可能保持保守。Shell、PowerShell、Batch 等缺少所需确定性结构证据的情况不能用 LLM 或正则猜测来证明删除，结果可能维持 `unknown` 并阻塞更新。[主 skill:423–437](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L423-L437>)。

**【编排规范】** 普通 PARTIAL 保留存活的层分配，以确定性规则安置新节点；tour 只清除悬空引用，不重新生成叙事。普通增量在确定性保存门禁后结束；显式 `--review` 才继续完整 LLM graph-reviewer。这与全量“容错保存部分结果”的泛化说明不能混为一谈，严格 symbol-loss 分支必须停止。[层与 tour 规则](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L470-L557>)；[增量保存后分流](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L628-L639>)。

## 7. Dashboard：React Flow 交互与 ELK 分层结构布局

**【源码事实】** Dashboard 依赖 React、Zustand、`@xyflow/react` 与 ELK；store 保存图、节点索引、层索引、导航级别和容器布局缓存。其作用是把既有图谱组织为可浏览界面。[Dashboard 依赖](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/package.json#L14-L30>)；[store.ts:367–394](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/store.ts#L367-L394>)。

**【源码事实】** 结构图总览调用 `applyElkLayout`，层内 Stage 1 布局和展开容器的 Stage 2 也调用 ELK。默认配置为 `layered` 算法、向下方向与正交连线。因此可概括为 **React Flow 承载交互图，ELK 计算分层结构位置**，而非“所有视图统一用力导向”。[GraphView 总览](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/components/GraphView.tsx#L329-L354>)；[Stage 1](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/components/GraphView.tsx#L755-L783>)；[Stage 2](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/components/GraphView.tsx#L843-L868>)；[布局默认项](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/utils/layout.ts#L75-L84>)。

**【源码事实】** Dagre helper 仍在文件中，但注释标为 deprecated，说明结构视图已迁移到 ELK，保留是为回退。不能看到依赖中有 Dagre 就认定它是当前结构图主布局算法。[layout.ts:12–20](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/utils/layout.ts#L12-L20>)。

**【源码事实 / 推导】** 前端另有 Louvain helper：取给定节点集合内的边，忽略自环与重复边，构建无向图并分社区，对未分配者生成独立社区 ID。这是图消费侧的社区工具，与前述用于调度 Agent 的 import 分批脚本是两个用途；也不能把社区编号直接等同于 LLM 生成的架构层含义。[louvain.ts:17–55](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/utils/louvain.ts#L17-L55>)；[架构层编排](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L470-L478>)。

## 8. 搜索与 chat：不要把 UI 文案、core 能力和实际接线混为一谈

### 8.1 Dashboard 的 semantic 按钮不代表此路径已接入向量搜索

**【源码事实】** 搜索栏确实有 `fuzzy` / `semantic` 两个按钮，并调用 `setSearchMode`。[SearchBar.tsx:113–133](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/components/SearchBar.tsx#L113-L133>)。

**【源码事实】** 但 store 的 `setSearchQuery` 读取 `searchMode` 后执行 `void mode`，两种模式都调用同一个 `engine.search(query)`。代码注释也明确写着目前都用 fuzzy engine；建图时实例化的就是 `SearchEngine(graph.nodes)`。[store.ts:367–369](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/store.ts#L367-L369>)；[532–545](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/store.ts#L532-L545>)。

**【源码事实】** core 的确另有 `SemanticSearchEngine`：以 `Map<nodeId, number[]>` 持有预计算 embedding，接收查询向量，逐节点计算 cosine similarity，按阈值和类型过滤，以 `1 - similarity` 为 score 排序，返回 top-k。该类要求调用方提供向量，本身不等于 embedding 生成服务或外部向量数据库。[embedding-search.ts:56–117](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/embedding-search.ts#L56-L117>)。

**【推导/限制】** 准确结论是：**core 具备 cosine 向量检索实现，但在这个固定提交已核实的 Dashboard `setSearchQuery` 路径中尚未接入。** 不能写成“项目完全没有语义搜索代码”，也不能写成“点 semantic 后就会生成 embedding 并搜索向量库”。

### 8.2 chat 是图子集检索的 Agent 使用规范

**【编排规范】** `/understand-chat` 的流程是：

1. 解析数据目录，确保图谱存在。
2. 检查图谱 commit、当前 HEAD 及项目范围内已提交/工作区变化，必要时警告图谱陈旧。
3. 读取项目元信息；用查询关键词搜索图中的 `name/summary/tags`。
4. 对命中的节点 ID 找入边、出边，取得 **1-hop 子图**。
5. 补充 layer 上下文，基于相关子图组织回答并引用代码位置。

这些步骤来自 [chat skill:34–70](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand-chat/SKILL.md#L34-L70>)。文档中“在 summary 中找 semantic matches”的措辞，在此操作规范里仍是对图文本的搜索，不是一个已接线的 embedding API。

**【推导/限制】** 它可以理解为“图谱辅助的上下文压缩与检索”：不把整个仓库塞进模型上下文，而是先找节点，再扩展邻居。**此规范不要求向量数据库。** 同时它也不保证找齐任意多跳调用链；图谱漏边、显著性过滤、关键词未命中和语义陈旧都会影响回答。

## 9. 容易误读的表述与正确边界

| 容易误读 | 此提交支持的准确结论 | 证据 |
| --- | --- | --- |
| 浏览器实时分析仓库 | 宿主编排生成 JSON；Dashboard 读取、校验并展示 | [App.tsx](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/App.tsx#L144-L194>) |
| Tree-sitter 保证所有语言和所有关系准确 | 配置/grammar/extractor 有覆盖边界，`calls` 还允许推断 | [提取脚本](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/extract-structure.mjs#L79-L87>)；[calls 规则](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L264-L273>) |
| 每个函数都会成为节点 | 有显著性筛选；增量保留已有存活符号是例外 | [file-analyzer](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L241-L254>) |
| 批次固定 20–30 文件 | import Louvain 社区、35 上限拆分、小批合并、12 文件回退与邻居上下文 | [批次实现](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/compute-batches.mjs>) |
| 默认 review 就是全图 LLM 审核 | 最终 review 默认确定性；`--review` 才用 LLM graph-reviewer；全量另有 assemble-reviewer | [主 skill](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md>) |
| UI 的 semantic 已启用向量召回 | 此 `setSearchQuery` 路径两种模式都走 fuzzy | [store.ts](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/store.ts#L532-L545>) |
| COSMETIC 意味着业务行为不变 | 内部实现变化也可能被归入 COSMETIC，语义更新存在盲区 | [fingerprint.ts](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/fingerprint.ts#L268-L273>) |
| 失败时总能发布部分结果 | 增量缺失符号未获严格证明会阻止保存，不能套用泛化容错说明 | [finalize-incremental.mjs](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/finalize-incremental.mjs#L472-L482>) |

## 10. 无法由本次静态取证确认的事项

1. **实际运行质量、速度、费用与复现率。** 本次没有跑分析流水线、模型请求、第三方测试或 Dashboard；不会把上游注释中的性能/成本数字当作本次测量。
2. **任一宿主是否完整遵守每条 skill 规范。** 并发数、失败重试、来源约束与输出格式是编排要求，不是静态阅读就能证明的执行结果。[主 skill](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md>)。
3. **目标安装实际具备的完整语言能力。** file-analyzer 的语言说明列出较小清单，并把 Swift/Kotlin 描述为补充分析对象；Tree-sitter 插件注释则列出更广的 extractor 语言集合。二者存在口径差异，实际能力还取决于配置、WASM 加载和 extractor/声明覆盖适配器；本次不宣称已经逐语言验证。[file-analyzer:137–144](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L137-L144>)；[TreeSitterPlugin:20–30](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/plugins/tree-sitter-plugin.ts#L20-L30>)。
4. **全部模型生成摘要与关系的正确性。** 类型校验、去悬空边和符号保留只能防住部分结构性错误，不能证明业务解释正确，也不能补出从未进入图谱的所有符号。[图契约](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/types.ts#L54-L115>)；[显著性及边规范](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L241-L273>)。
5. **项目全局所有向量调用链。** 已确认的是 Dashboard 当前搜索入口没有接入 core 向量引擎，不扩张成“全仓任何入口都没有使用它”的否定结论。[store.ts](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/dashboard/src/store.ts#L532-L545>)；[embedding-search.ts](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/packages/core/src/embedding-search.ts#L56-L117>)。
6. **源码发送范围、隐私及宿主权限。** 已核实的核心分析步骤由宿主 Agent 执行；本次没有审核所有平台的模型传输、权限或安装器。不能从“图谱在本地保存”推出“生成过程绝不向模型服务发送源码”。[分析编排](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/skills/understand/SKILL.md#L333-L341>)；[文件分析规范](<https://github.com/Egonex-AI/Understand-Anything/blob/f2d0164f72fe678805c34245a6df36acededfebd/understand-anything-plugin/agents/file-analyzer.md#L148-L152>)。

## 结语

**【推导】** Understand-Anything 的核心思路不是某个单独的“万能代码理解算法”，而是组合三种职责：**确定性工具保住可提取结构与产物一致性，Agent 编排把结构变成语义说明、架构层和导览，JSON 图谱让分析与后续浏览/问答解耦。** 它适合形成面向理解的导航地图，而不应被等同于完备的编译器符号库、全程序调用证明或语义永远同步的知识数据库。理解这条分界，比只记住“Tree-sitter + LLM + 知识图谱”的技术名词更重要。
