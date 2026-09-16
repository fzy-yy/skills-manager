/**
 * 测试入口：依次运行全部模块（每个模块独立进程，互不影响）。
 * 运行：node test_dir/test/run-all.cjs
 *
 * 运行前会自动准备测试环境（重置 skills_repo 与 agents1-3）；
 * 全部结束后恢复测试目录到干净状态，运行产物保留在 test_dir/.user-data/ 供排查。
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { resetAgents, resetRepository } = require("./helpers/harness.cjs");

const MODULES = [
  "01-startup.cjs",
  "02-repository.cjs",
  "03-groups.cjs",
  "04-agents.cjs",
  "05-applications.cjs",
  "06-settings.cjs",
  "07-manual-changes.cjs",
  "08-skill-queue.mjs",
];

const results = [];
for (const moduleName of MODULES) {
  console.log(`\n########## ${moduleName} ##########`);
  const result = spawnSync(process.execPath, [path.join(__dirname, moduleName)], {
    stdio: "inherit",
    cwd: __dirname,
  });
  results.push({ moduleName, ok: result.status === 0 });
}

// 恢复测试目录到干净状态（不影响脚本与 fixtures 本身）
resetAgents();
resetRepository();

console.log("\n========== 测试汇总 ==========");
for (const { moduleName, ok } of results)
  console.log(`${ok ? "通过" : "失败"}  ${moduleName}`);
const failed = results.filter((item) => !item.ok).length;
console.log(failed ? `\n共 ${failed} 个模块失败` : "\n全部模块通过");
process.exit(failed ? 1 : 0);
