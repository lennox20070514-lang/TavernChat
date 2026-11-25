# TavernChat 安卓 GitHub Releases 自动发版与镜像更新指南

TavernChat 已内置**版本检测 + 弹窗引导更新 + 镜像站优先加速**机制。以后发新版安卓客户端时，只需推送标签或在 GitHub Actions 点一次运行，所有已安装用户的手机启动后会自动弹窗引导覆盖安装，**本地角色卡、世界书与聊天记录全部保留**。

## 1. 客户端内置的更新原理

1. 每次构建安卓包时，`apps/web/rspack.config.ts` 会把当前版本 `__APP_VERSION__`、`__ANDROID_VERSION_CODE__` 以及默认 GitHub Release 清单地址 `latest.json` 编译进客户端。
2. 安卓端启动 2.5 秒后（每 12 小时最多自动检查一次），`apps/web/src/services/updater.ts` 通过原生 `CapacitorHttp` 静默读取更新清单 `latest.json`（无 WebView 跨域限制）。
3. 发现新版本号或更高的 `androidVersionCode` 时，自动弹出 `UpdatePromptModal` 更新提示窗，展示更新日志与下载按钮。
4. 用户点击 **设置 → 通用偏好 → 版本更新与镜像加速** 也可以随时查看当前版本号、修改 `latest.json` / 国内镜像加速地址，或手动点「立即检查更新」。

## 2. 一次性配置签名密钥（重要，保证后续升级可直接覆盖安装）

Android 要求新旧 APK 必须使用**同一把签名密钥**，才能在不卸载旧版（不丢失本地数据）的情况下直接覆盖升级。

1. 本地生成一次密钥库：
   ```bash
   keytool -genkeypair -v -keystore tavern-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias tavernchat
   ```
2. 把 `.jks` 转为 Base64（不要把 `.jks` 提交进 Git 仓库）：
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("tavern-release.jks")) | Set-Clipboard
   ```
3. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Secrets** 添加以下 4 项：
   - `ANDROID_KEYSTORE_BASE64`: 上一步复制的 Base64 内容
   - `ANDROID_KEYSTORE_PASSWORD`: 密钥库密码
   - `ANDROID_KEY_ALIAS`: `tavernchat`
   - `ANDROID_KEY_PASSWORD`: key 密码

（如果尚未配置签名 Secrets，工作流也会自动回退输出 debug 测试包以便先跑通流程；正式对外分发前务必配置签名。）

## 3. 日常发布新版本

方式一（推荐）：更新 `package.json` 版本号并打标签推送：

```bash
git tag v0.1.1
git push origin main --tags
```

GitHub Actions（[`.github/workflows/release-android.yml`](../.github/workflows/release-android.yml)）会自动完成：
1. 运行测试与类型检查
2. 构建新版 Web 并打包签名 APK（`TavernChat-v0.1.1-android.apk`）
3. 生成版本描述文件 `latest.json`
4. 创建 GitHub Release 并同时上传 `.apk` 和 `latest.json`

方式二：直接在 GitHub 网页端进入 **Actions → Release Android APK → Run workflow**，手动输入版本号与更新说明即可。

## 4. 国内网络镜像加速方案（任选其一）

为了解决国内用户直接访问 `github.com` 下载 APK 较慢的问题，支持三种无痛接法：

1. **GitHub 仓库变量自动注入下载加速前缀（最省事）**  
   在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 新增：
   - `TAVERN_UPDATE_MIRROR_PREFIX`: 填入你的加速反代前缀（例如自建 Cloudflare Workers 反代前缀 `https://gh.yourdomain.com/`）。
   构建出的 `latest.json` 会自动同时包含 `apkUrl`（原链）与 `mirrorApkUrl`（加速链），客户端弹窗会优先展示「镜像高速下载 APK」。
2. **托管一份镜像站 `latest.json` + `.apk`（最稳定，如 Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / Gitee Releases）**  
   每次发版后将 Release 的 `TavernChat-v*.apk` 和改好 `apkUrl` 的 `latest.json` 同步到镜像桶；同时可在 Actions Variables 设置：
   - `TAVERN_UPDATE_MIRROR_URL`: `https://你的镜像域名/tavernchat/latest.json`（构建时内置进 App 默认配置），或在 `MIRROR_SYNC_WEBHOOK` 配置自动触发镜像同步的 Webhook。
3. **用户端临时填写**：客户端「设置 → 通用偏好 → 国内镜像地址或加速前缀」也允许用户自行粘贴镜像站 `latest.json` 或加速前缀。
