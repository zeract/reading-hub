# 任务：阅读器过滤页面属性面板

状态：实现

## 目标与范围

- 用户可观察的预期行为：Recsys Frontier 等公开文章在内置阅读器中只显示作者正文；`type / status / date / slug / summary` 等 CMS 页面属性不能被拆成逐行正文。
- 不包含：不加载或执行原站 CSS/JavaScript；不按域名硬编码；不改动已收集卡片、同步规则或历史数据。
- 已确认的决策、授权及限制：保留作者明确写入正文的表格和键值信息；只移除具备结构证据的、位于正文开始前的页面属性面板。公开页面检查只读，不保存全文。

## 根因与契约

- 已验证证据（文件/测试/样本，不存私密正文）：`https://blog.recsys-frontier.com/article/rec-tech-taste` 的 `article#article-wrapper` 包含 `.notion-collection-page-properties`。其中有 10 个 `.notion-collection-row-property`，以 label/value 的形式保存 `type`、`status`、日期、slug 和摘要；其后才是 `.notion-text` 正文块。原站外部 CSS 还显式隐藏 `.notion-collection-row`；阅读器正确地不加载外部 CSS，且随后去除远端 class，故这些嵌套 `div` 回退为逐行块。`normalizeKeyValueGrids` 只转换有明确两列 CSS 和 `strong` 标签的作者表格，不适用于该 CMS 属性面板。
- 待验证假设：无。
- 受影响的数据归属、接口、失败/恢复规则：只影响打开文章时的内存中净化 DOM；不持久化原文、不变更数据库。无法满足页面属性结构证据的内容保持原样。
- 持久化或协议变更的兼容与回退方式：不适用。
- 长期设计文档链接：不适用。

## 实施与验收

| 预期行为 | 实现/回归入口 | 验收方法 | 结果及证据 |
| --- | --- | --- | --- |
| 结构化页面属性不进入正文 | `reader-extraction` 定义的共享净化边界与 `test/article-reader.test.ts` | 确定性 Notion/CMS 夹具 | 通过；不保留 type/status/slug/summary 的键和值 |
| 正文首段、普通表格和安全净化仍保留 | `test/article-reader.test.ts` 及既有阅读器回归 | 定向单元测试 | 通过；作者定义的两列键值网格仍转换为语义表格 |
| 真实公开文章不再泄漏属性字段 | Recsys Frontier 只读页面重放 | 应用提取路径的结构断言 | 通过；正文从第一段开始，属性字段均为 false，空白 Notion 社交封面不再作为封面显示 |

验证范围：core；不需要真实模型或发布检查。共享正文净化路径会运行 `npm run audit:reader`；若没有 CSS 修改，不额外运行视觉样式审计。

## 当前进度与交付

- 已完成：在正文选择前和最终净化阶段，依据“属性/元数据面板 + 两条以上带标签和值的属性行 + 正文前导位置”移除 CMS 页面属性；补充空白 Notion 社交封面排除和确定性回归。
- 验证：`npm test -- test/article-reader.test.ts test/reader-document-base.test.ts test/reader-key-values.test.ts`（114 项）、`npm run build`、`npm run verify`（206 文件 / 2147 项）均通过。真实 Recsys 页面经构建后的实际提取路径只读重放，正文长度为 4087，六个属性泄漏断言均为 false。
- 在线审计限制：已启动 `npm run audit:reader` 的 88 个本机来源审计；执行环境在输出第 8 个样本后丢失审计会话，无法取得全量完成状态，故不将其标为通过。相关真实来源的定向只读重放已完成，不保存正文或凭证。
- 历史数据处理：不需要迁移或回填；下一次打开该文章即使用新净化路径。
- 是否需要重启、迁移；提交与交付版本：开发服务会热更新；若当前文章已打开，重新打开该文章即可。无数据库迁移。
- 阻塞：无。
- 阶段耗时及等待原因：2026-09-19；约 30 分钟用于本地调用路径、受控公开页面结构核对、构建与完整确定性验证。全量在线审计在第 8/88 个样本后丢失工具会话，未重复请求相同来源。
