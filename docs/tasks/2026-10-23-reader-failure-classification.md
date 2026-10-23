# 在线抽检未通过文章分类与诊断修复

状态：诊断修复与验收完成；外部依赖及授权限制保留

## 目标与范围

复核 c6637c5 在线抽检的 15 个非通过样本，区分外部访问/服务限制、缺少验收条件和软件缺陷。修复明确的问题；不绕过 robots、登录或出版社访问控制，不按相似标题替换链接，不修改用户数据库。

## 根因与证据

- 22:14–22:18 使用正常 PublicHttpClient/RobotsPolicy 和临时 Electron 配置有界复核，元数据记录在 `/tmp/reading-hub-failure-probe.json`，不保存网页正文。
- Twitter 四个订阅的本机 RSSHub 均无法连接；X 明确 robots 拒绝。8 个摘要不是正文提取成功，也没有证据证明为 RSS 解析缺陷。
- Medium 的 Turing 旧文 HTTP 403；Shengyu `2026/08/31/beyond-RL` HTTP 404。当前首页声明了 08/27 与 10/13 的不同文章链接，不能只凭相似路径确定哪个替代旧文。现有通用提取测试已覆盖作者声明的 08/27 链接，不生成日期 URL。
- 科学空间 11854 HTTP 403，当前 RSS 200、10 条，未包含此旧文；安全回退摘要正确，但完整正文/153 条公式仍未验证。
- DOI robots 此次可读；Visualinux 后续 HTTP 403。护理附加文件 DOI 重定向到 Figshare，返回 202 HTML（1995 字符），需继续核对是否有可提取正文。
- 知乎 2 篇：独立审计无授权会话，属于验收条件不足，不证明应用登录失效。
- 确认的软件缺口：静态读取/渲染失败及 Feed 回退失败被吞掉，报告仅剩“摘要未验证”；报告只有标题，遇到同标题不同 DOI 不能唯一定位样本。增加可选、主进程内固定诊断及 entryId，不新增用户交互、不存远端响应/错误原文。

## 实施与验收

- 诊断保留 static/render/feed 阶段、固定原因和 HTTP 状态；robots 未知与明确拒绝分开；未知异常不自动判断为外部或软件缺陷。
- 提取、净化、公式、媒体、阅读器展示、持久化均不改变。统一重复 Feed 回退错误处理，取消继续向上传播；诊断回调不得干扰正常读取。
- 针对性测试：摘要/Feed 正文回退、Feed 无目标/无正文、403/404、网络、robots、未知异常、取消与诊断回调异常；本地构建、diff 检查；同版定向在线样本验证。无模型调用、无视觉变更，不重复全站/视觉验收。

## 最终逐项结论

| 上次未通过样本 | 本次结论 | 处置 |
| --- | --- | --- |
| 向阳乔木：AI 播客；最佳 X 发帖时间 | 2 篇均 X robots 拒绝 + 本机 Feed 网络失败 | 保留摘要，不记正文通过 |
| Zartbot：content aware chunking；DeepSeek V4.1 架构分析 | 同上 | 同上 |
| Madison Kanna：Fireworks Tokenomics；swyx radio silence | 同上 | 同上 |
| Charlie O’Neill：research conference；RSI cumulative task | 同上 | 同上 |
| Computing machinery and intelligence - Alan Turing (I) | 静态与隔离浏览器均 HTTP 403 | 远端拒绝；不解析错误页 |
| Beyond Rl | 静态与隔离浏览器均 HTTP 404 | 旧地址失效；没有足够身份依据替换地址 |
| 除了交叉熵，LM Loss还有什么选择？ | 初查 403，最终恢复原文；153/153 公式成功 | 实际原文通过；另行完成三档原生 DOM 排版检查 |
| 知乎：OpenAI 员工窃听器；八州起诉 OpenAI | 2 篇均缺审计授权会话 | 未验证，不判断用户登录失效 |
| Visualinux: Visual Debugging for the Linux Kernel | robots 暂时不可达已恢复，后续静态/渲染均 403 | 出版页拒绝 |
| Additional file 2 of Understanding undergraduate nursing students’ learning journeys with artificial intelligence: a journey mapping study | 静态/渲染无正文；202 页面含 AWS WAF challenge 与 token.awswaf.com 脚本 | 访问挑战，未取得正文；不绕过 |

- 上次 15 篇：1 篇恢复并通过，12 篇受外部访问、失效地址或本机依赖影响，2 篇缺审计授权。没有从本次证据确认新的正文提取/公式缺陷；修复的是原因被摘要回退吞掉、同标题样本不能唯一定位的审计缺陷。
- 本机 1200 无监听，Docker daemon 不可连接；未擅自新建 RSSHub、设置第三方凭据或修改订阅。需要恢复用户已有 Feed 服务后才能取得 Feed 正文，旧条目是否仍在 Feed 内仍需届时验证。
- 学术附加文件在 SQLite 的原始归属为 OpenAlex。对应上游记录复核返回 404，不能确认作者归属或凭标题认定误收，未改采集规则或删除用户条目。同标题有带版本/不带版本两个 DOI，本次审计 `entryId` 明确实际抽中带版本的记录。

## 验证与耗时

- 针对性测试命令：`npm test -- test/reader-diagnostics.test.ts test/article-reader.test.ts test/reader-audit-cancellation.test.ts test/http-request-lifetime.test.ts test/http-local-feed.test.ts test/reader-extraction-cancellation.test.ts test/reader-language-cache.test.ts`，7 文件 / 159 项通过（1.63 秒）。
- `npm run build`、`git diff --check` 通过；未改展示路径/CSS、净化或公式逻辑，不重复全站 102 篇、全应用视觉或模型验收。
- 同一构建对 9 个相关来源最新/历史抽检 18 篇：4 passed、8 issues、4 failed、2 skipped，元数据 `/tmp/reading-hub-followup-audit.json`。其中科学空间最新是 Feed 正文（1 条公式），不能代表该篇原页全文；其他 3 个 passed 是原文。该报告由现有 `auditLocalReader` 按已有 `sourceFilter` 顺序执行，非虚构的多来源筛选参数。
- 科学空间旧文额外在窄/默认/125% 三档原生 DOM 检查，153 条公式、16 个块公式无丢失/降级、碰撞、裁切或页面溢出告警。结果 `/tmp/reading-hub-followup-science.json`。只证明此正文公式排版，不代表全应用/全部媒体验收。
- 只读探查与学术挑战元数据分别在 `/tmp/reading-hub-failure-probe.json`、`/tmp/reading-hub-academic-probe.json`，不提交本地报告或全文。
- 可追溯时间：22:14 开始本轮现场请求；22:18 实现、针对性测试与构建完成；22:18–22:20 相关来源审计累计运行约 57 秒；22:22 完成挑战页核对与额外公式 DOM 验收。此前历史/代码调查没有独立计时。临时脚本两处运行条件错误（隐藏窗口关闭导致进程提前退出、样式根目录默认指向 /tmp）已修正；已完成来源不重复，样式错误后的公式检查重新执行，不把脚本失败冒充站点失败。
- 新诊断仅使用固定枚举与数字状态；未知异常不从远端错误字符串猜测，回调失败不影响正文，取消不回退摘要。IPC 不暴露回调，不新增持久化、网络权限或原站脚本执行路径。删除重复 Feed 异常处理，未发现本次新增废弃分支。
- SQLite、旧改写、收藏和登录凭据未修改，无历史数据迁移。需要重启开发应用加载新的主进程诊断；无安装包或远端 CI 验收。


## 后续：恢复本机 RSSHub（2026-10-23 22:27–22:30）

用户明确要求恢复服务并复查同一批 8 篇 Twitter。启动已安装的 Docker Desktop 后，已有 `rsshub-rsshub-1`、`rsshub-redis-1`、`rsshub-browserless-1` 自动恢复，三个容器均 healthy，1200 端口可用。未新建容器、修改配置、读取凭据或改变应用代码。

以原来 8 个 entryId 对只读数据库快照执行正常 ArticleReader 管线，累计约 31 秒：

| 来源 | 原最新样本 | 原历史样本 |
| --- | --- | --- |
| 向阳乔木 | AI 播客：仍为摘要 | 最佳 X 发帖时间：仍为摘要 |
| Zartbot | content aware chunking：Feed 正文通过 | DeepSeek V4.1 架构分析：Feed 正文及图片通过 |
| Madison Kanna | Fireworks Tokenomics：Feed 正文及图片通过 | swyx radio silence：仍为摘要 |
| Charlie O’Neill | research conference：Feed 正文通过 | RSI cumulative task：仍为摘要 |

- 四个 Feed 均 HTTP 200，分别返回 11、19、16、19 个条目。另行按推文 ID 核对原始 Feed，剩余 4 篇 ID 完全未出现，排除 URL 别名/匹配错误；不推断是帖子删除还是上游时间线窗口变化。
- 最终 4/8 为 `feed_body`，正文中的两张图片代理均通过；4/8 为 `feed_summary`，固定诊断从 `feed/network` 变为 `feed/feed_entry_missing`。X 原页仍 robots 禁止，不绕过访问策略或增加历史补抓。
- 这是 RSSHub 实际提供正文的验证，不宣称已读取 X 原页或独立核对其全文完整性。没有 UI/渲染代码修改，不重复构建、模型调用或全站审计。
- 只保留元数据报告：`/tmp/reading-hub-rsshub-recovery.json`、`/tmp/reading-hub-rsshub-feed-check.json`，未持久化正文或修改用户 SQLite。
- 服务保持运行；Reading Hub 无需重启，重新打开文章即可再次获取 Feed。Docker Desktop 需保持运行；未擅自改变系统登录启动设置。
- 本轮仓库仅追加本记录，文档 `git diff --check` 通过。
