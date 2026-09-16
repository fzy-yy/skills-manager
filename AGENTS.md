# AGENTS.md

uTools 插件「Skills 管理器」。核心职责只有两件事：在 Agent 目录中创建、删除指向统一 Skills 仓库的符号链接；绝不改动仓库中的 skill 源文件。

**动手修改代码前，先阅读 uTools 开发者文档**（https://www.u-tools.cn/docs/developer/docs.html），熟悉插件机制与 API 后再开始。

## 开发约束

- 依赖克制：项目功能简单，除现有依赖（vue / pinia / vue-router / @lucide/vue / tailwindcss / vite）外，不引入重量级工程化库（ESLint、Prettier、测试框架等）
- 代码简洁可读：小项目同样要保持结构清晰、可维护、可扩展、写法统一；所有源码必须有完整规范的中文注释，改代码时同步更新注释

## 命令

- `pnpm dev` — Vite 开发服务器，端口固定 `127.0.0.1:5173`（public/plugin.json 的 `development.main` 依赖它，勿改端口）
- `pnpm build` — 构建到 dist/；改动 src/ 或 public/ 后必须重新构建才能在 uTools 中生效
- `node test_dir/test/run-all.cjs` — 纯 Node 测试脚本（无测试框架），mock uTools 环境覆盖全部场景；单模块运行见 doc 文档第十节
- **没有 lint、formatter**：不要引入相关依赖（见上文「开发约束」）
- 浏览器打开 dev server 只能预览渲染层（无 `window.skillsManager`，走降级分支）；真实功能必须在 uTools 开发者工具中测试

## 代码结构（preload 与渲染层两层）

- `public/preload/*.js` — uTools 的 Node/CommonJS 环境：services.js 入口 / api.js 编排 / config.js 配置 / scanner.js 扫描 / links.js 链接 / utils.js 工具
- `src/**` — Vue 3 + Pinia 渲染层（ESM）：stores/appStore.js 主状态，stores/skill-queue.js 开关防抖队列，api/backend.js 是访问 preload 的唯一入口
- 两层的契约是 `window.skillsManager` 返回的状态对象；改返回结构要同步三处：`public/preload/api.js` 的 `buildState`、`src/types/skills-manager.d.ts`、`src/stores/appStore.js` 的 `applyState`

## 硬约束（踩坑高发区）

- `public/preload/package.json` 必须保持 `{"type":"commonjs"}`——根 package.json 是 `"type":"module"`，删掉它 uTools 将无法加载 preload
- `pnpm-workspace.yaml` 的 `allowBuilds` 放行 esbuild 构建脚本，勿删，否则 vite 无法运行
- dist/ 是 uTools 实际加载的产物（已 gitignore）；本地配置在 `<uTools userData>/skills-manager/state.json`，不同步、不提交
- 链接同步模型（改 scanner.js / links.js 前必读）：
  - 只扫描仓库**第一层子目录**中的 SKILL.md，不递归；Skill id 与链接文件名 = 子目录名，界面显示名 = SKILL.md 元数据 `name`
  - 删除链接只针对「指向仓库内」或「已悬空」的符号链接；普通文件、目录、指向仓库外的链接一律不碰
  - 扫描不完整（`complete=false`）或空仓库防护（`emptyRepository`）触发时，不得执行任何清理
  - Agent 目录必须为空且创建后不可修改，只能删除重建
- 路径比较必须用 `public/preload/utils.js` 的 `comparablePath` / `pathsEqualLexical` / `isInsideDirectoryLexical`，禁止裸字符串比较（Windows 大小写、`\\?\` 前缀、分隔符问题）
- Windows 上链接以 junction 创建；删除先 unlink，失败回退 rmdir

## 前端约定

- 图标只从 `@lucide/vue` 导入（不是 lucide-vue-next）
- 只用 `src/main.css` 中的 Tailwind 语义类（bg-canvas、text-ink、border-border 等），禁止硬编码色值；深色主题靠 `<html class="dark">` 开关；Tailwind v4 没有 tailwind.config.js / postcss.config.js
- 页面布局统一为「顶部固定 + 内容区独立滚动」：视图根元素用 `h-full` + `overflow-hidden`，内部滚动区用 `min-h-0 flex-1 overflow-y-auto`；App.vue 的 main 是 `overflow-hidden`，不允许整页滚动
- 滚动条已全局隐藏（`src/main.css` 的 `::-webkit-scrollbar { display: none }`），勿写 `overflow: hidden` 禁用滚动能力
- 路由用 `createMemoryHistory`（uTools 从本地文件加载页面）
- skill 开关是「乐观更新 + 300ms 防抖 + 失败回滚」，preload 侧写操作全局串行；勿在开关路径上引入同步等待

## 验证方式

- 改代码前先读 `doc/用户操作与异常场景.md`：里面是按用户视角整理的全部预期行为、防护清单与测试要点；修改错误处理时对照它，行为有变化时同步更新文档与 `test_dir` 中对应编号的测试断言
- 改 preload 逻辑后：`node test_dir/test/run-all.cjs` 跑自动化回归（纯 Node、无框架），再跑 `pnpm build` 并在 uTools 开发者工具中重载插件人工验证 UI 行为（测试中 SKIP 的场景）
- 单个模块可独立运行（如 `node test_dir/test/02-repository.cjs`）；测试产物在 `test_dir/.user-data/`，agents1-3 为测试沙箱，勿放真实数据
- 测试可与 dev server 同时运行：vite 已配置忽略 `test_dir`（否则 Windows 上 watcher 会锁住测试目录导致重命名报 EPERM）
