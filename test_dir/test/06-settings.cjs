/**
 * 模块 06：设置与数据管理（对应文档第六章，preload 侧行为）。
 * 运行：node test_dir/test/06-settings.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DIRS,
  REPO_DIR,
  TEST_DIR,
  clearDirectory,
  createHarness,
  listLinks,
  removeDirectoryTree,
} = require("./helpers/harness.cjs");
const { createReporter } = require("./helpers/reporter.cjs");

const reporter = createReporter("06-settings");
const AGENT1 = AGENT_DIRS[0];

async function main() {
  const harness = createHarness("06-settings");
  const { api } = harness;

  reporter.section("主题设置");
  // [6.1] 保存主题并持久化
  let state = await api.setTheme("dark");
  reporter.check("6.1", "主题保存成功", state.theme === "dark");
  reporter.check(
    "6.1",
    "主题已持久化到本地配置",
    harness.readStoredState()?.theme === "dark",
    JSON.stringify(harness.readStoredState()?.theme),
  );
  state = await api.getState();
  reporter.check("6.1", "重新读取时主题保持深色", state.theme === "dark");
  await api.setTheme("light");

  reporter.section("清除数据");
  // [6.3 + 6.6] 清除数据：清链接、删配置、保留仓库文件
  state = await api.setRepository(REPO_DIR);
  state = await api.createAgent({ name: "设置 Agent", directory: AGENT1 });
  const agentId = state.agents[0].id;
  state = await api.setAgentSkills(agentId, ["alpha", "beta"]);
  const repoFilesBefore = fs.readdirSync(REPO_DIR).sort();
  reporter.check("6.3", "清除前链接存在", listLinks(AGENT1).length === 2);

  state = await api.clearData();
  reporter.check(
    "6.3",
    "清除后链接被清理",
    listLinks(AGENT1).length === 0,
    JSON.stringify(listLinks(AGENT1)),
  );
  reporter.check(
    "6.3",
    "清除后返回默认状态",
    state.repositoryPath === "" &&
      state.agents.length === 0 &&
      state.skills.length === 0,
    JSON.stringify(state),
  );
  reporter.check(
    "6.3",
    "本地配置文件被删除",
    !fs.existsSync(harness.statePath),
  );
  reporter.check(
    "6.6",
    "仓库源文件未被改动",
    fs.readdirSync(REPO_DIR).sort().join(",") === repoFilesBefore.join(","),
    JSON.stringify(fs.readdirSync(REPO_DIR)),
  );

  // [6.5] 清除数据后主题回到默认浅色
  await api.setTheme("dark");
  state = await api.clearData();
  reporter.check("6.5", "清除后主题重置为浅色", state.theme === "light");

  // [6.4] 清除数据时某个 Agent 目录已被移走：静默视为清理完成，不阻断清除
  state = await api.setRepository(REPO_DIR);
  state = await api.createAgent({ name: "不可用目录 Agent", directory: AGENT1 });
  const unavailableAgentId = state.agents[0].id;
  await api.setAgentSkills(unavailableAgentId, ["alpha"]);
  const movedDir = path.join(TEST_DIR, ".tmp-agent-moved");
  fs.renameSync(AGENT1, movedDir);
  state = await api.clearData();
  reporter.check(
    "6.4",
    "目录已被移走时静默跳过（不产生错误）",
    !state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  reporter.check(
    "6.4",
    "配置仍被正常清除",
    state.agents.length === 0 && !fs.existsSync(harness.statePath),
  );
  removeDirectoryTree(movedDir);
  fs.mkdirSync(AGENT1, { recursive: true });

  // [6.7] 配置损坏状态下清除数据：重置并提示（链接无法识别清理，属已知局限）
  state = await api.setRepository(REPO_DIR);
  state = await api.createAgent({ name: "损坏 Agent", directory: AGENT1 });
  await api.setAgentSkills(state.agents[0].id, ["alpha"]);
  reporter.check("6.7", "损坏前链接存在", listLinks(AGENT1).length === 1);
  harness.writeStoredState("{ 损坏的 JSON");
  state = await api.clearData();
  reporter.check(
    "6.7",
    "损坏状态清除后给出损坏提示",
    state.issues.some((issue) => issue.message.includes("损坏")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  reporter.check(
    "6.7",
    "损坏状态下配置被清除（链接无法识别，属已知局限）",
    state.agents.length === 0 && !fs.existsSync(harness.statePath),
  );
  clearDirectory(AGENT1);

  // [6.2] 主题保存失败回滚属渲染层行为
  reporter.skip("6.2", "主题失败回滚属 appStore 行为，人工验证");

  reporter.finish();
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});
