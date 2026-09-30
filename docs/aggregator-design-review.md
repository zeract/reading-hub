# 聚合器设计评审与修复决策

评审日期：2026-09-29
评审范围：连接器抽象、来源调度、内容身份与去重、提取与资格过滤、阅读回退、能力模型
评审方式：先做只读代码审查；下述标为「已修复」的条目另有确定性测试。其余结论仍不是线上复现结果。
适用读者：负责修复的实现方（Codex）

> 本文区分已证实的代码事实、待复现的用户影响和设计选择；它不是把所有建议一次性实施的授权。标注「待验证」的条目须先复现。
> 修复需遵循 `AGENTS.md` 完成门禁：代码修改必须跑 `git diff --check`、相关测试、`npm run build`；涉及数据库/同步需覆盖新增、去重、发布时间排序、失败退避、重启恢复；涉及正文提取需覆盖问题案例与相邻边界。
> 跨模块/协议/数据库变更须按 `docs/tasks/TEMPLATE.md` 先建任务记录。

---

## 0. 总体结论

管线骨架是可靠的：**连接器只产出 `RawEntry` → 宿主统一做资格过滤 → 规范化 → 单事务提交 → 统一渲染**，取消、退出、robots、限流、凭据边界收敛得干净，没有需要推翻的分层。

仍有两项值得分阶段治理的结构问题：

1. **内容身份的职责仍不完整**：`canonical_url` 仍是数据库唯一键；新采集只在连接器声明已知身份命名空间、且库中唯一匹配时跨阅读 URL 合并。冲突项被跳过并留下固定类别告警，不猜测修复历史行；多身份别名迁移仍待设计。`content_hash` 是卡片元数据指纹而非正文哈希，尚未参与变化判断。
2. **扩展声明与宿主行为不一致**：`sourceCapabilities`、调度与阅读降级仍有来源类型分支。未产生行为的 `allowedHosts` 与 `capabilities` 已移除；`entryPolicy`、`identityNamespaces` 由同步宿主执行，`requiresAccount` 由宿主校验。宿主继续掌握安全、调度和持久化决策。

泛化性结论：RSS/普通网页的主路径合理；加入新平台仍会碰到 UI、能力与平台配置的显式接线，但「约 8 个宿主模块」只是一次静态观察，不能作为所有连接器的必然成本。当前是编译内置适配器架构，不以第三方即插即用为验收目标。

---

## 1. 设计缺陷清单

严重度定义：
- **P1**：已有确定性反例或明显安全边界错误，需要优先修复。
- **P2**：已证实的契约/维护缺口，但需先确定需求和迁移方式。
- **P3**：边界观察或待复现风险，不能仅凭代码形态断言用户故障。

### P2-1 `content_hash` 尚无业务用途（待决策）

**现象**：`content_hash` 被计算、写入，同一主归属来源的元数据更新会覆盖它，但**从库中读取它做业务判断的代码不存在**。

**证据**：
- 写入与覆盖：`src/main/database.ts` 的 `saveEntriesWithReport`；其他来源增加归属时不再覆盖主卡片指纹。
- 生成：`src/main/content-normalizer.ts:64`、`src/main/content-hash.ts:8`、`src/main/content-hash.ts:20`
- schema 定义：`src/main/persistence/schema.ts:89`
- 读取：仅出现在 `SELECT` 列清单与行映射中（`src/main/database.ts:745`、`:775`、`:881`、`:232`），**没有任何比较、过滤或业务判断读取它**；全仓库除 `content-hash.ts` 与上述位置外无其他 `contentHash` 使用点。

**影响**：
- 文章标题、摘要或日期改变时，卡片会更新而没有独立变化记录；这是一个潜在需求，不等于已证明的正确性故障。
- 当前指纹只覆盖显示元数据，不覆盖正文，不能命名或解释为「文章内容已更新」。撤稿重发也不能仅凭这个指纹识别。
- 当前仍有计算与存储成本，而指纹尚未驱动可观察的业务能力；是否值得保留需要产品决策，不能仅凭字段未被比较就认定为当前故障。

**修复方向（二选一，不要维持现状）**：
- 若确有产品需求，先定义「卡片元数据更新」的可观察语义及发布时间纠正、来源间摘要差异的处理，再用旧/新指纹比较，保留已读/收藏状态。
- 若不需要，计划在独立、可回滚的数据库迁移中删除指纹；不能为消除死字段而仓促重建用户表。本轮不增加未经要求的「已更新」UI。

**决策前验收**：先确定启用还是删除；启用时分别测试真实元数据变更、发布时间校正和不同提供方摘要，避免把后二者误报成正文更新。

---

### P2-2 内容身份与跨来源归属未完全统一（待复现及迁移设计）

**现象与修复状态**：修复前 `canonical_url` 是唯一入库冲突键，`canonical_identity` 主要用于墓碑匹配。现已由内置连接器显式声明允许使用的身份命名空间，在最终入库事务中查找唯一权威身份，以合并不同阅读 URL 的同一内容；提供方对象 ID 只允许所属连接器声明，DOI/arXiv 可跨提供方声明。数据库唯一约束仍是 `canonical_url`，历史冲突与别名关系尚未迁移。

**证据**：
- 唯一约束与 upsert 冲突键：`src/main/persistence/schema.ts:82`（`canonical_url TEXT NOT NULL UNIQUE`）、`src/main/database.ts:1078`（`ON CONFLICT(canonical_url) DO UPDATE`）
- 修复前 `canonical_identity` 主要用于墓碑匹配；现在 `saveEntriesWithReport` 按连接器声明查找唯一现存内容，即使 URL 已命中也检查是否有另一行拥有该身份。它仍不是数据库唯一键，也没有历史别名表。
- 类型注释声称身份用于"cross-provider grouping"：`src/shared/types.ts:141`
- 修复前 `saveEntries` 只用 `canonical_url` 查找。现新增 `canonical_identity` 的精确查找；仅在声明授权、唯一匹配且无 URL/身份交叉冲突时复用现存行和来源归属。历史中同 ID 多行，或同 URL 与另一身份行冲突时跳过该条，并记录不含原始 URL/身份的固定类别告警；同批其他条目继续写入。

**后果（均可由代码推出）**：

1. **已有 DOI URL 规范化，且新增显式稳定身份的不同 URL 可合并。**
   Academic 连接器把有 DOI 的论文规范为 `https://doi.org/{doi}`（`src/main/academic.ts:126`、`:152`、`:174`）；新的精确身份查找覆盖其他显式共同 ID 的 URL 差异。没有共同权威标识的转载、镜像仍不自动合并，这是避免误合并的安全边界。

2. **墓碑键与去重键仍不完全统一。**
   同一显式稳定身份的 URL 变化现可命中旧墓碑；没有这种身份的 URL 变化仍可能产生新卡片。同一 URL 的身份改变已有双向墓碑检查，已知 Scour 和首页历史修复也会迁移删除记录，不能概括为「身份前缀一变就永久失配」。

3. **没有稳定 URL 的来源必须自造身份协议。**
   X 与小红书专用连接器已于 2026-09-30 删除，对应命名空间不再允许新适配器声明；旧卡片身份仍按原值保留，不猜测重写。
   学术：`doi: / arxiv: / openalex: / semantic: / orcid:`（`src/main/academic.ts:132`、`:158`、`:183`）
   `ContentNormalizationOptions`（`src/main/content-normalizer.ts:13-30`）允许平台表达固有身份；`ConnectorManifest.identityNamespaces` 现在约束跨 URL 桥接。仍缺少多个身份别名之间的关系和旧冲突裁决。

**修复方向**：
- **已修复新采集的确定性部分**：相同显式 DOI、不同阅读 URL 的条目复用原卡片与来源归属；未声明的形似身份不桥接；同 URL 异权威身份、旧库同身份多行都跳过而不写坏原卡片；后来来源只增加归属，不覆盖主归属来源的标题、摘要、哈希或阅读地址。同一主归属来源仍可更新其元数据。
- 共享 DOI/arXiv 等经证实的内容标识应跨提供方可组合，提供方对象 ID 应作为有命名空间的别名，不应排在 DOI 前面把同一论文拆开。
- 设计内容行、阅读 URL 与多个经证实的身份别名的关系；仅在一对一且无冲突时合并。保留来源归属、收藏/已读、首次收集时间、改写与删除记录；未知关系不猜测。
- 独立设计迁移和回滚验证，再决定是否更换唯一键。不能仅把现有 `canonical_identity` 升为唯一键。

**验收要点**：共同 DOI、URL 不同的新采集夹具只产生一张卡片，重启后保持已读/收藏与两条来源归属，已删内容不复活；同标题无 ID 不合并。历史冲突的自动迁移尚未实现，必须另行验收。

---

### P2-3 连接器声明没有完整表达宿主策略

**现象**：接口只有 authorize / discover / inspectFacets / supportsHistoricalCollection / sync / normalize（`src/shared/types.ts:348-358`），但宿主在同步前后实际做的事远超这些。

**证据**：

| 宿主实际行为 | 位置 | 接口里对应能力 |
| --- | --- | --- |
| 入库资格修复前按 `(connectorId ?? kind) === "generic"` 硬判；现由 manifest 的 `entryPolicy` 声明、宿主执行 | `src/main/sync-manager.ts:199-206` | 已增加受限声明 |
| 调度串行键是 `new URL(source.url).hostname` | `src/main/sync-manager.ts:79`、`:118` | 无（对 API 型/账号级额度来源，域名键既不充分也不正确） |
| 一次性修复与重放（`AUTOMATIC_RULE_REVISION`、`PUBLICATION_DATE_REVISION`、`FEED_DISCOVERY_REVISION`、`metadataRevision`） | `src/main/extractor.ts:61-68`、`src/main/connectors.ts:129-137`、`src/main/sync-manager.ts:139-144` | 无 |
| 按平台的遗留清理函数（已标 `@deprecated` 的 `deleteTaxonomyEntries` / `deleteUnsupportedZhihuFollowEntries` / `repair*`） | `src/main/database.ts:985-1008` | 无 |
| 通用规则替换只在 generic 上执行 | `src/main/sync-manager.ts:139-141`、`:157-161` | 无 |

**阅读回退策略同样按平台硬编码**（`src/main/article-reader.ts`）：
- `:196` 只有 `kind === "rss"` 能回退 Feed 正文
- `:288` 只有 `rss` / `x` 能用 Feed 摘要
- `:300` 只有 `zhihu_follow` 的 403 能降级为 `source_summary`

接口中没有阅读降级策略声明；但这并不意味着应允许连接器任意读取失败页面或接管阅读安全边界。

**修复方向**：优先使用受约束的声明，而不是把宿主权力搬成四个任意代码钩子。
- **已修复一部分**：RSS 与 generic 声明 `entryPolicy: "article-links"`，宿主在最终入库点统一拦截有明确证据的招聘目的地；直接 RSS、网页发现 Feed 与预览的行为一致。平台及用户主动保存的链接不被这种文章策略误过滤。
- 账号级额度与串行键由宿主调度器执行，连接器仅声明有限的预算键/请求类别；实际 API 429 与 `Retry-After` 仍按响应处理。
- 一次性历史修复继续归宿主事务和版本管理；可按连接器 ID 注册明确的迁移任务，不在普通 `sync` 中运行任意维护代码。
- 阅读降级只允许已保存摘要或本次合法获取的 Feed 正文等受限模式，并由宿主判定 robots/403 边界；不可把 `onReadFailure` 作为绕过入口。

**验收要点**：直接 RSS、普通网页与用户主动保存链接的测试覆盖了资格策略差异；未来新连接器须通过同一入库契约测试。调度与阅读策略分别以安全测试和账户级并发测试验收。不要求删除所有合法的兼容分支。

---

### P2-4 能力模型仍依赖 `SourceKind`；无效声明已移除

**现象**：用户操作能力是 `kind` 的硬编码真值表，与 `ConnectorManifest` 无推导关系；原 `allowedHosts` 没有进入网络执行路径，原 `capabilities` 也未参与任何操作判断。这两个陈列字段现已从契约删除。

**证据**：
- `src/shared/source-capabilities.ts:8-19`：`sourceCapabilities()` 逐个 `kind` 判断 `canPoll` / `canCalibrate` / `canReconnect` / `canChangeKind`。
- 修复前 `capabilities` 只有三个陈列性值（`"public-http" | "oauth" | "author-search"`），没有读取点；现已删除。`identityNamespaces` 不是类似陈列字段：注册时校验归属，同步入库时执行。
- 修复前 `allowedHosts` 无任何读取点；现已删除该字段与构造参数。公开 URL、robots 与各平台已有的请求目标校验不因删除该陈列字段而放松，但它们不是统一的 manifest 主机白名单。
- 渲染器仍显式列举平台：`src/renderer/source-dialogs.tsx:18-25`（`SOURCE_METHODS` 五项）、`:485-497`（`SOURCE_KIND_LABELS`）；每种来源有相应的授权/输入流程。

**结论**：当前是编译内置连接器，不是第三方插件平台；现有声明与实际操作能力的关系仍应明确。已移除无执行力的 `allowedHosts` 和 `capabilities`，不再把它们描述成安全或操作能力契约。

**修复方向**：下一阶段定义 manifest 的展示能力、授权方式和用户操作能力，宿主依来源当前状态计算最终可用动作；旧 `SourceKind` 只作兼容和展示。若未来需要统一平台网络白名单，必须另行覆盖实际请求及重定向，不能重新加一个不执行的字段。UI 入口可由能力列表配置，但授权表单仍需要明确的产品流程。

**验收要点**：新增内置测试连接器的刷新/校准/重连状态由同一能力模型决定；现有网络约束在真实请求路径上测试，不以注册表字段存在代替验证。

---

### P2-5 `SourceKind` 仍是实际路由键，`connectorId` 只覆盖一半

**证据**：
- 回退表达式散布：`src/main/sync-manager.ts:128`、`:200`、`:248`、`:261`、`src/main/source-service.ts`、`src/main/content-normalizer.ts`、`src/main/database.ts`
- `SourceKind` 为闭集 union 且自述为 UI 兼容层：`src/shared/types.ts:6`、`:2-5`
- 平台分支遍布宿主：`src/main/source-service.ts:163`、`:219`、`:246`、`:380`、`:404`、`src/main/database.ts:962`、`:1167`、`src/main/content-maintenance.ts:116`、`:150`、`src/main/persistence/legacy-content-repair.ts:181`、`src/main/reader-audit.ts:188`
- 渲染器分组与标签同样按 `kind`：`src/renderer/source-groups.ts:12-16`、`src/renderer/source-dialogs.tsx:485-497`

**影响**：`connectorId` 已能独立于 `kind` 路由同步；但若新增一种 UI `kind`，仍需更新输入校验、分组和标签。不能据此断言「一个连接器无法承载两个 kind」。

**修复方向**：新增路径只用 `connectorId` 路由；保留 `connectorId ?? kind` 兼容旧库，逐项减少宿主对 `kind` 的业务判断。迁移验证前不直接删除 `SourceKind` 或旧校验。

---

### P2-6 来源归属缺少可解释的资格契约

**证据**：
- 泛化路径只有两条：RSS，或"重复卡片列表 → 详情页"；无重复结构时退回 `openGraphFallback` 当作单条：`src/main/extractor.ts:44-51`
- 列表卡片即内容的平台靠特判降级为一次性卡片：`src/main/source-probe.ts:192-198`（`isXiaohongshuUrl`）、`src/main/source-service.ts:53`（强转 manual）
- 提取出的链接允许跨站；这是有意支持公开文章分区跨域托管的行为，并受 `AGENTS.md` 明确保护，不应改成强制同源。问题在于「这篇文章为何属于该来源」的证据尚未统一表达。

**修复方向**：
- 只在出现可复现的无详情页订阅需求时，明确建模列表/单篇/原生卡片，不把每种页面强行归入 CSS 规则。
- 保留跨站文章链接；对提取区块、标题链接、明确的非文章目的地及订阅范围建立可解释的证据/资格检查，预览和最终入库共用或各自核对。无证据时降级提示，不静默猜测。

**验收要点**：有明确文章区块证据的跨站链接被保留；招聘/导航链接不入库；未证实的外链不凭「跨域」一个条件判拒。

---

### P1-7 URL 规范化可能抹除内容身份（已修复确定性部分）

**修复前证据**：`src/shared/url.ts` 的 URL 规范化逻辑。

1. 修复前无条件丢弃 fragment，导致 `#/...`、`#!/...` 路由的不同内容塌成同一身份；这两种明确的路由形式现已保留。其他站点若以 `#id` 定位不同内容，仍需具体证据和规则，不能与普通段落锚点混同。
2. 修复前无条件删除 `ref`、`source` 等参数。`ref` / `source` 并非普遍是追踪参数（例如 GitHub 的 `?ref=` 指分支/标签），现已保留；明确的追踪参数仍按既有规则删除。

**相邻问题**：招聘过滤规则只在 URL 对已知站点形态有明确证据时生效；这一窄判定不能宣称覆盖所有招聘站点。此前直接 RSS 与 generic 的最终入库行为不一致。
- 规则本体：`src/main/content-eligibility.ts:4-8`（仅识别 `jobs.ashbyhq.com` 的 UUID 路径）
- 修复前生效范围：generic 末端过滤；网页发现 Feed 提前过滤；直接 RSS 无末端过滤。现已由 `entryPolicy` 统一到宿主最终入库点。

**修复方向与状态**：已停止全局删除 `ref`、`source`；保留常见明确追踪参数的现有去重行为。`canonicalizeContentUrl` 保留 `#/` 与 `#!/` 路由 fragment，普通段落锚点仍忽略。RSS/generic 的有证据招聘 URL 使用同一宿主后置过滤，预览同步过滤。其他站点的特殊查询/fragment 语义仍需具体反例，不能用「默认保留全部查询」制造大量追踪重复，也不能用标题关键词推断招聘。

**验收要点**：两条 hash 路由不合并；`?ref=`/`?source=` 保留；普通 `#section` 与 `utm_*` 仍规范化；直接 RSS 招聘目标不入库，用户主动保存链接不受影响。旧卡片中已丢失的参数或 fragment 无法无证据回填。

---

### P3-8 长期状态与空结果诊断（不应永久停止恢复）

**证据**：
- `dismissed_contents` 墓碑无 GC 策略，仅在删除来源时顺带清理：`src/main/database.ts:960`、schema `src/main/persistence/schema.ts:147-150`
- `entry_origins` 主键为 `(entry_id, source_id, provider_id, external_id)`；即使 `external_id` 为空，也不会使不同文章的来源归属互相覆盖。原评审对此的推论不成立。
- 失败来源保持可重试并有退避：`src/main/database.ts:1206`。这是断网恢复的必要行为，不能未经用户授权改成永久隔离。
- **RSS 解析后合法空结果可被视为健康**：`src/main/connectors.ts:64`。这可能掩盖从非空突变为空的异常，但空 Feed 本身合法；「永远显示健康」需要根据历史条目/响应结构复现，不能仅由一次 0 条推出。

**修复方向**：不对墓碑做任意时间/数量过期，否则活跃订阅中的已删文章会复活；仅在来源和对应内容确定不再需要时清理。RSS 可在「此前持续非空、之后连续成功解析为 0」等证据下提供非阻断告警，不能把合法空 Feed 自动停订。失败来源保留有界退避与网络恢复重试，现有错误状态保持可见；若需隔离，只针对确定性永久失败并定义明确恢复动作。

**验收要点**：分别覆盖初始合法空 Feed、由非空骤变为空、304、部分解析失败；已删内容不会因时间推移复活；离线恢复后可再次同步。

---

## 2. 泛化性评估

| 场景 | 泛化程度 | 依据 |
| --- | --- | --- |
| RSS / Atom / JSON Feed、普通博客网页 | 好 | 单一路径、契约清晰；文章 URL 资格过滤现已在入库点统一 |
| 有共同 DOI/arXiv 标识的平台 | 中 | 相同规范 URL 或新采集的唯一显式稳定 ID 可合并；旧库别名/冲突迁移未完成（P2-2） |
| 转载、镜像、无权威标识的同内容 | 不应自动合并 | 相似标题或跨站镜像不足以证明同一内容，错误合并风险高 |
| 列表卡片即内容、无详情页 | 待需求验证 | 当前单篇分享与平台连接器可处理部分情况，通用订阅模型尚未定义（P2-6） |
| 高频 API / 账号级配额 | 待专项测试 | 宿主按来源 URL 域名串行，但账号级预算尚未统一声明（P2-3） |
| 新增编译内置平台 | 中 | 需要显式 UI/配置接线；目标不是仅注册 manifest 即可完整上线（P2-4） |
| 源站结构变更导致静默失效 | 按来源类型不同 | generic 有连续空结果复核；RSS 要区分合法空 Feed 与异常骤空（P3-8） |

---

## 3. 建议的修复顺序（最小闭环）

1. **确定性正确性修复（已落地）**：收窄全局 URL 参数删除，保护 hash 路由；RSS/generic 通过宿主声明式资格策略统一入库，保留跨站文章与人工保存。见任务记录 `docs/tasks/aggregator-contract-review.md`。
2. **能力与安全契约（部分完成，下一阶段）**：无效的 `allowedHosts` 和 `capabilities` 已删除。仍需核实每个连接器实际请求路径，再统一展示能力与宿主操作校验，避免仅改 UI 真值表；如需新的平台网络限制，必须是真正可执行的宿主策略。
3. **内容身份原型与迁移设计（部分完成，独立高风险阶段）**：新采集的声明式身份桥接、归属元数据保护与冲突跳过已覆盖；接下来设计多身份别名、旧库冲突裁决和迁移回滚，先验证快照及用户状态，再考虑唯一键迁移。
4. **按需求补齐调度/阅读策略**：账号级预算由宿主执行，阅读降级保持受限；只在有新增连接器反例时扩展 manifest。历史修复保持宿主版本化事务。
5. **可观察性而非永久隔离**：RSS 空结果风险先用合法空/骤空夹具分辨；维持网络恢复重试与删除记录持久性。

---

## 4. 交给实现方的约束与门禁

- 不要用"覆盖当前样例"的启发式补丁替代模型/契约改动（`AGENTS.md` 工作原则）。
- 每步修改保持最小可维护，复用既有抽象，删除被替代的重复代码；不顺手扩大范围。
- 按 `AGENTS.md` 的影响范围表选择门禁；数据库/同步类改动必须覆盖新增、去重、发布时间排序、失败退避、重启恢复、权限/令牌失效。
- 历史数据修复与新流程修正**分开验收**；旧稿按授权范围备份、对照、校验后再更新。
- 不确定的外部状态（站点结构、平台 API、配额规则）先核实，不绕过登录/验证码/robots/访问控制。
- 交付时列出主要修改、验证命令、未运行项及原因，并创建语义清晰的 commit。

---

## 5. 待验证事项（动手前先复现）

- P2-1：确认产品是否需要卡片元数据变化记录；现有哈希不代表正文变化。
- P2-2：共同 DOI、不同 URL、同 URL 异身份、旧库同身份多行、来源间元数据归属和冲突告警的确定性夹具已覆盖；仍需验证多个 ID 指向同一作品时的别名关系和旧库迁移影响。
- P1-7：`#/...` / `#!/...`、`ref`/`source` 的确定性用例已覆盖；其他站点自定义身份参数仍待具体证据。
- P3-8：构造「曾非空、连续成功解析为空」与合法空 Feed 对照夹具，验证诊断方案不会停掉正常来源。

---

## 6. 附：关键证据索引（便于实现方定位）

| 主题 | 位置 |
| --- | --- |
| 唯一身份与 upsert | `src/main/persistence/schema.ts:82`、`src/main/database.ts:1078-1135` |
| 墓碑语义 | `src/main/database.ts:164`、`:1090`、`:1109`、`:960` |
| 内容哈希 | `src/main/content-hash.ts:8`、`:20`、`src/main/content-normalizer.ts:64`、`src/main/database.ts:1084` |
| 连接器接口 | `src/shared/types.ts:287-358` |
| 注册表与 manifest | `src/main/connector-registry.ts:13-45` |
| 调度与入库 | `src/main/sync-manager.ts:79`、`:118`、`:139-161`、`:200-207` |
| 能力真值表 | `src/shared/source-capabilities.ts:8-19` |
| 提取与资格 | `src/main/extractor.ts:44-51`、`:322`、`src/main/content-eligibility.ts:4-8` |
| 阅读回退 | `src/main/article-reader.ts:196`、`:288`、`:300` |
| URL 规范化 | `src/shared/url.ts:91-114` |
| 空结果复核与失败重试 | `src/main/database.ts:1167`、`:1206`、`src/main/connectors.ts:64` |
| 渲染器平台硬编码 | `src/renderer/source-dialogs.tsx:21-24`、`:485-497`、`src/renderer/source-groups.ts:12-16` |
