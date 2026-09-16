/**
 * 模块 02：Skills 仓库（对应文档第二章：目录校验、扫描规则、扫描后收敛与防护）。
 * 运行：node test_dir/test/02-repository.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DIRS,
  REPO_DIR,
  TEST_DIR,
  captureError,
  createHarness,
  createSkill,
  listLinks,
  resetRepository,
  removeDirectoryTree,
} = require("./helpers/harness.cjs");
const { createReporter } = require("./helpers/reporter.cjs");

const reporter = createReporter("02-repository");
const AGENT1 = AGENT_DIRS[0];

async function main() {
  const harness = createHarness("02-repository");
  const { api } = harness;

  reporter.section("2.1 目录选择与校验");
  // [2.1.1] 目录选择框取消 / 选中
  harness.setDialogResult([]);
  reporter.check("2.1.1", "取消选择返回空串", api.chooseDirectory("") === "");
  harness.setDialogResult([TEST_DIR]);
  reporter.check("2.1.1", "选中目录时返回所选路径", api.chooseDirectory("") === TEST_DIR);

  // [2.1.3] 路径不存在
  let error = await captureError(() =>
    api.setRepository(path.join(TEST_DIR, "definitely-not-exists")),
  );
  reporter.check(
    "2.1.3",
    "不存在的路径报错",
    Boolean(error?.message.includes("不存在或无法访问")),
    error?.message,
  );

  // [2.1.4] 路径是文件
  error = await captureError(() =>
    api.setRepository(path.join(TEST_DIR, "test", "01-startup.cjs")),
  );
  reporter.check(
    "2.1.4",
    "文件路径报错",
    Boolean(error?.message.includes("不是文件夹")),
    error?.message,
  );

  // [2.1.5] 磁盘根目录
  error = await captureError(() => api.setRepository(path.parse(TEST_DIR).root));
  reporter.check(
    "2.1.5",
    "磁盘根目录报错",
    Boolean(error?.message.includes("磁盘根目录")),
    error?.message,
  );

  // [2.1.6] 仓库与 Agent 目录相同 / 互相包含
  let state = await api.createAgent({ name: "Repo Agent", directory: AGENT1 });
  const agentId = state.agents[0].id;
  error = await captureError(() => api.setRepository(AGENT1));
  reporter.check(
    "2.1.6",
    "仓库与 Agent 目录相同时报错",
    Boolean(error?.message.includes("互相包含")),
    error?.message,
  );
  const agentSubDir = path.join(AGENT1, "sub");
  fs.mkdirSync(agentSubDir, { recursive: true });
  error = await captureError(() => api.setRepository(agentSubDir));
  reporter.check(
    "2.1.6",
    "仓库位于 Agent 子目录时同样报错",
    Boolean(error?.message.includes("互相包含")),
    error?.message,
  );
  fs.rmdirSync(agentSubDir);

  // [1.8/2.1.8] 正常设置仓库并首次扫描
  state = await api.setRepository(REPO_DIR);
  reporter.check(
    "2.1.8",
    "正常设置仓库并扫描到 3 个 Skill",
    state.skills.length === 3,
    JSON.stringify(state.skills.map((skill) => skill.name)),
  );
  reporter.check(
    "2.2.1",
    "显示名为元数据 name、id 与目录名一致",
    state.skills.every((skill) => skill.id === skill.folderName) &&
      state.skills.some((skill) => skill.name === "Alpha Skill"),
    JSON.stringify(state.skills),
  );

  reporter.section("2.2 扫描规则");
  // [2.2.2] 小写 skill.md 同样识别
  createSkill(path.join(REPO_DIR, "delta"), "Delta Skill", { fileName: "skill.md" });
  state = await api.refresh();
  reporter.check(
    "2.2.2",
    "识别小写 skill.md",
    state.skills.some((skill) => skill.id === "delta"),
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );

  // [2.2.3] 没有 SKILL.md 的子目录：跳过并提示
  fs.mkdirSync(path.join(REPO_DIR, "empty-dir"));
  state = await api.refresh();
  reporter.check(
    "2.2.3",
    "无 SKILL.md 时跳过并提示可能不是 Skill",
    !state.skills.some((skill) => skill.id === "empty-dir") &&
      state.issues.some(
        (issue) =>
          issue.message.includes("empty-dir") &&
          issue.message.includes("可能不是一个 Skill"),
      ),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  fs.rmdirSync(path.join(REPO_DIR, "empty-dir"));

  // [2.2.4 + 2.3.4] 损坏的 SKILL.md：报错且不清理任何链接与选择记录
  await api.setAgentSkills(agentId, ["alpha"]);
  reporter.check("2.2.4", "损坏前链接已建立", listLinks(AGENT1).length === 1);
  fs.writeFileSync(path.join(REPO_DIR, "alpha", "SKILL.md"), "内容损坏", "utf8");
  state = await api.refresh();
  reporter.check(
    "2.2.4",
    "损坏的 SKILL.md 报错",
    state.issues.some(
      (issue) => issue.type === "error" && issue.message.includes("alpha"),
    ),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  reporter.check(
    "2.3.4",
    "扫描不完整时列表保持上次成功结果",
    state.skills.length === 4,
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  reporter.check("2.3.4", "扫描不完整时链接完全未变", listLinks(AGENT1).length === 1);
  reporter.check(
    "2.3.4",
    "扫描不完整时启用记录未变",
    state.enabledSkills[agentId].length === 1 &&
      state.enabledSkills[agentId][0] === "alpha",
  );
  reporter.check(
    "2.3.4",
    "提示“未完全成功”信息",
    state.issues.some((issue) => issue.message.includes("未完全成功")),
  );
  createSkill(path.join(REPO_DIR, "alpha"), "Alpha Skill");
  state = await api.refresh();
  reporter.check(
    "2.3.4",
    "修复后恢复正常（无错误）",
    !state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );

  // [2.2.5] 嵌套两层的 Skill 不识别（只扫一层）
  createSkill(path.join(REPO_DIR, "nest", "inner"), "Inner Skill");
  state = await api.refresh();
  reporter.check(
    "2.2.5",
    "嵌套目录不被识别",
    !state.skills.some((skill) => skill.id === "nest" || skill.id === "inner"),
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  reporter.check(
    "2.2.5",
    "外层目录提示可能不是 Skill",
    state.issues.some((issue) => issue.message.includes("nest")),
  );
  removeDirectoryTree(path.join(REPO_DIR, "nest"));

  // [2.2.6] 符号链接目录：静默跳过
  const outsideDir = path.join(TEST_DIR, ".tmp-outside-skill");
  createSkill(outsideDir, "Outside Skill");
  fs.symlinkSync(outsideDir, path.join(REPO_DIR, "linked"), "junction");
  state = await api.refresh();
  reporter.check(
    "2.2.6",
    "符号链接目录被静默跳过",
    !state.skills.some((skill) => skill.id === "linked") &&
      !state.issues.some((issue) => issue.message.includes("linked")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  fs.unlinkSync(path.join(REPO_DIR, "linked"));
  removeDirectoryTree(outsideDir);

  // [2.2.7] 仓库根目录的 SKILL.md 不视为 Skill
  fs.writeFileSync(
    path.join(REPO_DIR, "SKILL.md"),
    "---\nname: Root Skill\n---\n",
    "utf8",
  );
  state = await api.refresh();
  reporter.check(
    "2.2.7",
    "根目录 SKILL.md 被忽略",
    !state.skills.some((skill) => skill.name === "Root Skill"),
    JSON.stringify(state.skills.map((skill) => skill.name)),
  );
  fs.unlinkSync(path.join(REPO_DIR, "SKILL.md"));

  // [2.2.8] 名为 SKILL.md 的目录不算元数据文件
  fs.mkdirSync(path.join(REPO_DIR, "weird", "SKILL.md"), { recursive: true });
  state = await api.refresh();
  reporter.check(
    "2.2.8",
    "SKILL.md 为目录时视为没有 SKILL.md",
    !state.skills.some((skill) => skill.id === "weird") &&
      state.issues.some((issue) => issue.message.includes("weird")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  removeDirectoryTree(path.join(REPO_DIR, "weird"));

  // [2.2.9] 问题超过上限时聚合提示
  for (let index = 1; index <= 25; index += 1)
    fs.mkdirSync(path.join(REPO_DIR, `no-skill-${index}`));
  state = await api.refresh();
  reporter.check(
    "2.2.9",
    "超过 20 条问题后给出聚合提示",
    state.issues.some(
      (issue) =>
        issue.message.includes("另有") && issue.message.includes("未逐条展示"),
    ),
    JSON.stringify(state.issues.map((issue) => issue.message).slice(-3)),
  );
  for (let index = 1; index <= 25; index += 1)
    removeDirectoryTree(path.join(REPO_DIR, `no-skill-${index}`));

  // [2.2.12] 超过 2 MB 的 SKILL.md 拒绝读取
  fs.mkdirSync(path.join(REPO_DIR, "huge"));
  fs.writeFileSync(
    path.join(REPO_DIR, "huge", "SKILL.md"),
    `---\nname: Huge\n---\n${"x".repeat(2 * 1024 * 1024 + 10)}`,
    "utf8",
  );
  state = await api.refresh();
  reporter.check(
    "2.2.12",
    "超大 SKILL.md 被拒绝读取",
    state.issues.some((issue) => issue.message.includes("超过 2 MB")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  removeDirectoryTree(path.join(REPO_DIR, "huge"));
  state = await api.refresh();
  reporter.check(
    "2.2.12",
    "移除超大文件后恢复正常",
    !state.issues.some((issue) => issue.type === "error"),
  );

  reporter.section("2.3 收敛与防护");
  // [2.3.5] Skill 被删除：引用与链接自动清理
  await api.setAgentSkills(agentId, ["alpha", "beta"]);
  reporter.check("2.3.5", "清理前两个链接存在", listLinks(AGENT1).length === 2);
  removeDirectoryTree(path.join(REPO_DIR, "beta"));
  state = await api.refresh();
  reporter.check(
    "2.3.5",
    "列表中移除已删除的 Skill",
    !state.skills.some((skill) => skill.id === "beta"),
  );
  reporter.check(
    "2.3.5",
    "启用记录自动清理并提示",
    !state.enabledSkills[agentId].includes("beta") &&
      state.issues.some((issue) => issue.message.includes("已不在仓库中")),
    JSON.stringify(state.enabledSkills),
  );
  reporter.check("2.3.5", "对应链接被删除", listLinks(AGENT1).length === 1);

  // [2.3.6] 修改元数据 name：显示名变化、链接不变
  createSkill(path.join(REPO_DIR, "alpha"), "Alpha Renamed");
  state = await api.refresh();
  reporter.check(
    "2.3.6",
    "列表显示新的元数据 name",
    state.skills.find((skill) => skill.id === "alpha")?.name === "Alpha Renamed",
  );
  reporter.check("2.3.6", "链接保持不变", listLinks(AGENT1).length === 1);

  // [2.3.10] 重复刷新幂等
  const linksBefore = listLinks(AGENT1).join(",");
  await api.refresh();
  await api.refresh();
  reporter.check(
    "2.3.10",
    "重复刷新不产生多余链接",
    listLinks(AGENT1).join(",") === linksBefore,
    listLinks(AGENT1).join(","),
  );

  // [2.3.7] 目录改名：旧 Skill 消失、旧链接（悬空）被清理
  fs.renameSync(path.join(REPO_DIR, "alpha"), path.join(REPO_DIR, "alpha-new"));
  state = await api.refresh();
  reporter.check(
    "2.3.7",
    "旧 id 消失、新 id 出现",
    !state.skills.some((skill) => skill.id === "alpha") &&
      state.skills.some((skill) => skill.id === "alpha-new"),
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  reporter.check(
    "2.3.7",
    "启用记录清理、旧链接被清理",
    state.enabledSkills[agentId].length === 0 && listLinks(AGENT1).length === 0,
    JSON.stringify({ enabled: state.enabledSkills[agentId], links: listLinks(AGENT1) }),
  );

  // [2.3.8] 新增 Skill
  createSkill(path.join(REPO_DIR, "epsilon"), "Epsilon");
  state = await api.refresh();
  reporter.check(
    "2.3.8",
    "新增 Skill 出现在列表",
    state.skills.some((skill) => skill.id === "epsilon"),
  );

  // [2.3.12] 中文与空格目录
  createSkill(path.join(REPO_DIR, "中文 技能"), "中文技能");
  state = await api.refresh();
  reporter.check(
    "2.3.12",
    "中文空格目录被识别",
    state.skills.some((skill) => skill.id === "中文 技能"),
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  await api.setAgentSkills(agentId, ["中文 技能"]);
  reporter.check(
    "2.3.12",
    "中文链接创建成功",
    listLinks(AGENT1).includes("中文 技能"),
    JSON.stringify(listLinks(AGENT1)),
  );

  // [2.3.1] 正常刷新的成功路径（无错误问题）
  state = await api.refresh();
  reporter.check(
    "2.3.1",
    "正常刷新没有错误问题",
    !state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );

  // [2.3.2] 空仓库防护：拦下清理并保留现有链接与选择
  removeDirectoryTree(REPO_DIR);
  fs.mkdirSync(REPO_DIR, { recursive: true });
  state = await api.refresh();
  reporter.check(
    "2.3.2",
    "空仓库被拦下并给出确认指引",
    state.emptyRepository === true &&
      state.issues.some((issue) => issue.message.includes("确认仓库已清空")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  reporter.check(
    "2.3.2",
    "链接与启用记录被保留",
    listLinks(AGENT1).includes("中文 技能") &&
      state.enabledSkills[agentId].includes("中文 技能"),
  );

  // [2.3.3] 确认仓库已清空：收敛清理
  state = await api.refresh({ allowEmptyRepository: true });
  reporter.check("2.3.3", "确认后链接被清理", listLinks(AGENT1).length === 0);
  reporter.check("2.3.3", "确认后启用记录被清理", state.enabledSkills[agentId].length === 0);
  reporter.check("2.3.3", "emptyRepository 重置为 false", state.emptyRepository === false);

  // [2.3.9] 切换仓库：旧链接清理、旧引用清理、新仓库识别
  const secondRepo = path.join(TEST_DIR, ".tmp-repo-2");
  createSkill(path.join(secondRepo, "zeta"), "Zeta");
  state = await api.setRepository(secondRepo);
  reporter.check(
    "2.3.9",
    "新仓库被识别",
    state.skills.length === 1 && state.skills[0].id === "zeta",
    JSON.stringify(state.skills),
  );
  await api.setAgentSkills(agentId, ["zeta"]);
  reporter.check("2.3.9", "新仓库链接已建立", listLinks(AGENT1).length === 1);
  resetRepository();
  state = await api.setRepository(REPO_DIR);
  reporter.check(
    "2.3.9",
    "切换后旧链接被清理",
    listLinks(AGENT1).length === 0,
    JSON.stringify(listLinks(AGENT1)),
  );
  reporter.check(
    "2.3.9",
    "切换后旧启用记录被清理",
    state.enabledSkills[agentId].length === 0,
    JSON.stringify(state.enabledSkills),
  );
  reporter.check(
    "2.3.9",
    "切换后新仓库扫描成功",
    state.skills.length === 3,
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  removeDirectoryTree(secondRepo);

  // [2.3.11] 仓库被移动：报错且保留缓存
  const movedRepo = path.join(TEST_DIR, ".tmp-repo-moved");
  fs.renameSync(REPO_DIR, movedRepo);
  state = await api.refresh();
  reporter.check(
    "2.3.11",
    "仓库不可用时给出错误提示",
    state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  reporter.check(
    "2.3.11",
    "缓存列表被保留",
    state.skills.length === 3,
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  fs.renameSync(movedRepo, REPO_DIR);

  // 需要权限或 UI 行为的场景
  reporter.skip("2.1.2", "按钮禁用属前端行为，人工验证");
  reporter.skip("2.1.7", "刷新按钮禁用属前端行为，人工验证");
  reporter.skip("2.2.10", "需要构造子目录读取权限错误，代码走查");
  reporter.skip("2.2.11", "需要构造仓库读取权限错误，代码走查");

  reporter.finish();
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});
