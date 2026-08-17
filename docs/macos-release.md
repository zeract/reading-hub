# macOS 可分发 DMG 发布

`npm run dist` 只用于公开分发。它要求 Developer ID 签名和 Apple 公证均已配置；缺少任一项会在构建前失败，避免再生成会被 Gatekeeper 标记为“已损坏”的 DMG。产物位于 `release/`，不要发布旧的 `dist/*.dmg`。

## 一次性准备

1. 加入 Apple Developer Program，并在 Apple Developer 后台创建并导入 **Developer ID Application** 证书到此 Mac 的登录钥匙串。用下面命令应能看到它：

   ```sh
   security find-identity -v -p codesigning
   ```

2. 使用 Apple 的 `notarytool` 将公证凭证保存到钥匙串（推荐，密码不会写入仓库、环境文件或构建日志）：

   ```sh
   xcrun notarytool store-credentials "reading-hub-notary" \
     --apple-id "你的 Apple ID" \
     --team-id "你的 Team ID" \
     --password "Apple ID 的 app-specific password"
   ```

   该命令会先校验凭证。App-specific password 在 Apple ID 安全设置中创建，不能使用 Apple ID 登录密码。

3. 在当前终端仅设置钥匙串配置名：

   ```sh
   export APPLE_KEYCHAIN_PROFILE="reading-hub-notary"
   ```

   CI 可改用 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，或在受保护密钥管理中提供 `CSC_LINK` 的 `.p12` 证书。不要提交 `.p12`、`.p8`、密码或环境文件。

## 构建与验收

```sh
npm run dist
```

流程依次执行：构建、Developer ID 签名、hardened runtime、公证、staple，以及 `codesign`、`spctl`、`stapler` 和 DMG 完整性验证。公证通常需要数分钟，失败时不要发布任何新产物。

如只想重新验证已有的 `release/` 产物：

```sh
npm run verify:macos-release
```

签名和公证完成前，开发请使用 `npm run dev` 或 `npm run build`；它们不会产生可分发安装包。
