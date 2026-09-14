import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

/** 单元与集成测试默认运行在 Node；组件测试通过文件注释切换到 jsdom。 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    include: ["tests/{unit,integration}/**/*.test.js"],
    setupFiles: ["./tests/setup.js"],
    restoreMocks: true,
    clearMocks: true,
  },
});
