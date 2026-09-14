# 测试说明

测试按职责放在独立目录中：

- `unit/`：纯函数、状态队列、反馈控制器和基础 Vue 组件。
- `integration/`：真实临时文件系统上的配置存储、仓库扫描、链接生命周期，以及 preload API 编排。
- `e2e/`：在 Chromium 中运行完整 Vue 应用，通过 preload API 假实现验证主要用户流程。

常用命令：

```bash
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:all
```

首次运行 E2E 前安装 Chromium：

```bash
pnpm exec playwright install chromium
```

所有文件系统集成测试使用系统临时目录，用例结束后自动清理，不会读取或修改真实的 uTools 数据。
