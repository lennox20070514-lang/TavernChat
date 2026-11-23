# TavernChat 多端 Demo 交付与 iOS 网页/PWA 方案指南

本指南总结 TavernChat 的 **Windows 桌面端**、**Android APK** 以及 **iPhone / iPad Safari PWA（借鉴 DeepseekChat 极简网页方案）** 的落地方案与打包命令。

---

## 一、Windows 电脑端 Demo（Electron + 内嵌本地微网关）

- **形态特点**：双击即开，应用启动时自动在 `127.0.0.1` 随机空闲端口拉起超轻内嵌网关（[apps/server/src/gateway.ts](../apps/server/src/gateway.ts)），无须安装 Node.js 或命令行，零 CORS 限制直连 DeepSeek / OpenAI / Claude / Gemini / OpenRouter / 本地 Ollama。
- **打包命令**：
  ```sh
  corepack pnpm exe:build
  ```
- **产物位置**（`apps/desktop/release/`）：
  - `TavernChat-0.1.0-Portable-x64.exe`：绿色便携单文件版，直接双击运行
  - `TavernChat-0.1.0-Setup-x64.exe`：标准 Windows 安装版（含桌面与开始菜单快捷方式）
- **未来「电脑满血版 (PC Pro)」演进路径**：
  - 当前核心层已通过 [types.ts](../packages/tavern-core/src/types.ts) 预留 `StorageAdapter` 与 `EnginePlugin` 插槽；
  - 后续只需在 Electron 主进程挂载本机明文目录适配器（直读/同步酒馆目录）、本地向量 RAG 长期记忆与可选局域网网关开关，即可平滑升级满血版而**不改动现有极简前端**。

---

## 二、Android 端 Demo（Capacitor 原生 APK）

- **形态特点**：一套代码共用纯 TS 核心引擎 `@tavern-chat/core`，角色卡 PNG 编解码、世界书动态触发、Prompt 组装与上下文透视 **100% 离线在手机本地运行**；数据存在手机原生沙盒 IndexedDB，支持安卓硬件返回键逐层关闭弹窗/搜索/抽屉。
- **同步与编译命令**：
  ```sh
  corepack pnpm apk:debug
  ```
- **产物位置**：
  - `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`
  - 命令会自动归档一份便携副本至 `apps/web/release/TavernChat-0.1.0-android-debug.apk`

---

## 三、iOS 方案：借鉴 DeepseekChat 的纯网页 + Safari「添加到主屏幕」PWA

为了**零掉签风险、无需 \$99/年苹果开发者账号、无需折腾 TestFlight/企业签、直接给 iPhone / iPad 稳定使用**，TavernChat 完整复用了 DeepseekChat 验证成熟的 **HTTPS 静态网页 + Safari PWA 方案**，且所有底层适配已内置完成：

### 1. 已内置的 iOS / PWA 专属能力
1. **离线应用壳与防断流 Service Worker（[sw.js](../apps/web/public/sw.js) + [main.tsx](../apps/web/src/main.tsx)）**
   - 仅在 HTTPS 网页端注册（Android APK 与 Electron 自动跳过）；
   - `index.html` 采用**网络优先 + 离线回退**（发新版即刻生效，断网也能打开看历史与改角色卡），`/static/` 内容哈希资源长期缓存秒开；
   - 显式放行 `/api/` 与所有外部大模型 SSE 流式请求，绝不干扰打字机输出。
2. **原生级 iPhone 质感与持久化保护（[index.html](../apps/web/src/index.html) + [manifest.webmanifest](../apps/web/public/manifest.webmanifest)）**
   - 已配齐 180×180 `apple-touch-icon.png`、`icon-192.png`、`icon-512.png`、`display: standalone`、`viewport-fit=cover` 与动态深浅色 `theme-color`；
   - 移动端输入框自动 `16px` 字号，杜绝 iOS Safari 点击输入时画面自动缩放；
   - 启动自动请求 `navigator.storage?.persist?.()` 保护本地 IndexedDB（角色卡、世界卡、聊天记录）；
   - 检测到在 iPhone 微信/QQ 或普通 Safari 标签页打开时，在「设置 → 数据与导入」自动展示轻量「添加到主屏幕」指引（添加到桌面后自动消失）。
3. **iOS 专属文件导出与备份防丢（[fileSave.ts](../apps/web/src/utils/fileSave.ts)）**
   - 独立 PWA 下 `<a download>` 容易静默失效：导出 **酒馆 PNG 角色卡**、**世界书 JSON** 和 **全量备份 JSON** 时，在 iOS 上自动优先唤起**系统原生分享面板**，可直接「存储到文件」或 AirDrop 到电脑！
   - 自动记录最近备份时间，超过 7 天未备份时温和提醒留档。

### 2. iOS 网页端静态托管部署（0 服务器运维成本）
运行 `corepack pnpm build`，将 `apps/web/dist/` 上传到任意 HTTPS 静态托管即可（所有数据与密钥 100% 留在用户自己手机本地）：
- **国内微信/Safari 最稳**：轻量服务器 / 宝塔 Nginx（配 HTTPS，`index.html` 和 `sw.js` 设 `Cache-Control: no-cache`，`/static/` 设长期缓存）；
- **零成本免费托管**：Cloudflare Pages / Vercel / Netlify 直接拖入 `apps/web/dist/` 并绑定 HTTPS 域名。

### 3. TavernChat 在 iOS 上的独有进阶技巧：手机连电脑本地网关
- **常规使用**：直连支持浏览器 CORS 的官方或中转 API（DeepSeek / OpenRouter / SiliconFlow / 支持 CORS 的 OpenAI 中转等），完全免后端运行；
- **进阶玩法（解决无 CORS 私有中转或调用家里电脑的 Ollama）**：
  - 在「设置 → 通用偏好 → 自定义局域网本地网关」中填入同一 Wi-Fi 下电脑运行的 TavernChat 网关地址（如 `http://192.168.x.x:8797` 或通过 Tailscale/内网穿透的 HTTPS 地址），iPhone 就能借电脑本机网关无 CORS 调任意模型！

### 4. 三端能力速览对比

| 能力项 | Windows EXE Demo | Android APK Demo | iOS Safari PWA（纯网页） |
| :--- | :---: | :---: | :---: |
| 极简界面、对话搜索、右侧分类组件栏 | 完整支持 | 完整支持 | 完整支持 |
| 酒馆 PNG V2/V3 角色卡 & 世界书 JSON 导入导出 | 完整支持 | 完整支持 | 完整支持（导出走系统分享「存储到文件」） |
| 离线本地运行 `tavern-core` 与动态世界书触发 | 完整支持 | 完整支持 | 完整支持（PWA 离线秒开） |
| 无 CORS 中转 / 本地 Ollama | 内置微网关原生支持 | 直连 / 可填电脑网关 | 支持 CORS 接口直连，或连电脑/自建网关 |
| 掉签风险与分发成本 | 绿色 EXE 直接发 | 独立 APK 直接发 | **永不掉签、免 \$99 苹果开发者账号** |
