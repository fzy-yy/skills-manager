/**
 * 模块 09：Agent 直接复制模式（对应文档 4.21-4.22、5.21-5.27）。
 * 运行：node test_dir/test/09-copy-mode.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DIRS,
  REPO_DIR,
  TEST_DIR,
  captureError,
  clearDirectory,
  createHarness,
  createSkill,
  removeDirectoryTree,
  renameWithRetry,
  resetRepository,
} = require("./helpers/harness.cjs");
const { createReporter, runModule } = require("./helpers/reporter.cjs");

const reporter = createReporter("09-copy-mode");
const [AGENT1, AGENT2, AGENT3] = AGENT_DIRS;

async function main() {
  const harness = createHarness("09-copy-mode");
  const { api } = harness;

  let state = await api.setRepository(REPO_DIR);

  reporter.section("4.21 配置方式创建与历史兼容");
  // [4.21] 非法 syncMode 被拒绝
  const invalidModeError = await captureError(() =>
    api.createAgent({ name: "非法模式", directory: AGENT1, syncMode: "hardlink" }),
  );
  reporter.check(
    "4.21",
    "非法配置方式被拒绝",
    Boolean(invalidModeError?.message.includes("不支持的 Skills 配置方式")),
    invalidModeError?.message,
  );

  // [4.21] 默认方式为 symlink，显式传 copy 创建直接复制 Agent
  state = await api.createAgent({ name: "链接 Agent", directory: AGENT1 });
  const symlinkAgent = state.agents.find((item) => item.name === "链接 Agent");
  state = await api.createAgent({
    name: "复制 Agent",
    directory: AGENT2,
    syncMode: "copy",
  });
  const copyAgent = state.agents.find((item) => item.name === "复制 Agent");
  reporter.check(
    "4.21",
    "默认配置方式为 symlink，显式指定 copy 持久化成功",
    symlinkAgent?.syncMode === "symlink" &&
      copyAgent?.syncMode === "copy" &&
      harness.readStoredState()?.agents.find((a) => a.id === copyAgent.id)
        ?.syncMode === "copy",
    JSON.stringify(state.agents),
  );

  // [4.21] 历史配置缺少 syncMode 时自动兼容为 symlink
  const storedLegacy = harness.readStoredState();
  delete storedLegacy.agents[0].syncMode;
  harness.writeStoredState(JSON.stringify(storedLegacy));
  state = await api.getState();
  reporter.check(
    "4.21",
    "历史配置无 syncMode 时兼容为 symlink",
    state.agents[0]?.syncMode === "symlink",
    JSON.stringify(state.agents[0]),
  );

  reporter.section("5.21 正常复制开启与校验关闭");
  // 给 alpha 增加子目录与脚本文件，验证完整目录树复制与比对
  fs.mkdirSync(path.join(REPO_DIR, "alpha", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_DIR, "alpha", "scripts", "run.js"),
    "console.log('v1');\n",
    "utf8",
  );
  await api.refresh();

  state = await api.setAgentSkills(copyAgent.id, ["alpha"]);
  const copiedAlphaDir = path.join(AGENT2, "alpha");
  reporter.check(
    "5.21",
    "开启后在 Agent 目录创建真实目录（非符号链接）并复制全部子文件",
    fs.existsSync(copiedAlphaDir) &&
      !fs.lstatSync(copiedAlphaDir).isSymbolicLink() &&
      fs.lstatSync(copiedAlphaDir).isDirectory() &&
      fs.readFileSync(path.join(copiedAlphaDir, "scripts", "run.js"), "utf8") ===
        "console.log('v1');\n" &&
      state.enabledSkills[copyAgent.id].join(",") === "alpha",
    JSON.stringify({
      enabled: state.enabledSkills[copyAgent.id],
      issues: state.issues,
    }),
  );
  reporter.check(
    "5.21",
    "本地配置已记录复制快照指纹",
    Boolean(harness.readStoredState()?.copiedSkills?.[copyAgent.id]?.alpha),
    JSON.stringify(harness.readStoredState()?.copiedSkills),
  );

  // 关闭时校验通过后安全删除（含源目录存在只读文件的 Windows 场景）
  const readonlyFile = path.join(REPO_DIR, "alpha", "scripts", "readonly.txt");
  fs.writeFileSync(readonlyFile, "ro-data", "utf8");
  fs.chmodSync(readonlyFile, 0o444);
  await api.refresh();
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.21",
    "关闭未修改的副本（含只读文件）后目录被安全删除且记录清空",
    !fs.existsSync(copiedAlphaDir) &&
      state.enabledSkills[copyAgent.id].length === 0 &&
      !harness.readStoredState()?.copiedSkills?.[copyAgent.id]?.alpha &&
      state.issues.length === 0,
    JSON.stringify({
      exists: fs.existsSync(copiedAlphaDir),
      issues: state.issues,
    }),
  );
  fs.chmodSync(readonlyFile, 0o666);
  fs.unlinkSync(readonlyFile);
  await api.refresh();

  reporter.section("5.22 同名冲突单 Skill 粒度回退");
  // [5.22] 同名目录 / 同名文件 / 同名符号链接：冲突项回退、无冲突项正常复制
  const conflictDir = path.join(AGENT2, "beta");
  fs.mkdirSync(conflictDir, { recursive: true });
  fs.writeFileSync(path.join(conflictDir, "user.txt"), "用户已有内容", "utf8");
  fs.writeFileSync(path.join(AGENT2, "gamma"), "同名普通文件", "utf8");

  state = await api.setAgentSkills(copyAgent.id, ["alpha", "beta", "gamma"]);
  reporter.check(
    "5.22",
    "仅冲突项（beta/gamma）回退为关，无冲突项（alpha）正常开启并复制",
    state.enabledSkills[copyAgent.id].join(",") === "alpha" &&
      fs.existsSync(path.join(AGENT2, "alpha", "SKILL.md")),
    JSON.stringify({
      enabled: state.enabledSkills[copyAgent.id],
      issues: state.issues,
    }),
  );
  reporter.check(
    "5.22",
    "冲突位置的原目录与原文件完整保留并给出回退提示",
    fs.readFileSync(path.join(conflictDir, "user.txt"), "utf8") === "用户已有内容" &&
      fs.readFileSync(path.join(AGENT2, "gamma"), "utf8") === "同名普通文件" &&
      state.agentIssues[copyAgent.id].some((i) => i.message.includes("回退添加")),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  removeDirectoryTree(conflictDir);
  fs.unlinkSync(path.join(AGENT2, "gamma"));

  // 同名符号链接也触发回退且保留原链接
  fs.symlinkSync(AGENT1, path.join(AGENT2, "beta"), "junction");
  state = await api.setAgentSkills(copyAgent.id, ["alpha", "beta"]);
  reporter.check(
    "5.22",
    "目标为同名符号链接时保留原链接并回退添加",
    state.enabledSkills[copyAgent.id].join(",") === "alpha" &&
      fs.lstatSync(path.join(AGENT2, "beta")).isSymbolicLink() &&
      state.agentIssues[copyAgent.id].some(
        (i) => i.message.includes("符号链接") && i.message.includes("回退添加"),
      ),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  fs.unlinkSync(path.join(AGENT2, "beta"));

  reporter.section("5.23 关闭前校验不通过保护（含 SKILL.md 与内容一致性）");
  // 场景 A：修改了副本中子文件内容 -> 保留目录、开关置关、警告
  fs.writeFileSync(
    path.join(AGENT2, "alpha", "scripts", "run.js"),
    "console.log('user-edited');\n",
    "utf8",
  );
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.23",
    "副本内容被修改时：保留目录、开关置关、停止托管并警告",
    fs.existsSync(path.join(AGENT2, "alpha", "scripts", "run.js")) &&
      state.enabledSkills[copyAgent.id].length === 0 &&
      !harness.readStoredState()?.copiedSkills?.[copyAgent.id]?.alpha &&
      state.agentIssues[copyAgent.id].some(
        (i) => i.type === "warning" && i.message.includes("不一致"),
      ),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  removeDirectoryTree(path.join(AGENT2, "alpha"));

  // 场景 B：删除了副本里的 SKILL.md -> 保留目录、提示缺少 SKILL.md
  await api.setAgentSkills(copyAgent.id, ["beta"]);
  fs.unlinkSync(path.join(AGENT2, "beta", "SKILL.md"));
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.23",
    "副本缺少 SKILL.md 时拒绝删除并提示",
    fs.existsSync(path.join(AGENT2, "beta")) &&
      state.enabledSkills[copyAgent.id].length === 0 &&
      state.agentIssues[copyAgent.id].some((i) => i.message.includes("缺少 SKILL.md")),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  removeDirectoryTree(path.join(AGENT2, "beta"));

  // 场景 C：副本内被放入额外文件 -> 拒绝删除
  await api.setAgentSkills(copyAgent.id, ["beta"]);
  fs.writeFileSync(path.join(AGENT2, "beta", "extra.txt"), "extra", "utf8");
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.23",
    "副本内新增其他文件时拒绝删除",
    fs.existsSync(path.join(AGENT2, "beta", "extra.txt")) &&
      state.enabledSkills[copyAgent.id].length === 0,
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  removeDirectoryTree(path.join(AGENT2, "beta"));

  // 场景 D：副本内被放入符号链接 -> 拒绝删除
  await api.setAgentSkills(copyAgent.id, ["beta"]);
  fs.symlinkSync(AGENT1, path.join(AGENT2, "beta", "nested-link"), "junction");
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.23",
    "副本内包含符号链接时拒绝删除",
    fs.existsSync(path.join(AGENT2, "beta", "nested-link")) &&
      state.agentIssues[copyAgent.id].some((i) => i.message.includes("符号链接")),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  removeDirectoryTree(path.join(AGENT2, "beta"));

  // 场景 E：副本被用户替换为同名普通文件 -> 保留文件不删
  await api.setAgentSkills(copyAgent.id, ["beta"]);
  removeDirectoryTree(path.join(AGENT2, "beta"));
  fs.writeFileSync(path.join(AGENT2, "beta"), "replaced-file", "utf8");
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.23",
    "副本被替换为普通文件时保留文件并提示",
    fs.readFileSync(path.join(AGENT2, "beta"), "utf8") === "replaced-file" &&
      state.agentIssues[copyAgent.id].some((i) => i.message.includes("普通文件")),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  fs.unlinkSync(path.join(AGENT2, "beta"));

  reporter.section("5.24 系统元数据文件忽略");
  // [5.24] 副本目录里多出 Thumbs.db / .DS_Store / desktop.ini 时仍判定一致并正常删除
  await api.setAgentSkills(copyAgent.id, ["beta"]);
  fs.writeFileSync(path.join(AGENT2, "beta", "Thumbs.db"), "thumb", "utf8");
  fs.writeFileSync(path.join(AGENT2, "beta", ".DS_Store"), "ds", "utf8");
  fs.writeFileSync(path.join(AGENT2, "beta", "desktop.ini"), "ini", "utf8");
  state = await api.setAgentSkills(copyAgent.id, []);
  reporter.check(
    "5.24",
    "系统元数据文件被忽略，副本正常删除且无警告",
    !fs.existsSync(path.join(AGENT2, "beta")) &&
      state.agentIssues[copyAgent.id].length === 0,
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );

  reporter.section("5.25 & 5.26 异常源与目录不可用回退");
  // [5.25] 缓存中源目录不存在的 Skill：复制失败回退且无临时目录残留
  const storedGhost = harness.readStoredState();
  storedGhost.cachedSkills.push({
    id: "ghost",
    name: "Ghost Skill",
    sourcePath: path.join(REPO_DIR, "ghost"),
  });
  harness.writeStoredState(JSON.stringify(storedGhost));
  state = await api.setAgentSkills(copyAgent.id, ["alpha", "ghost"]);
  const leftoverTmp = fs
    .readdirSync(AGENT2)
    .filter((name) => name.startsWith(".skills-manager-tmp-"));
  reporter.check(
    "5.25",
    "源目录不存在时单 Skill 回退、无临时目录残留",
    state.enabledSkills[copyAgent.id].join(",") === "alpha" &&
      leftoverTmp.length === 0 &&
      state.agentIssues[copyAgent.id].some((i) => i.type === "error"),
    JSON.stringify({
      enabled: state.enabledSkills[copyAgent.id],
      leftoverTmp,
      issues: state.agentIssues[copyAgent.id],
    }),
  );
  await api.refresh();

  // [5.26] Agent 目录不可用时开关：报错且回退到操作前的启用记录
  const movedAgent2 = path.join(TEST_DIR, ".tmp-copy-agent-moved");
  await renameWithRetry(AGENT2, movedAgent2);
  state = await api.setAgentSkills(copyAgent.id, ["alpha", "beta"]);
  reporter.check(
    "5.26",
    "Agent 目录不可用时报错并保持原启用记录不变",
    state.enabledSkills[copyAgent.id].join(",") === "alpha" &&
      state.agentIssues[copyAgent.id].some(
        (i) => i.type === "error" && i.message.includes("目录不可用"),
      ),
    JSON.stringify({
      enabled: state.enabledSkills[copyAgent.id],
      issues: state.agentIssues[copyAgent.id],
    }),
  );
  await renameWithRetry(movedAgent2, AGENT2);

  reporter.section("5.27 刷新同步、仓库更新、清理边界与防护");
  // [5.27a] 仓库更新后刷新：未改副本自动同步更新；已改副本保留不覆盖
  await api.setAgentSkills(copyAgent.id, ["alpha", "beta"]);
  fs.writeFileSync(
    path.join(REPO_DIR, "alpha", "scripts", "run.js"),
    "console.log('v2');\n",
    "utf8",
  );
  // 修改 beta 的本地副本，同时修改仓库 beta
  fs.writeFileSync(path.join(AGENT2, "beta", "local.txt"), "local-change", "utf8");
  createSkill(path.join(REPO_DIR, "beta"), "Beta Skill V2");

  state = await api.refresh();
  reporter.check(
    "5.27",
    "仓库更新后刷新：未改副本 alpha 自动同步到 v2",
    fs.readFileSync(path.join(AGENT2, "alpha", "scripts", "run.js"), "utf8") ===
      "console.log('v2');\n",
  );
  reporter.check(
    "5.27",
    "仓库更新后刷新：已改副本 beta 保留本地内容不覆盖并警告",
    fs.existsSync(path.join(AGENT2, "beta", "local.txt")) &&
      state.agentIssues[copyAgent.id].some(
        (i) => i.type === "warning" && i.message.includes("未自动覆盖更新"),
      ),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );

  // [5.27b] 手动删除已启用副本后刷新自动重新复制恢复
  removeDirectoryTree(path.join(AGENT2, "alpha"));
  state = await api.refresh();
  reporter.check(
    "5.27",
    "已启用副本被手动删除后刷新自动重新复制",
    fs.existsSync(path.join(AGENT2, "alpha", "scripts", "run.js")),
  );

  // [5.27b 补充] 已启用副本被替换为普通文件且源未改动时，刷新应给出冲突警告
  removeDirectoryTree(path.join(AGENT2, "alpha"));
  fs.writeFileSync(path.join(AGENT2, "alpha"), "replaced", "utf8");
  state = await api.refresh();
  reporter.check(
    "5.27",
    "已启用副本被替换为普通文件时刷新给出警告且保留文件",
    fs.readFileSync(path.join(AGENT2, "alpha"), "utf8") === "replaced" &&
      state.agentIssues[copyAgent.id].some(
        (i) => i.type === "warning" && i.message.includes("已被替换为文件"),
      ),
    JSON.stringify(state.agentIssues[copyAgent.id]),
  );
  fs.unlinkSync(path.join(AGENT2, "alpha"));
  await api.refresh();

  // [5.27c] 扫描不完整（坏 SKILL.md）时不得清理任何副本
  fs.writeFileSync(path.join(REPO_DIR, "gamma", "SKILL.md"), "坏掉的元数据", "utf8");
  state = await api.refresh();
  reporter.check(
    "5.27",
    "扫描不完整时副本与启用记录完全保留",
    fs.existsSync(path.join(AGENT2, "alpha", "SKILL.md")) &&
      state.enabledSkills[copyAgent.id].includes("alpha"),
  );
  createSkill(path.join(REPO_DIR, "gamma"), "Gamma Skill");
  await api.refresh();

  // [5.27d] 仓库删除某 Skill：未修改副本凭借快照指纹自动清理
  removeDirectoryTree(path.join(REPO_DIR, "alpha"));
  state = await api.refresh();
  reporter.check(
    "5.27",
    "源 Skill 被删除后刷新：未改副本凭借快照指纹安全清理",
    !fs.existsSync(path.join(AGENT2, "alpha")) &&
      !state.enabledSkills[copyAgent.id].includes("alpha"),
    JSON.stringify({
      exists: fs.existsSync(path.join(AGENT2, "alpha")),
      enabled: state.enabledSkills[copyAgent.id],
    }),
  );

  // [5.27e] 仅清理本插件记录的副本：用户手动放入的同内容目录绝不自动删除
  resetRepository();
  await api.refresh();
  createSkill(path.join(AGENT2, "gamma"), "Gamma Skill"); // 与仓库 gamma 内容一致，但未在 copiedSkills 中
  state = await api.refresh();
  reporter.check(
    "5.27",
    "未由本插件记录的同名同内容目录在刷新时绝不自动删除",
    fs.existsSync(path.join(AGENT2, "gamma", "SKILL.md")),
  );

  reporter.section("4.22 删除复制模式 Agent & 切换仓库 & 清除数据");
  // [4.22] 删除 copy Agent：未改受管副本被删除，已改副本与未记录目录保留
  await api.setAgentSkills(copyAgent.id, ["alpha", "beta"]);
  // alpha 未改，beta 此前已被本地改动过（且有 local.txt），gamma 为用户手动放入未记录
  state = await api.deleteAgent(copyAgent.id);
  reporter.check(
    "4.22",
    "删除 Agent 后：未改受管副本 alpha 被清理",
    !fs.existsSync(path.join(AGENT2, "alpha")),
  );
  reporter.check(
    "4.22",
    "删除 Agent 后：已改副本 beta 与未记录目录 gamma 均完整保留",
    fs.existsSync(path.join(AGENT2, "beta", "local.txt")) &&
      fs.existsSync(path.join(AGENT2, "gamma", "SKILL.md")),
  );
  reporter.check(
    "4.22",
    "删除 Agent 后：copiedSkills 记录一并清理",
    harness.readStoredState()?.copiedSkills?.[copyAgent.id] === undefined,
  );
  clearDirectory(AGENT2);

  // [5.27f] 切换仓库 & 清除数据清理未改受管副本
  state = await api.createAgent({
    name: "复制 Agent 2",
    directory: AGENT3,
    syncMode: "copy",
  });
  const copyAgent3 = state.agents.find((a) => a.name === "复制 Agent 2");
  await api.setAgentSkills(copyAgent3.id, ["alpha"]);
  reporter.check(
    "5.27",
    "切换仓库前受管副本存在",
    fs.existsSync(path.join(AGENT3, "alpha", "SKILL.md")),
  );
  const secondRepo = path.join(TEST_DIR, ".tmp-copy-repo-2");
  createSkill(path.join(secondRepo, "zeta"), "Zeta Skill");
  state = await api.setRepository(secondRepo);
  reporter.check(
    "5.27",
    "切换仓库后旧仓库未改副本被清理",
    !fs.existsSync(path.join(AGENT3, "alpha")),
  );

  // 启用新仓库 Skill 后执行 clearData
  await api.setAgentSkills(copyAgent3.id, ["zeta"]);
  reporter.check(
    "5.27",
    "清除数据前新副本存在",
    fs.existsSync(path.join(AGENT3, "zeta", "SKILL.md")),
  );
  state = await api.clearData();
  reporter.check(
    "5.27",
    "清除数据后受管副本被清理且仓库源文件完整保留",
    !fs.existsSync(path.join(AGENT3, "zeta")) &&
      fs.existsSync(path.join(secondRepo, "zeta", "SKILL.md")) &&
      state.agents.length === 0,
  );
  removeDirectoryTree(secondRepo);

  reporter.finish();
}

runModule(main);
