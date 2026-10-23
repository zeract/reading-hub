# 任务：精简结构化文档与旧改写兼容边界

状态：完成（在线验收存在明确限制）

## 目标与范围

- 普通读取直接使用文档树；Markdown 仅为显式导出与旧稿兼容。
- 集中选择改写协议，保留匹配的旧检查点；移除已退出界面的模型检查入口。
- 分离公式处理职责，共享执行策略；统一阅读版本切换时的临时状态清理。
- 不改变提示内容、增加模型调用或重新生成用户旧稿。

## 根因与契约

- `decodeRewriteResult` 每次读取树时强制导出 Markdown，经 HTML 回到旧提取流程。
- 协议选择散落在队列服务与生成器；review IPC 无界面调用但仍可排队。
- 同步/异步公式执行有重复；生产依赖异步 MathJax，同步兼容不能假装等同生产。
- 历史 Markdown/迁移备份不丢失；已停用 review 任务取消且保留结果；生成任务不自动重跑。
- 当前设计：[architecture.md](../architecture.md)。

## 实施与验收

| 预期行为 | 回归入口 | 验收 | 结果 |
| --- | --- | --- | --- |
| 文档树读取无需 Markdown，导出保留资产/列表/表格 | article-document / rewrite storage | 确定性 | 通过；完整 206 文件 / 2121 测试 |
| 旧检查点复用及队列退出恢复 | rewrite-service / rewrite-store | 确定性 | 通过；完整 206 文件 / 2121 测试 |
| 停用模型检查不可从 IPC 调用 | ipc-rewrite | 确定性 | 通过；完整 206 文件 / 2121 测试 |
| 公式识别、宏状态、编号及回退不变 | reader math regressions | 确定性及在线 | 本地通过；在线 87/102 通过，限制见下 |
| 版本切换清理选区/预览/AI | reader lifecycle | React / Electron | 生命周期测试、renderer smoke 与 visual 通过 |

验证范围：core；执行 style、visual、reader。此次无提示语义变更，不调用真实模型。

## 当前进度与交付

- 历史数据：仅实现兼容读取及停用任务恢复；不覆盖用户文章。
- 调查与实现开始时间见本次工具时间戳；后续记录各门禁耗时。

- 2026-10-23 21:52:50–22:00:15（Asia/Shanghai）：实现与针对性回归；9 文件 114 测试通过，后续 AI 服务/导出 31 测试通过。移除 review 模型分支，保留历史结果类型。构建通过。
- 最终验证开始：core + visual + reader；共享公式提取仅移动职责并合并主渲染决策，无站点规则变化。

### 最终证据与限制

- `npm run verify -- --visual --reader`：本地 diff、workflow、206 文件 / 2121 测试、build、style 通过。visual 在沙盒启动即 SIGABRT，故组合命令状态为 failed，reader 尚未运行；不将该报告改写为全通过。
- 同一构建通过获准的原生启动补验：`READING_HUB_VISUAL_OUTPUT=/tmp/reading-hub-refactor-visual node node_modules/electron/cli.js scripts/visual-audit-app`，四档布局、125% 字号、图片/代码/表格/侧栏/全屏状态及三档原生 SVG 公式、碰撞负对照通过。检查了默认、窄屏、大字号截图。
- `node node_modules/electron/cli.js scripts/renderer-smoke-app`：真实 React/preload/内存数据库交互通过，包括版本替换、公式/链接/代理图片、AI 关闭取消、迟到响应和窗口交互；预期合成失败日志不等于检查失败。
- `READING_HUB_READER_AUDIT=1 node node_modules/electron/cli.js .`：102 篇最新/历史样本，87 passed、9 issues（8 篇 Twitter 与 1 篇科学空间只取得摘要）、2 failed（Aleksa Gordić 历史页 HTTP 403，Shengyu Feng 历史页 HTTP 404）、4 skipped（知乎 2 篇无独立审计登录态，Yanyan Jiang 论文 2 篇无法确认 robots）。只覆盖审计已有的资源检查范围，首图检查不证明全部媒体可用。
- 不重试无新证据的远端错误，不绕过登录/robots，也不将摘要视作全文。未发现本次修改导致的本地或 Electron 回归；受限原文不声称通过。
- 未运行真实模型、发布签名/安装包验证；生成提示内容不变，没有重新生成或替换本地用户稿件。
- 历史数据契约：临时测试数据库验证旧稿逐字保留、单份备份、级联删除、旧检查点续跑；历史 review 队列在下次启动取消且保留结果/恢复记录。没有直接写入用户数据库。
- 本地组合验证报告源指纹：`88a541c8c6332e800bc46c139e85ed236f61911664b6a209d2009e08a7d11408`，基于 `4b13e48` 加本任务变更；其后只有注释归位与交付文档收尾，无运行逻辑变更。原始报告和审计日志保留在 `/tmp/reading-hub-refactor-*`，不提交用户审计数据。
- 时间戳（Asia/Shanghai）：实现及定向检查记录区间 21:52:50–22:00:15；完整本地门禁 22:00:15–22:00:35，其中测试 13.86 秒、构建 3.72 秒；原生 visual 22:00:57–22:00:59，renderer 22:01:25–22:01:48；在线 22:01:58–22:07:19，共 321 秒。主要等待为原站与图片网络访问，未重复执行已通过的完整测试。
- 主进程/IPC 有变更，需要重启开发进程后生效。提交包含本任务源码、回归与设计记录，不包含数据库、报告全文或构建产物。
