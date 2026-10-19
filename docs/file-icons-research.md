# 文件目录开源图标调研

调研日期：2026-10-17。已联网检索，并用 `web_fetch` 核验官方仓库、官方 GitHub Contents API、项目官网及许可证；不采用第三方图标转载站作为许可依据。

## 结论与项目约束

**首选：Material Icon Theme（PKief）精选文件／目录 SVG 本地内置，操作图标配 Lucide。** 理由是开发者熟悉的语言辨识、丰富的特殊文件名／语义目录、相对统一的视觉，以及较直接的 MIT 许可；这是本次针对该文件浏览器的选型判断，不是客观美观排名。[M1] [M2]

本项目是 React 18 + esbuild 的 DSH 独立插件，阅读工作台只读打开本地源码，已有深浅主题，发布时预构建并包含第三方许可清单。应延续本地资源策略，不为图标引入 VS Code／Atom 扩展运行时、CDN、远程图标请求或额外浏览器 SDK。依据：[包配置](<../package.json#L30-L39>)、[开发依赖](<../package.json#L75-L86>)、[文件工作台说明](<../README.md#L5-L13>)、[构建与许可说明](<../README.md#L146-L150>)、[主题说明](<../README.md#L192-L197>)。

## 方案对比

| 方案 | 许可证与分发注意 | 扩展名／特殊文件名／文件夹 | 深浅主题 | 按需 SVG、运行时与 CDN |
| --- | --- | --- | --- | --- |
| **Material Icon Theme（PKief）** | 官方仓库现已迁至 `material-extensions`；仓库 [MIT 许可证][M1]，内置时保留版权与许可文本。品牌标识不等于取得商标授权。 | 文件、语言 ID、文件夹各有独立映射；支持特殊文件名、复合扩展名、目录及根目录关联，适合多语言源码树。[M2] [M3] | 部分图标有 `_light.svg`，例如 TOML；不是每个图标都必须成对。文件夹设计／颜色可配置，但原始资源与生成产物应区分。[M2] [M4] | 可只复制所需静态 SVG + 小映射表，**无需运行时依赖／CDN**；不必安装整个主题扩展。完整映射可在构建期由上游 manifest 生成器取得。[M3] |
| **vscode-icons** | **[源码 MIT](<https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE>)，不代表图标 MIT。** 官方声明图标为 **[CC BY-SA 4.0][V2]**，品牌图标遵各自权利条款；需署名、许可证链接、标记改动，改编图标须遵相同方式共享，不能省略为本项目 MIT。[V1] [V2] | 文件类型、特殊文件名、语义目录覆盖丰富，有默认文件夹及展开态；另有项目自动检测，但本插件无需引入自动检测运行时。[V1] [V3] | 有专门浅色变体，如 `file_type_light_json.svg`；应按映射选择，而非整包 CSS 反色。[V4] | 静态 SVG 可精选内置，**不强制依赖／CDN**；但图标许可处理比 Material 更复杂，不作为本次默认来源。 |
| **Seti UI（jesseweed）** | [MIT 许可证][S1]；保留 Jesse Weed 版权与许可。 | 原始 `icons/` 有独立 SVG；LESS 映射覆盖常见语言、特殊文件名，如 README、Dockerfile、tsconfig、Git 文件。本次查看的映射以文件为主，目录覆盖不宜假设等同 Material，需自行补齐。[S2] [S3] | 官方定位原为深色 UI；图标风格是单色字形 + 受控配色。用于本项目浅色主题时应重新校验色值／对比度，而非直接搬 Atom 深色变量。[S2] | 可提取 SVG 和少量映射，**无需 Atom、Gulp、图标字体或 CDN**；Gulp 是上游生成流程，不是本地静态 SVG 的浏览器依赖。[S2] |
| **Lucide（操作图标补充）** | 主体 **ISC**；官网同时列出 Feather 派生图标的 **MIT** 声明，搜索、展开箭头等选用项应连同两段许可保留。[L1] | 搜索、刷新、关闭、展开、复制、普通文件／文件夹等操作适合；**不提供语言扩展名／特殊文件名自动关联体系**，不能替代文件主题映射。 | SVG 使用 `stroke="currentColor"`，可随现有语义色适配两种主题；文件类型不应全部染成操作图标的同一颜色。[L2] [L3] | 官方支持独立 SVG／静态资源，**无需 JS 框架运行时／CDN**；当前工程可直接内置少量图形，不必新增 `lucide-react`。[L2] |

## 可直接定位的官方资源

以下 raw 链接均由官方 Contents API 的 `download_url` 核实其资源定位（对应文件 API 返回 200）；本调研环境对 `raw.githubusercontent.com` 的 DNS 访问受限，**未宣称已成功直连下载 raw 字节**。集成时下载并锁定提交与文件哈希，页面运行时不访问这些 URL。

| 用途 | 官方原始 SVG URL / 源码位置 |
| --- | --- |
| Material TypeScript | [typescript.svg](<https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/13025adc5ad10a5cc649528a2c1edec93069f1b9/icons/typescript.svg>)；[官方 API 核验](<https://api.github.com/repos/material-extensions/vscode-material-icon-theme/contents/icons/typescript.svg?ref=13025adc5ad10a5cc649528a2c1edec93069f1b9>) |
| Material 目录 | [folder-src.svg](<https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/folder-src.svg>)、[folder-base.svg](<https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/folder-base.svg>) |
| Material 配置与浅色例 | [json.svg](<https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/json.svg>)、[toml_light.svg](<https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/toml_light.svg>) |
| vscode-icons 文件／展开目录 | [file_type_typescript.svg](<https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/file_type_typescript.svg>)、[default_folder.svg](<https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/default_folder.svg>)、[default_folder_opened.svg](<https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/default_folder_opened.svg>) |
| Seti 文件 | [javascript.svg](<https://raw.githubusercontent.com/jesseweed/seti-ui/master/icons/javascript.svg>)；[图标目录](<https://github.com/jesseweed/seti-ui/tree/master/icons>)；[扩展名／文件名映射][S3] |
| Lucide 操作 | [search.svg](<https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/search.svg>)；[官方源码目录](<https://github.com/lucide-icons/lucide/tree/main/icons>) |

本次官方分支快照：Material `13025adc5ad10a5cc649528a2c1edec93069f1b9`、vscode-icons `82dde38f58ffc2a7def3efadb11208d010841a8f`、Seti `2d6c5e68b4ded73c92dac291845ee44e1182d511`、Lucide `1ef60af944de207e0d5176905a0759ba12e6ee8d`，分别由官方 Git ref API 核验：[Material](<https://api.github.com/repos/material-extensions/vscode-material-icon-theme/git/ref/heads/main>)、[vscode-icons](<https://api.github.com/repos/vscode-icons/vscode-icons/git/ref/heads/master>)、[Seti](<https://api.github.com/repos/jesseweed/seti-ui/git/ref/heads/master>)、[Lucide](<https://api.github.com/repos/lucide-icons/lucide/git/ref/heads/main>)。其余 `main/master` 链接是便于查找的入口，实际内置时应替换为相应提交。

**Material 路径陷阱：** 本次当前分支的 `icons/folder.svg`、`folder-default.svg`、`folder-src-open.svg` 返回 404；不要凭命名拼接展开态资源 URL。可先用已核验目录图标 + 独立 chevron 表达展开；要复用主题原有默认／展开态，应读取锁版生成 manifest 指向的真实产物，源码入口见 [folderGenerator.ts](<https://github.com/material-extensions/vscode-material-icon-theme/blob/main/src/core/generator/folderGenerator.ts>)。[M3]

## 落地与降级建议（非本次实施）

1. **先取精选子集而非整包。** 覆盖 JS/TS/JSX/TSX、JSON/YAML/TOML、Markdown、Python、Java、Go/Rust、HTML/CSS、Shell/PowerShell、SQL、图片，以及本工程常见特殊文件和目录；保留来源、上游提交、哈希及许可全文到最终分发清单。品牌图标只用于识别文件，不暗示品牌背书。
2. **映射层确定且可测。** basename 特例优先 → 最长复合扩展名 → 普通扩展名 → 通用文件；目录单独按名称／根目录／展开状态映射。保留大小写约定与仓库身份，不读取文件内容猜图标。至少覆盖 `package.json`、`.gitignore`、`Dockerfile`、`foo.d.ts`、`foo.test.ts`、无扩展名及未知扩展名。[M2] [M3]
3. **视觉与安全。** 文件图标建议固定 16–18 px，操作图标统一描边；两主题都检查正常／悬停／选中背景。图标装饰性地隐藏于辅助技术，按钮保留可访问名称；展开状态同时由 chevron 与 `aria-expanded` 传达。只内置审计过的静态 SVG，不渲染仓库中的任意 SVG，不从文件名构造远程地址，不向 `dangerouslySetInnerHTML` 传入外部内容。
4. **降级顺序。** 未覆盖类型 → 本地通用文件／文件夹 SVG；资源异常 → 仍显示文件名、类型文字与展开控件。若要求更克制的整套视觉，可整体改选 **Seti 文件图标 + Lucide 目录／操作**，但不要零散混入多个品牌主题。vscode-icons 仅在明确接受并落实 CC BY-SA／品牌条款时考虑，不作为缺图时的无审查补丁。

## 第一手来源

- Material：[MIT 许可证][M1]、[官方 README][M2]、[映射与生成器源码][M3]。
- vscode-icons：[官方功能／许可声明][V1]、[CC BY-SA 4.0 官方条款][V2]、[映射源码][V3]。
- Seti：[MIT 许可证][S1]、[官方 README][S2]、[原始映射][S3]。
- Lucide：[ISC／Feather MIT 声明][L1]、[静态资源指南][L2]。

[M1]: https://github.com/material-extensions/vscode-material-icon-theme/blob/main/LICENSE "Material Icon Theme MIT 许可证（官方 API 已核验 LICENSE 内容）"
[M2]: https://github.com/material-extensions/vscode-material-icon-theme/blob/main/README.md "Material 官方 README：文件／目录关联、颜色、浅色克隆、图标来源；已通过官方 README API 获取"
[M3]: https://github.com/material-extensions/vscode-material-icon-theme/tree/main/src/core "Material：icons/fileIcons.ts、folderIcons.ts、languageIcons.ts 与 generator/generateManifest.ts"
[M4]: https://api.github.com/repos/material-extensions/vscode-material-icon-theme/contents/icons/toml_light.svg "Material 浅色 SVG 第一手资源"
[V1]: https://vscode-icons.github.io/vscode-icons/ "vscode-icons 官方主页：功能与源码／图标／品牌许可分离声明"
[V2]: https://creativecommons.org/licenses/by-sa/4.0/ "CC BY-SA 4.0 官方条款；源码 MIT 另见 github.com/vscode-icons/vscode-icons/blob/master/LICENSE"
[V3]: https://github.com/vscode-icons/vscode-icons/tree/master/src/iconsManifest "vscode-icons：supportedExtensions.ts、supportedFolders.ts、manifestBuilder.ts"
[V4]: https://api.github.com/repos/vscode-icons/vscode-icons/contents/icons/file_type_light_json.svg "vscode-icons 浅色 SVG 第一手资源"
[S1]: https://github.com/jesseweed/seti-ui/blob/master/LICENSE.md "Seti UI MIT 许可证（官方 API 已核验内容）"
[S2]: https://github.com/jesseweed/seti-ui/blob/master/README.md "Seti 官方 README：深色来源、单色 SVG、配色、生成流程；已通过官方 README API 获取"
[S3]: https://github.com/jesseweed/seti-ui/blob/master/styles/components/icons/mapping.less "Seti 原始扩展名／特殊文件名映射"
[L1]: https://lucide.dev/license.md "Lucide 官方许可：ISC 与 Feather 派生 MIT 声明"
[L2]: https://lucide.dev/guide/static.md "Lucide 官方静态资源指南：独立 SVG，无 JS 框架依赖"
[L3]: https://api.github.com/repos/lucide-icons/lucide/contents/icons/search.svg "Lucide 原始 SVG：currentColor 描边"
