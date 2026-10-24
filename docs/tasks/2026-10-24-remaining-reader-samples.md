# 在线抽检剩余 12 个样本归因与修复

状态：完成，2026-10-24 12:43 开始，12:55 完成验收。

## 目标与范围

核对上一轮 102 个样本中未通过或未验证的原始 12 项，不替换样本。区分外部访问限制、旧数据未保存、授权会话缺失和可复现的软件缺陷；软件问题沿共享读取/媒体/审计路径修复。保留公共地址、robots、HTTP、登录与本地数据边界，不为恢复历史内容绕过访问控制。

## 根因与契约

- 原报告 `/tmp/source-timeout-check/reader.json`；本次元数据和诊断证据暂存 `/tmp/remaining-reader-check/`，不提交正文或用户库。
- 初查 12 项：Visualinux HTTP 403、Figshare no_content、Shengyu HTTP 404；四条 Twitter 和一条科学空间为摘要降级/条目不在 Feed；两条 Stephanie 首图 404；两条知乎未提供授权会话。
- 已查用户库：五条摘要降级均没有本地正文或图片；两条知乎也没有本地正文。Stephanie 仅存 Feed 节选，无图片。以上不能仅凭在线抽检判断本地优先读取有故障。
- 待验证：图片 404 是原始地址失效还是地址解析问题；Figshare 是否有可读正文；404 文章是否存在明确迁移证据；生产授权会话能否验证知乎；审计是否准确区分在线与本地覆盖。

## 实施与验收

优先使用生产 `PublicHttpClient` / `ArticleReader` / `ArticleLibrary` 及只读快照做有限复检；用确定性案例证实通用根因后修改。代码变更执行相关测试、构建、diff 检查；共享正文/媒体管线变更执行全来源最新/历史审计。仅审计分类或局部影响可限定时，验收原 12 项及邻近确定性边界，不默认扩大模型或全窗口视觉检查。

## 当前进度与交付

## 已核对的 12 项（12:44–12:46）

| 样本 | 实际证据及分类 | 处理 |
| --- | --- | --- |
| Visualinux | 静态及渲染仍 HTTP 403；无本地正文。外部拒绝 | 保留拒绝，不读取错误页 |
| Figshare 附件 | DOI 目标及其 robots 返回 HTTP 202、`x-amzn-waf-action: challenge`；AWS WAF 验证页。外部验证限制，叠加软件误诊 | 修复下述共享协议；不能证明附件本身没有正文 |
| Twitter Charlie O'Neill 历史项 | 原页 robots 禁止，当前 Feed 没有条目，SQLite 无正文 | 历史未保存，现无法自动补回 |
| 科学空间历史项 | 原页 HTTP 403，当前 Feed 没有条目，SQLite 无正文 | 同上，额外有外部拒绝 |
| Twitter 向阳乔木历史项 | robots 禁止、Feed 移除、无本地正文 | 历史未保存，现无法自动补回 |
| 知乎 OpenAI 会议室回答 | 应用原有授权分区读取目标回答成功，正文 675 字符、4 张图、首图代理成功 | 原先只是审计会话未注入；现已验证，无需登录或复制 Cookie |
| 知乎 DeepSeek 团队回答 | 同一授权路径成功，536 字符、无图 | 同上 |
| Stephanie Software factories | 正文可读，原 HTML 无正文图片；OG 元数据指向 `/og/default.png`，原地址 HTTP 404 | 外部分享封面失效，不删除失败图片伪造通过 |
| Stephanie Evals | 同上；两项仅存 Feed 节选，没有本地图片 | 同上；不能以 Feed 节选声称已离线保存全文 |
| Shengyu Beyond Rl | 旧 URL HTTP 404；当前首页声明的是两个不同日期/标题的 Beyond RL 文章，无同一文章重定向或身份映射 | 旧链接失效且无正文，不能靠标题相似猜测迁移地址 |
| Twitter Zartbot 历史项 | robots 禁止、Feed 移除、无本地正文 | 历史未保存，现无法自动补回 |
| Twitter Madison Kanna 历史项 | 同上 | 同上 |

## 通用缺陷与修正（12:46–12:50）

实际 Figshare 的 robots 与目标页均返回验证头。旧实现把 HTTP 202 验证页面当成成功 HTML；robots 将其解析为空规则，随后浏览器又尝试渲染验证页，最后误报 no_content。明确响应头证明这是访问验证，不是正文选择器失效。

新增共享的明确验证头判定，HTTP 页面、图片、robots 和隔离渲染共用；不使用域名或正文关键词。验证 robots 缓存为不可确认并保持 5 分钟退避；不以重连事件解除限制。正文读取停止浏览器回退，仍保留订阅正文/摘要。诊断只记录 `access_challenge`。原始 403、404、普通 202 及已取得的本地正文行为不改变。

依据 [AWS WAF 官方协议](https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge-actions.html) 和 [Cloudflare 官方协议](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)；只核实标记定义，不尝试通过或绕过验证。

定向测试已覆盖网关头、误报边界、robots 缓存/退避、静态拒绝不启动浏览器、订阅降级和主框架拦截；继续运行最终门禁及全来源审计。新流程与历史缺失分别报告，诊断脚本不修改用户原库；没有历史稿件生成、模型调用或 UI 变更。

## 验收与交付

- 原 12 个固定 ID 已经逐项生产路径复核，不以新样本替代。2 条知乎通过已有授权分区验证；5 条历史正文未保存且目前无法获取；其余 5 条分别是外部 403、验证页、两张失效分享封面、失效文章链接。Figshare 同时暴露了已修正的共用验证响应处理缺陷，不能简单将全部问题归为网络。
- 完整 `npm run verify -- --reader`：211 文件、2193 项测试，工作流、构建、style、diff 均通过。实现指纹 `513b812ca480c443b612abfce2fb25ba38c690e3b4c4c581e2ab05380a8de888`，检查期间源文件未变，之后只补充验收文档。没有改变字体、CSS 或正文布局，不运行额外窗口视觉审计。未调用模型，未修改历史正文或用户配置；授权会话核对不导出 Cookie、密码或令牌。
- 共享读取改变触发全来源复检：51 来源、102 样本，89 passed、7 issues、3 failed、3 skipped；未把执行退出码 0 当作全部样本通过。Figshare 的原 ID 现在只产生 `static/access_challenge`、明确 robots 验证提示，约 1.4 秒终止，不再渲染验证页或报告 no_content。Visualinux 当前也出现明确验证标记，保留 `access_challenge`。
- 扩展回归额外发现 Aleksa 的一篇历史文也返回明确验证标记；阻止其浏览器自动回退是同一访问边界修正的预期行为，不试图自动通过验证，该项不计通过。其本地库也没有已存正文。上述 89 个 passed 仍按现有审计范围解释：正文及首图抽样，一些样本附 robots 图片限制诊断，不代表全部媒体均可下载。
- 独立审计的两条知乎仍标记 skipped；前述授权会话实测是单独证据，不覆盖或篡改隔离环境的原始报告。全来源复检按当时最新/历史重新选样，不替代固定原 12 项核查。
- 阶段耗时：12:43–12:46 读取原报告、本地保存状态及有限在线对照；12:46–12:50 实现与定向测试；最终本地门禁约 20 秒、在线复检约 5 分钟，具体毫秒见 `.verification/latest.json`。等待主要是远端请求，无历史重写或模型等待。
- 证据：`/tmp/remaining-reader-check/probe.json`（固定 12 项）、`extra.log`（明确验证头）、`reader-after.json`（全来源）；一次性脚本、原始 HTML 和数据库副本已删除，报告不含验证响应正文。开发环境恢复后提交推送 main。
