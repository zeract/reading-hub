# Reading Hub

本地优先的 macOS 多源阅读器 MVP。它聚合 RSS、Atom、JSON Feed、公开网页结构化内容，以及用户主动粘贴的小红书分享链接；内容以摘要卡片展示，并在安全的应用内阅读器中按需加载正文。

## 运行

```bash
npm install
npm run dev
```

`npm run dist` 会生成 macOS 安装包。数据存储在 Electron 的 `userData` 目录；如启用知乎关注动态，知乎登录会话仅保存在 Reading Hub 的本机 Electron 分区中，不读取 Chrome 的 Cookie。

开发脚本会自动选择未占用的本机端口，并会等主进程和 preload 桥接都完成编译后再启动 Electron。若升级 Electron 后报 `better-sqlite3` 或 `keytar` 的 ABI 不匹配，运行：

```bash
npm run rebuild:electron
```

## 平台边界

- 知乎关注动态使用用户在 Reading Hub 内主动完成的独立登录会话，读取“关注”页中可见的公开卡片；不会读取或迁移 Chrome Cookie，不会保存密码，也不绕过验证码。取消订阅该来源会清除本机会话，已有内容和收藏继续保留。
- 小红书分享链接可保存为一次性阅读卡片；公开博主入口只读取未登录页面提供的结构化笔记列表，不登录、不保存 Cookie，也不绕过访问控制。
- 通用网页只访问公开 HTTP/HTTPS 地址，阻止 localhost/私有地址，遵守 robots 规则并对同域名串行限速。
- robots 支持专用爬虫组、Allow/Disallow 最长匹配、通配符及编码路径。策略遇到网络错误、5xx 或 429 时暂缓自动读取，一小时后重新检查；明确不存在的策略与成功规则最多缓存 24 小时。阅读仍可使用 Feed 已提供的摘要或受限原文入口。
- 无 Feed 的公开网页会自动识别内容列表；需要复核时，只需在“自动校准”中选择正确的文章卡片组，无需编写 CSS 选择器。
- X 使用官方 API 的 OAuth 2.0 PKCE 授权。请先在 X Developer Console 配置回调地址 `http://127.0.0.1:43119/x/callback`，然后在应用中输入 Client ID；访问与刷新令牌只保存在 macOS Keychain。默认收集所关注账号的原创帖与文章型外链，不读取浏览器 Cookie。
- X 最多跟踪 200 个关注账号，关注列表每 6 小时刷新。首次收集每位作者最新一页（最多 20 条）；后续增量超过一页时，每轮继续一页并保存进度，读完后才推进增量起点，不自动导入完整历史。
- 学术作者搜索保留同名作者的独立数据库身份，并显示作者 ID 与可用的论文数量。只有有效 ORCID 相同且各数据库 ID 不冲突时才合并跨库结果；姓名相同不会自动合并。
- “学术作者更新”聚合 OpenAlex、Semantic Scholar 及可公开读取的 ORCID works，并在卡片中保留实际数据来源；它不是 Google Scholar 登录态、页面或邮件的同步。

## 收集与阅读

- OPML 导入与手动添加 Feed 使用相同的地址去重规则：保留路径末尾的 `/` 和全部查询参数，仅忽略 `#` 后的片段。不同路径或查询参数可能对应不同订阅；普通网页仍保留片段导航。
- 默认“新收集”按首次收集时间排序；“今日发布”按实际发布时间筛选，“历史回填”单独展示明确导入的归档条目。
- “全部内容”支持跨来源搜索标题、作者和摘要；选择来源后搜索限于该来源，不保存或索引正文。
- 正文成功显示后才自动标为已读，加载失败保留未读状态。
- 取消订阅会停止同步，保留文章与收藏；可从侧栏的“已取消订阅”重新启用。清理来源只影响独有且未收藏的内容。
- 卡片删除后可立即撤销，或在“最近删除”恢复。恢复入口在重启后仍可使用；升级前已经物理删除的内容无法恢复。
- 来源设置显示最近成功时间、下次检查和错误原因；类型调整位于高级设置，账号及作者连接位于添加来源的展开区。

## 内置阅读器 AI 学习

在任一文章阅读页点击“AI 学习”，选择 OpenAI API、DeepSeek 或“本机 Codex CLI”，即可针对当前文章提问。OpenAI 与 DeepSeek 的 Key 和模型设置仅保存到 macOS Keychain；问题、回答和正文不会写入 SQLite。

- OpenAI 使用 Responses API 与可配置模型（默认 `gpt-5.6`），请求设置 `store: false`。
- DeepSeek 使用 Chat Completions API，默认模型为 `deepseek-v4-flash`，也可按账户可用模型调整。
- 本机 Codex 使用已登录的 App Server，不读取、复制或存储登录凭证。每次请求创建独立的临时只读任务；模型和推理强度从本机发现。API 模型支持动态刷新和手动输入，发现失败保留已保存选择。问答模型与强度偏好保存在 macOS Keychain。
- 为控制发送范围，每次提问只会发送当前文章提取后的前 18,000 个字符、标题、来源和链接；AI 面板关闭后，对话仅留在当前界面内存中。

## 本地中文改写

在“设置 → AI 功能 → 中文改写”单独保存改写服务与模型，再打开文章点击“生成中文改写”。使用已有的 Keychain 凭据，仅主动生成或检查时向所选服务发送从文章原始链接读取的正文。不会随订阅自动生成或改变 AI 学习的模型。

任务在应用运行期间后台排队，切换文章不影响生成；生成中可取消，并在原文与本地改写之间切换。排队任务重启后继续，退出或崩溃中断的运行任务可手动重试。长文按段落、代码和公式分段，超过限制或只有摘要时明确失败，不截取前半篇冒充完整改写。

收藏工具栏左侧以无边框下拉框提供“原文 / 中文改写”切换，选择尚未生成的版本不会调用模型。默认每节一次改写，短文一次完成，长文携带已生成上下文保持术语和衔接；不再强制逐节提纲、审阅、修订。完整中文立即保存。失败后重试会复用原文、模型及提示版本一致的已完成分段，成功后清除恢复记录。

完成后只显示标题和正文，不显示额外说明、生成元数据或重新生成/删除/检查按钮。正文统一使用朱雀仿宋；图片经现有主进程代理显示，链接使用标准 Markdown 解析。旧稿中的有效图片 Markdown 可直接显示，不会自动调用模型重新生成。

改写正文、模型、生成时间与原文指纹保存到本地 SQLite，原文不被覆盖；只有整篇成功才替换旧稿，失败保留旧稿。取消订阅删除独有文章时同时删除改写，共享文章仍保留。模型回答以安全 Markdown 显示，不执行模型生成的 HTML，也不会公开发布内容。

## 工程文档

- [当前架构与状态归属](docs/architecture.md)
- [界面规范](docs/ui-design.md)
- [逐轮审查与验证记录](docs/architecture-review.md)
- [架构重构与界面统一验收](docs/completion-audit.md)

## 质量检查

```bash
npm test             # 离线夹具、数据库迁移、连接器与阅读提取
npm run audit:ipc    # 真实窗口/preload：订阅释放、请求取消隔离和退出收尾
npm run audit:style  # CSS 结构与阅读器约束
npm run audit:visual # Electron 实际布局：公式编号、图片和溢出
npm run audit:reader # 只读审计已保存来源的最新与一篇历史文章
```

`audit:reader` 从只读连接创建包含 WAL 的临时数据库快照，只迁移副本，再访问其中的公开来源；遵守 robots，不保存正文或凭证。默认抽查每个来源的最新文章和一篇确定性历史文章；`audit:visual` 可设置 `READING_HUB_VISUAL_OUTPUT=/tmp/reading-hub-visual` 输出四个视口的诊断截图。

如需针对单个来源排查，可在本机执行：

```bash
READING_HUB_AUDIT_SOURCE='苏剑林博客' npm run audit:reader
```

对一个来源做逐篇阅读器回归（会按来源限速，适合修复公式或提取问题后执行）：

```bash
READING_HUB_AUDIT_SOURCE='苏剑林博客' READING_HUB_AUDIT_ALL=1 npm run audit:reader
```

逐篇检查科学空间的真实 KaTeX/MathJax 成品在窄窗口、默认窗口和 125% 字号下的公式编号、横向滚动、图片列宽及页面溢出（仅输出诊断，不写入文章 HTML）：

```bash
READING_HUB_AUDIT_SOURCE='苏剑林博客' READING_HUB_AUDIT_ALL=1 npm run audit:scientific-visual
```

## 连接器扩展

所有连接器均由编译内置的注册表加载。调度、robots、限流、数据库、Keychain、阅读渲染和 IPC 始终由宿主控制；当前版本不加载第三方插件代码。新的内置连接器实现 `ConnectorAdapter`，并提供 manifest、同步、规范化和离线夹具测试。

可运行 `npm run audit:rewrite` 使用已配置的 DeepSeek 对固定非私密博客、长文和公式样本进行真实模型对比评估，会消耗模型额度。可用 `READING_HUB_REWRITE_PROVIDER`、`READING_HUB_REWRITE_MODEL` 选择服务/模型，`READING_HUB_REWRITE_REPORT` 指定报告路径；数值检查只作基础检查，需人工阅读结果判断文风和忠实性。
