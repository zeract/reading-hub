# 任务：将阅读请求取消建模为正常 IPC 结果

状态：完成

## 目标与范围

- 用户可观察的预期行为：在开发热更新、切换文章、关闭阅读器或 React StrictMode 清理时，正在进行的正文/语言版本读取会被取消，但 Electron 终端不再把这种预期取消打印成 `entry:read-content` 错误；真实网络、提取、robots 和数据库错误仍正常显示。
- 不包含：关闭取消机制、吞掉其他 IPC 通道的错误，或改变同步、数据库和正文提取的失败语义。
- 已确认的决策、授权及限制：用户已要求优化；仅为正文读取与语言版本读取建立显式 `cancelled` 结果。窗口级取消仍会中止底层网络工作和等待其安全收束。

## 根因与契约

- 已验证证据（文件/测试/样本，不存私密正文）：`scripts/dev.mjs` 在主进程输出变化后重启 Electron；`use-reader-request.ts` 在卸载/替换时发出 `cancelEntryRead`；`WindowRequestScope` 使 `entry:read-content` 的 Promise reject，Electron 因而记录该 rejection。React StrictMode 在开发环境额外执行一次清理。此前临时 TS6133 已在 watch 输出中恢复为 0 errors。
- 待验证假设：无。
- 受影响的数据归属、接口、失败/恢复规则：正文与语言版本读取均返回受限的瞬态结果。只有来自窗口请求生命周期的明确取消转换为 `{ kind: "cancelled" }`；超时、提取、robots 和其他错误继续 reject。取消不能标记文章已读、不能打开 robots 原文窗口、不能产生错误提示。
- 持久化或协议变更的兼容与回退方式（不适用可删除）：无持久化变更；preload、共享 `ReaderApi` 和渲染端在同一版本更新，旧开发构建不与新主进程混用。
- 长期设计文档链接：`src/main/window-request-scope.ts`、`src/shared/ipc.ts`。

## 实施与验收

| 预期行为 | 实现/回归入口 | 验收方法 | 结果及证据 |
| --- | --- | --- | --- |
| 显式取消正文读取时，底层请求仍中止且 IPC 成功返回 cancelled | `test/ipc-reader-lifetime.test.ts` | 确定性 IPC/HTTP 夹具 | 通过：显式取消、关闭窗口、应用关闭和晚到结果均返回 cancelled，且 robots 回退不打开。 |
| 语言版本读取具有相同取消语义 | `test/ipc-reader-lifetime.test.ts` | 确定性 IPC 夹具 | 通过：语言读取包装为 article/cancelled 的判别联合。 |
| cancelled 不显示错误、不标记已读、不覆盖替换后的文章 | `test/reader-lifecycle.test.tsx` | jsdom React 生命周期回归 | 通过：正文与语言切换的 current cancelled 结果不显示失败状态、不打开受限页、不写已读。 |
| 普通提取失败仍作为错误 reject | `test/ipc-reader-lifetime.test.ts` | 确定性 IPC 夹具 | 通过：普通 Error 与未被窗口生命周期取消的 `RequestAbortedError` 仍 reject。 |

验证范围：core；不涉及视觉、在线、真实模型或发布检查。运行相关单元/集成测试、`npm run build`、`git diff --check`。

## 当前进度与交付

- 已完成 / 下一步 / 阻塞：已完成类型化窗口取消、正文/语言 IPC 结果和渲染端静默处理；无阻塞。
- 验证报告的 commit、sourceHash 或 CI 链接：2026-09-19 本地 `npm run verify` 通过（206 files / 2153 tests），定向生命周期测试 58 项通过，`npm run build` 通过。
- 未通过或未运行项及实际影响：未运行真实在线阅读器审计和视觉审计：本次只改变 IPC 取消结果，不改变正文、HTML、样式或布局；确定性 React/IPC 回归已覆盖受影响边界。
- 历史数据处理结果（与新流程分别验收）：不适用，无数据库或历史内容变更。
- 是否需要重启、迁移；提交与交付版本：重新启动正在运行的 `npm run dev`（或等待其主进程自动重启）以载入新主进程；不需要迁移。
- 阶段耗时及等待原因（实际时间戳；无记录就说明）：2026-09-19 15:12–15:20 调查；15:20–16:48 实现、并行测试与审查；16:48–16:51 全量验证。
