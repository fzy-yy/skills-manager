/**
 * 面向 Vue 前端的预加载 API：编排配置读写、仓库扫描与链接同步。
 *
 * 约定：
 *  - 所有改动磁盘的操作（写配置、建 / 删链接）都经过本文件顶部的串行队列，
 *    保证同一时刻只有一个操作在动文件，避免并发交叉；
 *  - 每个方法失败时直接抛错（渲染层统一捕获并提示），成功时返回完整状态对象；
 *  - 用户操作留下的问题（冲突、失效引用等）通过状态中的 issues / agentIssues 返回。
 */
const fs = require("node:fs");
const {
  MAX_ENTITY_NAME_LENGTH,
  createConfigStore,
  createDefaultState,
  uniqueEntityName,
} = require("./config");
const { removeManagedLinks, syncAgentLinks } = require("./links");
const { scanRepository } = require("./scanner");
const {
  createIssue,
  errorMessage,
  normalizeDirectory,
  pathsEqualLexical,
  pathsOverlapLexical,
  uniqueIssues,
} = require("./utils");

/**
 * 创建插件 API。
 *
 * @param {object} options - 运行环境
 * @param {object} options.utools - window.utools 实例
 * @returns {object} 暴露给渲染层的 API 对象（所有写方法已串行化）
 */
function createSkillsManagerApi({ utools }) {
  const config = createConfigStore(utools);

  /** 写操作串行队列：下一次操作必须等上一次操作结束（无论成败）。 */
  let tail = Promise.resolve();
  function serialize(operation) {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 读取本地配置。
   *
   * @returns {Promise<{state: object, issues: Array}>}
   */
  async function readState() {
    return config.read();
  }

  /**
   * 组装返回给渲染层的状态对象。
   *
   * @param {object} state - 内部配置对象
   * @param {object} [options] - 可选项
   * @param {Array} [options.skills] - 要展示的 Skills 列表（缺省用扫描缓存）
   * @param {Array} [options.issues] - 需要提示的问题
   * @param {object} [options.agentIssues] - 按 Agent 归因的链接问题
   * @param {boolean} [options.emptyRepository] - 是否因“仓库为空”被拦下
   * @returns {object} 渲染层状态
   */
  function buildState(state, { skills, issues = [], agentIssues, emptyRepository } = {}) {
    const result = {
      repositoryPath: state.repositoryPath,
      skills: skills || state.cachedSkills,
      groups: state.groups,
      agents: state.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        directory: agent.directory,
      })),
      enabledSkills: state.enabledSkills,
      theme: state.theme,
      issues: uniqueIssues(issues),
    };
    if (agentIssues) result.agentIssues = agentIssues;
    if (typeof emptyRepository === "boolean")
      result.emptyRepository = emptyRepository;
    return result;
  }

  /**
   * 扫描仓库并同步所有 Agent 的链接（设置仓库与手动刷新共用）。
   *
   * 流程：扫描 → 清理失效引用 → 保存配置 → 逐个 Agent 同步链接。
   * 扫描不完整或仓库疑似被清空时只返回提示，不执行任何链接清理。
   *
   * @param {object} state - 当前配置
   * @param {{allowEmptyRepository?: boolean, issues?: Array, scan?: object}} [options]
   *        allowEmptyRepository 表示用户已确认仓库确实为空；scan 可传入已完成的扫描结果以避免重复扫描
   * @returns {Promise<object>} 渲染层状态
   * @throws {Error} 未配置仓库路径或保存配置失败时抛出
   */
  async function refreshInternal(
    state,
    { allowEmptyRepository = false, issues = [], scan: presetScan } = {},
  ) {
    if (!state.repositoryPath) throw new Error("请先配置 Skills 仓库目录");
    const scan = presetScan || (await scanRepository(state.repositoryPath));
    const allIssues = [...issues, ...scan.issues];

    if (!scan.complete) {
      // 扫描不完整时保持上次完整扫描的状态：不更新缓存、不清理引用、不同步链接，
      // 避免把暂时无法确认的 Skill 当作“已删除”而清掉它的链接与选择记录。
      // 用户修复问题后再次扫描即可恢复（若从未成功扫描过，列表为空并有错误提示）。
      allIssues.push(
        createIssue(
          "info",
          state.cachedSkills.length
            ? "本次扫描未完全成功（存在无法读取或无法解析的目录），Skills 列表显示的是上次成功扫描的结果；未对分组与链接执行任何清理。"
            : "本次扫描未完全成功，未获取到可用的 Skill 列表；请根据上方错误提示修复后重新扫描。",
        ),
      );
      return buildState(state, { skills: state.cachedSkills, issues: allIssues });
    }

    // 空仓库防护：缓存里原本有 Skills，本次却一个都没扫到，先不动任何链接。
    if (
      !allowEmptyRepository &&
      scan.skills.length === 0 &&
      state.cachedSkills.length > 0
    ) {
      allIssues.push(
        createIssue(
          "error",
          "仓库本次未检测到任何 Skill。为防止临时空目录导致误删，现有分组、选择和链接已保留；若确认仓库已清空，可点击页面上的“确认仓库已清空”清理失效记录。",
        ),
      );
      return buildState(state, {
        skills: state.cachedSkills,
        issues: allIssues,
        emptyRepository: true,
      });
    }

    // 清理分组与启用记录中已不存在的 Skill 引用。
    const validIds = new Set(scan.skills.map((skill) => skill.id));
    for (const group of state.groups) {
      const kept = group.skillIds.filter((skillId) => validIds.has(skillId));
      if (kept.length !== group.skillIds.length) {
        allIssues.push(
          createIssue(
            "warning",
            `分组“${group.name}”中有 ${group.skillIds.length - kept.length} 个 Skill 已不在仓库中，失效引用已自动清理。`,
          ),
        );
        group.skillIds = kept;
      }
    }
    for (const agent of state.agents) {
      const current = state.enabledSkills[agent.id] || [];
      const kept = current.filter((skillId) => validIds.has(skillId));
      if (kept.length !== current.length) {
        allIssues.push(
          createIssue(
            "warning",
            `Agent“${agent.name}”有 ${current.length - kept.length} 个已启用 Skill 已不在仓库中，选择记录已自动取消。`,
          ),
        );
        state.enabledSkills[agent.id] = kept;
      }
    }

    state.cachedSkills = scan.skills;
    await config.write(state);

    const agentIssues = {};
    for (const agent of state.agents) {
      const result = await syncAgentLinks({
        repositoryPath: state.repositoryPath,
        skills: scan.skills,
        agent,
        enabledSkillIds: state.enabledSkills[agent.id] || [],
      });
      agentIssues[agent.id] = result.issues;
      allIssues.push(...result.issues);
    }
    return buildState(state, {
      skills: scan.skills,
      issues: allIssues,
      agentIssues,
      emptyRepository: false,
    });
  }

  /**
   * 校验目标目录可以绑定给 Agent：不能与其他 Agent 目录重合，也不能与仓库互相包含。
   *
   * @param {object} state - 当前配置
   * @param {string} directory - 已规范化的目标目录
   * @throws {Error} 目录不安全或已被占用时抛出
   */
  function assertAgentDirectoryAvailable(state, directory) {
    for (const agent of state.agents) {
      if (pathsEqualLexical(agent.directory, directory))
        throw new Error(`该目录已由 Agent“${agent.name}”使用，请选择其他目录`);
    }
    if (state.repositoryPath && pathsOverlapLexical(state.repositoryPath, directory))
      throw new Error(
        "Agent Skills 目录不能与统一 Skills 仓库相同或互相包含，以免扫描和链接相互影响",
      );
  }

  /**
   * 校验目标目录可读（创建 Agent 前的探活）。
   * 目录允许包含其他内容（插件只管理指向仓库的链接），这里仅确认目录项可列出，
   * 让权限问题在创建阶段就暴露，而不是推迟到后续链接同步时才提示。
   *
   * @param {string} directory - 已规范化的目标目录
   * @throws {Error} 目录无法读取时抛出
   */
  async function assertDirectoryReadable(directory) {
    try {
      await fs.promises.readdir(directory);
    } catch (error) {
      throw new Error(`无法读取目录内容：${errorMessage(error)}`);
    }
  }

  /** 打开系统目录选择框；用户取消时返回空串。 */
  function chooseDirectory(defaultPath) {
    try {
      const result = utools.showOpenDialog({
        title: "选择目录",
        defaultPath: defaultPath || undefined,
        properties: ["openDirectory", "createDirectory"],
      });
      return result?.[0] || "";
    } catch (error) {
      throw new Error(`打开目录选择器失败：${errorMessage(error)}`);
    }
  }

  /** 读取本地配置与扫描缓存（不触发扫描或链接同步）。 */
  async function getState() {
    const { state, issues } = await readState();
    return buildState(state, { skills: state.cachedSkills, issues });
  }

  /**
   * 在系统文件管理器中打开一个目录。
   *
   * @param {string} directory - 待打开的目录
   * @throws {Error} 打开失败时抛出
   */
  function shellOpenDirectory(directory) {
    try {
      utools.shellOpenPath(directory);
    } catch (error) {
      throw new Error(`打开文件夹失败：${errorMessage(error)}`);
    }
  }

  /**
   * 在系统文件管理器中打开某个 Skill 所在文件夹（Skills 卡片双击时调用）。
   *
   * @param {string} skillId - Skill id（目录名）
   * @throws {Error} Skill 不在扫描缓存中或打开失败时抛出
   */
  async function openSkillFolder(skillId) {
    const { state } = await readState();
    const skill = state.cachedSkills.find((item) => item.id === skillId);
    if (!skill) throw new Error("未找到该 Skill，请重新扫描仓库后再试");
    shellOpenDirectory(skill.sourcePath);
  }

  /**
   * 在系统文件管理器中打开某个 Agent 的 Skills 目录（Agents 卡片按钮）。
   *
   * @param {string} agentId - Agent id
   * @throws {Error} Agent 不存在、目录已被移动或打开失败时抛出
   */
  async function openAgentFolder(agentId) {
    const { state } = await readState();
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("未找到该 Agent，请刷新后重试");
    if (!fs.existsSync(agent.directory))
      throw new Error(`Agent 目录不存在或已被移动：${agent.directory}`);
    shellOpenDirectory(agent.directory);
  }

  /** 保存主题设置。 */
  async function setTheme(theme) {
    const { state, issues } = await readState();
    state.theme = theme === "dark" ? "dark" : "light";
    await config.write(state);
    return buildState(state, { issues });
  }

  /**
   * 设置 Skills 仓库目录并执行首次扫描。
   *
   * 处理顺序：校验新目录 → 清理各 Agent 中指向旧仓库的链接 → 保存新路径 → 扫描并同步。
   * 新路径先落盘，保证界面显示的路径始终与本地配置一致（即使随后扫描失败）。
   */
  async function setRepository(repositoryPath) {
    const { state, issues } = await readState();
    const normalized = await normalizeDirectory(repositoryPath, "Skills 仓库目录");
    for (const agent of state.agents) {
      if (pathsOverlapLexical(normalized, agent.directory))
        throw new Error(
          `Skills 仓库不能与 Agent“${agent.name}”的目录相同或互相包含，请调整其中一个路径`,
        );
    }

    // 仓库变更时先清理旧仓库在 Agent 目录中留下的链接，避免切换后残留。
    if (
      state.repositoryPath &&
      !pathsEqualLexical(state.repositoryPath, normalized)
    ) {
      for (const agent of state.agents) {
        const removal = await removeManagedLinks(agent, {
          repositoryPath: state.repositoryPath,
        });
        issues.push(...removal.issues);
      }
    }
    state.repositoryPath = normalized;
    await config.write(state);

    const scan = await scanRepository(normalized);
    return refreshInternal(state, { issues, scan });
  }

  /** 重新扫描当前仓库；allowEmptyRepository 仅在用户确认仓库已清空后由界面传入。 */
  async function refresh(options = {}) {
    const { state, issues } = await readState();
    return refreshInternal(state, {
      allowEmptyRepository: options?.allowEmptyRepository === true,
      issues,
    });
  }

  /** 保存分组列表（分组只是选择模板，不影响任何链接）。重名分组会自动追加递增序号。 */
  async function saveGroups(groups) {
    const { state, issues } = await readState();
    if (!Array.isArray(groups)) throw new Error("分组数据格式无效");
    const validIds = new Set(state.cachedSkills.map((skill) => skill.id));
    const usedNames = new Set();
    let renamedCount = 0;
    const normalized = groups.map((group) => {
      const id = String(group?.id || "").trim();
      const name = String(group?.name || "").trim();
      if (!id) throw new Error("分组数据不完整，请重新创建该分组");
      if (!name) throw new Error("请输入分组名称");
      if (name.length > MAX_ENTITY_NAME_LENGTH)
        throw new Error(`分组名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
      if (!Array.isArray(group.skillIds))
        throw new Error(`分组“${name}”的 Skills 配置格式无效`);
      // 名称重复时自动追加递增序号（如“前端开发 (2)”），保证分组名称唯一。
      const finalName = uniqueEntityName(name, usedNames);
      if (finalName !== name) renamedCount += 1;
      usedNames.add(finalName);
      return {
        id,
        name: finalName,
        // 只保留当前扫描结果中仍存在的 Skill，避免保存失效引用。
        skillIds: [
          ...new Set(group.skillIds.map(String).filter(Boolean)),
        ].filter((skillId) => validIds.has(skillId)),
      };
    });
    if (new Set(normalized.map((group) => group.id)).size !== normalized.length)
      throw new Error("分组标识重复，请重新创建分组");
    if (renamedCount)
      issues.push(
        createIssue(
          "info",
          `有 ${renamedCount} 个分组名称重复，已自动添加序号区分。`,
        ),
      );
    state.groups = normalized;
    await config.write(state);
    return buildState(state, { issues });
  }

  /**
   * 新建 Agent：名称非空、目录存在且可读、目录未被占用且与仓库不重叠。
   * 目录中允许已有其他内容：插件只管理指向仓库的链接，普通文件与外部链接一律不碰。
   * 名称重复时自动追加递增序号；创建后 Agent 信息不可修改（避免目录迁移带来的
   * 链接清理风险），如需调整请删除后重新创建。
   */
  async function createAgent(input) {
    const { state, issues } = await readState();
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("请输入 Agent 名称");
    if (name.length > MAX_ENTITY_NAME_LENGTH)
      throw new Error(`Agent 名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
    const directory = await normalizeDirectory(
      input?.directory,
      "Agent Skills 目录",
    );
    assertAgentDirectoryAvailable(state, directory);
    await assertDirectoryReadable(directory);

    // 名称重复时自动追加递增序号（如“Codex (2)”），保证 Agent 名称唯一。
    const usedNames = new Set(state.agents.map((agent) => agent.name));
    const finalName = uniqueEntityName(name, usedNames);
    if (finalName !== name)
      issues.push(
        createIssue(
          "info",
          `Agent 名称“${name}”已存在，已自动重命名为“${finalName}”。`,
        ),
      );

    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.agents.push({ id, name: finalName, directory });
    state.enabledSkills[id] = [];
    await config.write(state);
    return buildState(state, { issues });
  }

  /** 删除 Agent：先清理其目录中由本插件创建的链接，再移除配置。 */
  async function deleteAgent(agentId) {
    const { state, issues } = await readState();
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("未找到要删除的 Agent，请刷新后重试");
    const removal = await removeManagedLinks(agent, {
      repositoryPath: state.repositoryPath,
    });
    issues.push(...removal.issues);
    state.agents = state.agents.filter((item) => item.id !== agentId);
    delete state.enabledSkills[agentId];
    await config.write(state);
    return buildState(state, { issues });
  }

  /**
   * 更新一个 Agent 的启用 Skills 并同步链接。
   * 目标状态先写入配置，再让磁盘链接向其收敛；同步失败时提示用户重试。
   */
  async function setAgentSkills(agentId, skillIds) {
    const { state, issues } = await readState();
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("未找到该 Agent，请刷新后重试");
    if (!state.repositoryPath) throw new Error("请先配置 Skills 仓库目录");
    if (!state.cachedSkills.length)
      throw new Error("请先在“Skills 仓库”页面完成目录扫描");

    const validIds = new Set(state.cachedSkills.map((skill) => skill.id));
    const requested = [
      ...new Set((Array.isArray(skillIds) ? skillIds : []).map(String)),
    ];
    const nextIds = requested.filter((skillId) => validIds.has(skillId));
    if (nextIds.length !== requested.length)
      issues.push(
        createIssue(
          "warning",
          "部分选择已失效并自动忽略，请重新扫描仓库后再试。",
        ),
      );

    state.enabledSkills[agentId] = nextIds;
    await config.write(state);
    const result = await syncAgentLinks({
      repositoryPath: state.repositoryPath,
      skills: state.cachedSkills,
      agent,
      enabledSkillIds: nextIds,
    });
    return buildState(state, {
      issues: [...issues, ...result.issues],
      agentIssues: { [agentId]: result.issues },
    });
  }

  /**
   * 清除本地数据：清理所有 Agent 目录中的受管链接并删除本地配置文件。
   * 统一仓库中的源文件不会被删除。
   */
  async function clearData() {
    const { state, issues: readIssues } = await readState();
    const issues = [...readIssues];
    for (const agent of state.agents) {
      const removal = await removeManagedLinks(agent, {
        repositoryPath: state.repositoryPath,
      });
      issues.push(...removal.issues);
    }
    await config.clear();
    return buildState(createDefaultState(), {
      skills: [],
      issues,
      emptyRepository: false,
    });
  }

  const api = {
    chooseDirectory,
    clearData,
    createAgent,
    deleteAgent,
    getState,
    openAgentFolder,
    openSkillFolder,
    refresh,
    saveGroups,
    setAgentSkills,
    setRepository,
    setTheme,
  };

  // 串行化策略：只读 / 同步方法直接暴露，其余（会改动配置或文件系统的方法）统一包一层
  // 队列。采用“白名单直通 + 其余自动串行”，新增写方法时不会漏包队列。
  const directMethods = new Set([
    "chooseDirectory", // 同步方法，返回字符串而不是 Promise，不能包成异步
    "getState",
    "openAgentFolder",
    "openSkillFolder",
  ]);
  for (const [name, method] of Object.entries(api)) {
    if (directMethods.has(name)) continue;
    api[name] = (...args) => serialize(() => method(...args));
  }
  return api;
}

module.exports = { createSkillsManagerApi };
