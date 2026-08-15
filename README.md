# Reading Hub

本地优先的 macOS 多源阅读器 MVP。它聚合 RSS、Atom、JSON Feed、公开网页结构化内容，以及用户主动粘贴的小红书分享链接；内容以摘要卡片展示，始终跳回原站阅读。

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

- 知乎关注动态使用用户在 Reading Hub 内主动完成的独立登录会话，读取“关注”页中可见的公开卡片；不会读取或迁移 Chrome Cookie，不会保存密码，也不绕过验证码。删除该来源会清除本机会话。
- 小红书只接收用户粘贴的分享链接，作为一次性阅读卡片；不会登录、保存 Cookie、轮询博主或绕过访问控制。
- 通用网页只访问公开 HTTP/HTTPS 地址，阻止 localhost/私有地址，遵守 robots 规则并对同域名串行限速。
- 无 Feed 的公开网页会自动识别内容列表；需要复核时，只需在“自动校准”中选择正确的文章卡片组，无需编写 CSS 选择器。
- X 使用官方 API 的 OAuth 2.0 PKCE 授权。请先在 X Developer Console 配置回调地址 `http://127.0.0.1:43119/x/callback`，然后在应用中输入 Client ID；访问与刷新令牌只保存在 macOS Keychain。默认收集所关注账号的原创帖与文章型外链，不读取浏览器 Cookie。
- “学术作者更新”聚合 OpenAlex、Semantic Scholar 及可公开读取的 ORCID works，并在卡片中保留实际数据来源；它不是 Google Scholar 登录态、页面或邮件的同步。

## 内置阅读器 AI 学习

在任一文章阅读页点击“AI 学习”，选择 OpenAI API、DeepSeek 或“本机 Codex CLI”，即可针对当前文章提问。OpenAI 与 DeepSeek 的 Key 和模型设置仅保存到 macOS Keychain；问题、回答和正文不会写入 SQLite。

- OpenAI 使用 Responses API 与可配置模型（默认 `gpt-5.6`），请求设置 `store: false`。
- DeepSeek 使用 Chat Completions API，默认模型为 `deepseek-v4-flash`，也可按账户可用模型调整。
- 本机 Codex CLI 不读取、复制或存储 Codex 的登录凭证。它会调用已登录 CLI 的 `codex exec --ephemeral --sandbox read-only`，通过标准输入传入同样受限的文章摘录，并仅读取最终回答。可在“设置”中从下拉菜单选择跟随 CLI 默认模型或 `gpt-5.3-codex`，并选择 `low`、`medium`、`high`、`xhigh` 推理强度；模型与强度偏好保存在 macOS Keychain，不进入 SQLite。首次使用前请在终端执行 `codex`，用 ChatGPT 账户完成登录；CLI 未安装或未登录时会明确提示。
- 为控制发送范围，每次提问只会发送当前文章提取后的前 18,000 个字符、标题、来源和链接；AI 面板关闭后，对话仅留在当前界面内存中。

## 质量检查

```bash
npm test             # 离线夹具、数据库迁移、连接器与阅读提取
npm run audit:style  # CSS 结构与阅读器约束
npm run audit:visual # Electron 实际布局：公式编号、图片和溢出
npm run audit:reader # 只读审计已保存来源的最新与一篇历史文章
```

`audit:reader` 会访问当前本机数据库中的公开来源，遵守 robots，不保存正文或凭证。`audit:visual` 可设置 `READING_HUB_VISUAL_OUTPUT=/tmp/reading-hub-visual` 输出三个视口的诊断截图。

如需针对单个来源排查，可在本机执行：

```bash
READING_HUB_AUDIT_SOURCE='科学空间|Scientific Spaces' npm run audit:reader
```

## 连接器扩展

所有连接器均由编译内置的注册表加载。调度、robots、限流、数据库、Keychain、阅读渲染和 IPC 始终由宿主控制；当前版本不加载第三方插件代码。新的内置连接器实现 `ConnectorAdapter`，并提供 manifest、同步、规范化和离线夹具测试。
