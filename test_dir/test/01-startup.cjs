/**
 * 模块 01：启动与配置读取（对应文档第一章）。
 * 运行：node test_dir/test/01-startup.cjs
 */
const { createHarness } = require("./helpers/harness.cjs");
const { createReporter } = require("./helpers/reporter.cjs");

const reporter = createReporter("01-startup");

async function main() {
  const harness = createHarness("01-startup");

  reporter.section("首次启动 / 配置读取");
  // [1.1] 没有任何本地配置时：返回默认空状态且不报错
  const initial = await harness.api.getState();
  reporter.check(
    "1.1",
    "无本地配置时返回默认状态且无问题",
    initial.repositoryPath === "" &&
      initial.skills.length === 0 &&
      initial.groups.length === 0 &&
      initial.agents.length === 0 &&
      initial.theme === "light" &&
      initial.issues.length === 0,
    JSON.stringify(initial),
  );

  // [1.2] 重新读取配置：磁盘上被外部修改的主题能反映到下一次读取
  // 先执行一次写操作生成配置文件（getState 对不存在的文件只返回默认值、不落盘）
  await harness.api.setTheme("light");
  const stored = harness.readStoredState();
  stored.theme = "dark";
  harness.writeStoredState(JSON.stringify(stored));
  const reread = await harness.api.getState();
  reporter.check(
    "1.2",
    "重新读取时返回磁盘上的最新配置（主题变为深色）",
    reread.theme === "dark",
    JSON.stringify({ theme: reread.theme }),
  );

  // [1.4] 配置内容损坏：重置为默认配置并给出警告
  harness.writeStoredState("{ 这不是合法的 JSON");
  const corrupted = await harness.api.getState();
  reporter.check(
    "1.4",
    "配置损坏时重置为默认配置并提示",
    corrupted.repositoryPath === "" &&
      corrupted.agents.length === 0 &&
      corrupted.issues.some(
        (issue) => issue.type === "warning" && issue.message.includes("损坏"),
      ),
    JSON.stringify(corrupted.issues),
  );

  // [1.4 补充] 损坏后仍可正常执行写操作（例如保存主题），并自动重建配置
  const afterWrite = await harness.api.setTheme("dark");
  reporter.check(
    "1.4",
    "损坏恢复后写操作正常，配置被重建",
    afterWrite.theme === "dark" && harness.readStoredState()?.theme === "dark",
    JSON.stringify(harness.readStoredState()),
  );

  // [1.5] 配置读取 IO 错误：无法在跨平台测试中稳定制造（需 ACL 权限），走查代码
  reporter.skip("1.5", "需要构造 IO 权限错误，无法跨环境自动化，属代码走查项");
  // [1.6] 浏览器降级分支由 08-skill-queue.mjs 通过 backend.hasBackend 覆盖
  reporter.skip("1.6", "渲染层降级分支由 08-skill-queue.mjs 覆盖");
  // [1.7] 渲染层意外异常兜底属 UI 行为，人工验证
  reporter.skip("1.7", "渲染层 errorHandler 属 UI 行为，人工验证");

  reporter.finish();
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});
