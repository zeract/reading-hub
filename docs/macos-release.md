# macOS 可分发 DMG 发布与无损升级

Reading Hub 的应用包和用户资料是分开的。DMG / `Reading Hub.app` 只包含程序；来源、卡片、已读/收藏状态、同步进度和本地改写保存在当前 macOS 用户目录，不会因为用新 DMG 覆盖 `/Applications/Reading Hub.app` 而被删除。

当前正式数据目录是：

```text
~/Library/Application Support/reading-hub/
```

其中的主数据库为 `reading-hub.sqlite`。不要把此目录放入 Git、DMG 或发布附件，也不要在升级过程中删除它。macOS Keychain 中的授权凭据不在这个目录内，也不应手动导出、复制或上传。

## 先区分：本地开发验证与可分发版本

| 目的 | 使用方式 | 是否产生可交付 DMG |
| --- | --- | --- |
| 日常开发、界面调试 | `npm run dev` | 否 |
| 编译/离线回归 | `npm run build`、`npm run verify` | 否 |
| 本机安装和调试 | `npm run dist` | 是，但无签名时仅位于 `release/local/`，不可分发 |
| 给其他人安装或测试升级 | `npm run dist:release` | 是，位于 `release/`，必须完成签名和公证 |

`npm run dev` 会启动真实应用，默认会使用当前 macOS 用户的正式资料目录；它不是隔离沙盒。调试不受信任的改动时，请使用单独的 macOS 测试账户，或先完整退出应用并在 Finder 中备份 `~/Library/Application Support/reading-hub/`。

`npm run dist` 会自动选择安全路径：只有同时检测到 **Developer ID Application** 身份和完整 Apple 公证凭证时，才构建签名并公证的正式 DMG；否则会明确提示并在 `release/local/<时间戳>/` 生成带 `-local-unsigned.dmg` 后缀、卷名为 “Reading Hub (Local Unsigned)” 的本机测试包。该路径显式关闭签名身份发现、代码签名和公证，即使机器后来安装了证书也不会产生状态不明的半签名包。

本机测试包可由构建者在自己的 Mac 上检查安装流程，但不能上传、分享、用于覆盖升级，或宣称能通过 Gatekeeper。macOS 可能拒绝打开未签名 App；这不是应用损坏，正式分发必须改用 `npm run dist:release`。`npm run verify:macos-release` 始终只验证正式签名发布物，不会把 `release/local/` 中的测试包当成合格产物。

## 直接生成本机测试 DMG

尚未申请证书时，可以直接运行：

```sh
npm run dist
```

构建完成后终端会输出本次唯一的 `release/local/<时间戳>/` 路径。只在本机构建目录中使用该 DMG；不要移除 macOS 安全隔离属性、不要使用它测试对外升级、也不要发送给其他人。

## 一次性正式发布准备

1. 加入 Apple Developer Program，并在 Apple Developer 后台创建并导入 **Developer ID Application** 证书到此 Mac 的登录钥匙串。下面命令应能列出该身份：

   ```sh
   security find-identity -v -p codesigning
   ```

2. 使用 Apple 的 `notarytool` 将公证凭证保存到钥匙串。推荐此方式，密码不会写入仓库、环境文件或构建日志：

   ```sh
   xcrun notarytool store-credentials "reading-hub-notary" \
     --apple-id "你的 Apple ID" \
     --team-id "你的 Team ID" \
     --password "Apple ID 的 app-specific password"
   ```

   该命令会先校验凭证。App-specific password 在 Apple ID 安全设置中创建，不能使用 Apple ID 登录密码。

3. 只在准备发布的终端设置钥匙串配置名：

   ```sh
   export APPLE_KEYCHAIN_PROFILE="reading-hub-notary"
   ```

   CI 也可使用 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，或通过受保护密钥管理提供 `CSC_LINK` 的 `.p12` 证书。不要提交 `.p12`、`.p8`、密码、Cookie 或环境文件。

## 生成新的可升级 DMG

发布前先确认版本号已经按发布流程更新，并从干净、已验证的工作树构建。至少执行：

```sh
npm ci
npm run verify
export APPLE_KEYCHAIN_PROFILE="reading-hub-notary"
npm run dist:release
npm run verify:macos-release
```

`npm run dist:release` 会依次执行构建、Developer ID 签名、hardened runtime、公证、staple 以及签名、Gatekeeper、staple 和 DMG 完整性校验。公证通常需要数分钟；任何步骤失败时都不要发布 `release/` 中的新文件。

只发布本次构建产生的 `release/*.dmg`，不要发布旧的 `dist/*.dmg`。DMG 必须在目标架构的 macOS 上实际安装、启动一次后再对外发送；当前构建配置按构建机器的架构产出，若要覆盖 Apple Silicon 与 Intel 用户，应分别在对应架构上构建和验收，或在发布流程中显式配置并验证通用包。

## 用户如何从旧版升级

1. 在旧版中通过菜单栏的“退出”完全退出 Reading Hub；不要让旧版和新版同时运行。
2. 打开新 DMG，将 **Reading Hub.app** 拖到 `/Applications`，并在 Finder 询问时选择“替换”。这只替换应用包，不会替换用户资料目录。
3. 从 `/Applications` 启动新版。首次启动会在服务、同步和历史维护开始前检查数据位置。
4. 确认来源数量、最近卡片、已读状态、收藏和改写仍然存在，再删除已挂载的 DMG。不要通过重新订阅来“补回”似乎缺失的资料。

常规覆盖升级始终使用当前目录 `~/Library/Application Support/reading-hub/`，现有 SQLite schema 会在启动时按版本迁移。升级后的数据库可能不再能由不支持该 schema 的旧版本打开，因此不要在同一份资料上来回启动新旧版本。

## 历史目录接管与安全恢复

少数历史版本可能将库放在以下位置：

```text
~/Library/Application Support/Reading Hub/
~/Library/Application Support/Electron/
```

新版只会检查这两个已知历史目录和当前 `reading-hub` 目录；即使目录名为 `Electron`，也只接受其中名为 `reading-hub.sqlite`、且能通过 Reading Hub schema 与完整性验证的库，绝不会扫描或导入其他 Electron 应用的数据。启动时的规则如下：

- 当前库不存在或没有任何用户资料状态，且历史目录中存在一份可验证的 Reading Hub 库：应用会先创建 SQLite 一致性备份到 `~/Library/Application Support/reading-hub/backups/`，再在临时副本上验证并原子接管。SQLite 使用 WAL，因此不会用 Finder 或普通文件复制主数据库来替代该过程；关注作者、已隐藏内容、分类和改写设置也属于用户状态，不会被当作可丢弃的空库。
- 若旧版在一致性快照或临时迁移期间仍写入历史库：来源指纹校验会停止接管，而不是把过期快照当作成功迁移；两份库和已创建的备份都会保留。仍应在升级前完全退出旧版，避免产生需要人工选择的两份资料库。
- 当前库与历史库都含有资料、历史库损坏、历史库版本高于新版支持范围，或验证/接管失败：应用不会覆盖、合并或删除任一份数据，而是停止启动并显示恢复提示。这样不会把“两个库都存在”误判成可安全合并的情况。
- 原历史目录始终保留；接管记录只包含路径、阶段、时间、计数和哈希，不包含文章正文、Cookie、Token 或 Keychain 内容。新库同时保存与该记录对应的迁移来源标记；两者与保留的历史库一致时才会把它识别为已接管的副本。
- 历史目录中的 Chromium 专属登录会话不会复制；若曾在旧品牌版本连接知乎，首次启动新版后可能需要重新登录。这不会影响来源、卡片、已读/收藏或改写的资料库接管。

如果升级后看到空资料库或恢复提示，请立即退出应用，不要再次同步或删除任一目录。保留以下目录中实际存在的目录，并在反馈中附上恢复提示文本（不要附数据库、文章内容、Cookie 或密钥）：

```text
~/Library/Application Support/reading-hub/
~/Library/Application Support/Reading Hub/
~/Library/Application Support/Electron/
```

若要在升级前做人工保险备份，先完全退出应用，然后在 Finder 中选择“前往 → 前往文件夹…”，输入 `~/Library/Application Support/`，将整个 `reading-hub` 文件夹复制到一个受保护的位置。需要保留历史版本时，也一并复制存在的 `Reading Hub` 或 `Electron` 文件夹。不要只复制 `reading-hub.sqlite`，也不要在应用运行时手动移动或覆盖数据库文件。

## 发布前的升级验收

每次对外发布前，除 `npm run verify` 与 `npm run verify:macos-release` 外，至少在一个测试账户执行一次真实覆盖升级：

1. 用旧版创建或准备带来源、已读、收藏和至少一篇改写的测试库。
2. 完全退出旧版，按上述步骤用新 DMG 替换 `/Applications/Reading Hub.app`。
3. 启动新版，核对资料和来源健康状态；确认没有出现重复导入、空库或意外同步。
4. 对历史目录场景使用离线 fixture 验证：仅历史库、双非空库、损坏库、较新 schema 以及 WAL 数据都必须得到预期的接管或安全阻止结果。

应用包的签名/公证与数据迁移是两套独立的门禁：签名确保安装包可信，迁移确保旧资料不被覆盖或遗失。两者都通过后，才应向用户发布新的 DMG。
