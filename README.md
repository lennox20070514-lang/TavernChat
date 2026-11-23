# TavernChat

极简好用的本地组件化角色与世界观对话工作台。

- **极简优先**：抛弃传统酒馆的复杂滑块和迷宫抽屉，默认首屏干净纯粹，进阶能力渐进式折叠。
- **万物皆组件，对话自由选入 / 选出**：把角色卡、世界卡、人设卡、规则预设统一收拢进组件库，在任意对话里像搭积木一样一键勾选挂载或移除；支持 0 角色纯净对话、单角色扮演与多角色群像无缝切换。
- **100% 兼容 SillyTavern 核心生态**：支持拖放或批量导入导出标准酒馆 PNG 角色卡（V2/V3，自动提取内嵌世界书）、World Info 世界书 JSON、OpenAI 预设 JSON、群聊 JSON 与聊天记录 JSONL。
- **来源插件市场**：以社区来源为单位添加插件，站内浏览并下载角色卡；作者、来源与授权随卡片保留。桌面端自动走内嵌网关，安卓端使用原生 HTTP，不依赖电脑常驻。
- **白盒上下文透视**：随时一键预览发送给模型的完整 Prompt 队列、Token 估算与命中的世界书关键词。
- **本地运行 & 多端架构**：
  - `packages/tavern-core`：零 DOM、零 Node 依赖的纯 TypeScript 酒馆精髓引擎（全端共享）。
  - `apps/web`：React 18 + Rspack + IndexedDB 极简响应式界面（支持 Web / PWA / Capacitor Android APK）。
  - `apps/server`：零外部依赖超轻本地微网关（消除 CORS，统一转发 OpenAI / DeepSeek / Claude / Gemini / Ollama）。
  - `apps/desktop`：Electron 电脑端壳（双击即启内置 `127.0.0.1` 网关，并预留未来 PC 满血版存储/RAG 扩展插槽）。

---

## 常用命令

```sh
corepack pnpm install    # 安装依赖
corepack pnpm dev        # 同时启动本地微网关 (:8797) 与前端 (:8091)
corepack pnpm test       # 运行 tavern-core 核心引擎单元测试
corepack pnpm type       # 全包 TypeScript 严格类型检查
corepack pnpm build      # 构建生产静态产物至 apps/web/dist/
corepack pnpm apk:sync   # 同步构建产物至 Capacitor Android 工程
corepack pnpm exe:build  # 打包 Windows 便携版 & 安装版 EXE 至 apps/desktop/release/
```
