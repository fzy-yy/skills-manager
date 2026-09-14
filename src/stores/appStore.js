/**
 * 全局状态仓库（Pinia + 组合式 API 写法）。
 *
 * 该仓库是前端与 uTools 预加载服务之间唯一的桥梁：
 *  - 所有本地文件操作、uTools API 调用都通过 window.skillsManager（public/preload/services.js 暴露）；
 *  - 所有页面共享同一份状态（仓库路径、Skills、分组、Agent、启用关系、主题）；
 *  - 统一承担“操作中”标记、全局提示与确认对话框，避免每个页面重复实现。
 *
 * 约定：凡是会改动配置或文件系统的动作，都返回 Promise，
 * 页面可通过 await 或 try/catch 感知执行结果（失败信息已由本仓库统一提示）。
 *
 * 并发与一致性设计（改动本文件前请先读完以下三点）：
 *  1. 文件与数据库操作全局串行（operationInFlight）：链接同步会读写同一批目录，
 *     并发的两轮同步各自基于旧快照计算增删，最终会留下无法追踪的残留链接；
 *  2. 应用配置开关属于高频操作，采用「乐观更新 + 300ms 防抖合并 + 失败回滚」，
 *     只把每个 Agent 的最终选择提交一次，避免快速连点产生大量磁盘写入与界面卡顿；
 *  3. 服务端的只读保护（数据库配置异常时禁止一切写操作）由 preload 抛错体现，
 *     本仓库不自行拦截，只把错误提示给用户并在必要时回滚界面状态。
 */

// Vue 响应式 API：ref 定义状态，computed 定义派生状态。
import { computed, ref } from "vue";
// Pinia 的组合式仓库定义函数。
import { defineStore } from "pinia";

// 仓库采用 Pinia 组合式（setup）写法：状态用 ref、派生用 computed，
// 与页面里的 <script setup> 保持一致，方便把逻辑抽成可复用的普通函数。
// Pinia 统一管理业务数据、主题、全局提示与确认对话框。
export const useAppStore = defineStore("app", () => {
  // ---------- 业务状态 ----------
  // 这些 ref 是页面唯一的数据来源：页面只读消费，写入必须通过下方导出的动作方法，
  // 从而保证「改动状态」与「持久化 + 链接同步」始终成对发生。
  // 统一 Skills 仓库目录的绝对路径，空字符串表示尚未配置。
  const repositoryPath = ref("");
  // 仓库扫描结果，元素形如 { id, name, relativePath, folderName, sourcePath }。
  const skills = ref([]);
  // 分组列表，元素形如 { id, name, skillIds }。
  const groups = ref([]);
  // Agent 列表；后端返回的是精简后的公开字段（含链接数量统计）。
  const agents = ref([]);
  // 每个 Agent 已启用的 Skills：{ [agentId]: skillId[] }，是应用配置的唯一真值。
  const enabledSkills = ref({});
  // 每个 Agent 最近一次链接同步产生的问题；应用配置页以内联方式聚合展示，避免通知刷屏。
  const agentSyncIssues = ref({});
  // 当前主题，取值 'light' 或 'dark'。
  const theme = ref("light");
  // 是否已完成首次初始化（读取本地配置），用于避免首屏空白闪烁。
  const ready = ref(false);
  // 是否有耗时操作正在进行，用于禁用按钮、显示顶部进度条。
  const busy = ref(false);
  // 全局提示列表，元素形如 { id, message, type }。
  const notices = ref([]);
  // 全局确认对话框的显示状态与文案。
  const dialog = ref({
    open: false,
    title: "",
    message: "",
    confirmText: "确定",
    cancelText: "取消",
    tone: "primary",
  });

  // 提示自增序号，保证每条提示都有唯一 key。
  let noticeSequence = 0;
  // 提示 id 与自动关闭定时器的映射，手动关闭时需要一并清理定时器。
  const noticeTimers = new Map();
  // 确认对话框的 resolve 函数，由 confirm() 赋值、resolveDialog() 调用。
  let dialogResolver;
  // 文件与数据库操作必须串行，避免快速重复点击产生两轮相互覆盖的链接同步。
  let operationInFlight = false;
  // 应用配置开关使用短防抖合并；快速开关回到原状态时不会触碰数据库或链接。
  // 待提交队列：agentId → { baseSkillIds, skillIds, waiters }；
  // baseSkillIds 是入队时的原始选择，用于判断「是否真的变化」以及提交失败后的回滚。
  const pendingSkillSyncs = new Map();
  // 防抖定时器句柄：为 undefined 表示当前没有排队中的提交。
  let skillSyncTimer;
  // 是否正在把某项变更提交给 preload，避免同一个 flush 被重入导致同一 Agent 重复落库。
  let skillSyncFlushing = false;
  // 云端数据库拉取事件可能连续触发；这里只保留一次延迟刷新，且等待本地写操作完全空闲。
  let externalRefreshTimer;
  let unsubscribeDataChanged;
  // 300ms 足以合并「连续勾选多个 Skill」与「误触后立即改回」，
  // 又短到用户不会觉得开关响应迟滞；调大或调小都会在流畅性与即时性之间失衡。
  const SKILL_SYNC_DEBOUNCE_MS = 300;

  // ---------- 派生状态 ----------
  // 派生状态只供界面做条件渲染与统计，不参与持久化，因此不提供写入方法。
  // 是否已经配置过统一 Skills 仓库目录。
  const hasRepository = computed(() => Boolean(repositoryPath.value));

  // ---------- 内部工具 ----------
  /**
   * 获取 preload 暴露的本地能力对象。
   * 只有在 uTools 环境中（加载了 public/preload/services.js）才存在 window.skillsManager。
   *
   * @returns {object} window.skillsManager 实例
   * @throws {Error} 未在 uTools 环境运行时抛出可读错误，由调用方提示用户
   */
  function api() {
    if (!window.skillsManager)
      throw new Error("请在 uTools 开发环境中运行插件以使用本地目录功能");
    return window.skillsManager;
  }

  /** 让出一个宏任务，使 Vue 有机会先绘制忙碌状态和进度条。 */
  // 为什么不能省：preload 的大量文件操作会在同一个事件循环里接连 await，
  // 不让出一次宏任务，界面在扫描期间会完全静止，用户会误以为插件卡死。
  function waitForRender() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ---------- 状态同步 ----------
  // 所有服务端结果都先经 applyState 收敛到本地状态，页面不再各自解析接口返回值。
  /**
   * 将后端（preload 服务）返回的状态增量合并到本地响应式状态。
   * 未出现在 next 中的字段保持原值不变。
   *
   * @param {object} next - 形如 { repositoryPath, skills, groups, agents, enabledSkills, theme, issues }
   */
  function applyState(next) {
    // 部分接口（例如主题切换）只返回变更字段，避免无关状态被意外清空。
    // 这里用 Object.hasOwn 而不是真值判断：空字符串、空数组同样是有效的新状态。
    if (Object.hasOwn(next, "repositoryPath"))
      repositoryPath.value = next.repositoryPath || "";
    if (Object.hasOwn(next, "skills"))
      skills.value = Array.isArray(next.skills) ? next.skills : [];
    if (Object.hasOwn(next, "groups"))
      groups.value = Array.isArray(next.groups) ? next.groups : [];
    if (Object.hasOwn(next, "agents")) {
      agents.value = Array.isArray(next.agents) ? next.agents : [];
      const validAgentIds = new Set(agents.value.map((agent) => agent.id));
      agentSyncIssues.value = Object.fromEntries(
        Object.entries(agentSyncIssues.value).filter(([agentId]) =>
          validAgentIds.has(agentId),
        ),
      );
    }
    // enabledSkills 是应用配置的唯一真值：Agent 目录下的受管链接完全由它推导，
    // 因此合并要格外小心，不能让服务端返回的旧值覆盖用户刚点下的选择。
    if (Object.hasOwn(next, "enabledSkills")) {
      const mergedEnabledSkills = { ...(next.enabledSkills || {}) };
      // 服务端状态回写时保留尚在防抖窗口内的乐观选择，避免开关视觉回跳。
      pendingSkillSyncs.forEach((pending, agentId) => {
        mergedEnabledSkills[agentId] = [...pending.skillIds];
      });
      enabledSkills.value = mergedEnabledSkills;
    }
    if (Object.hasOwn(next, "theme"))
      theme.value = next.theme === "dark" ? "dark" : "light";
    // 主题以 <html class="dark"> 为开关，与 src/main.css 中的 .dark 令牌对应。
    document.documentElement.classList.toggle("dark", theme.value === "dark");
  }

  // ---------- 全局提示 ----------
  // 提示是非阻断的反馈渠道：重要但不该打断操作，因此多条同时展示、各自倒计时后关闭。
  /**
   * 手动关闭一条提示，并清除其自动关闭定时器。
   *
   * @param {number} id - 提示的唯一编号
   */
  function dismissNotice(id) {
    notices.value = notices.value.filter((notice) => notice.id !== id);
    // 定时器必须同步清理：否则被提前关闭的提示会留下空转的回调，长时间运行后不断累积。
    clearTimeout(noticeTimers.get(id));
    noticeTimers.delete(id);
  }

  /**
   * 推送一条全局提示；多条提示会同时展示，互不覆盖。
   *
   * @param {string} message - 提示文本，为空时忽略
   * @param {'success'|'error'|'warning'|'info'} [type='success'] - 提示类型，决定配色与图标
   * @param {number} [duration=5200] - 自动关闭时间（毫秒），错误类型会被强制延长
   */
  function notify(message, type = "success", duration = 5200) {
    if (!message) return;
    // 统一转成字符串再比较，避免数字、对象等异常入参让去重判断失效。
    const normalizedMessage = String(message);
    // 后台一致性校验可能重复发现同一问题；相同提示只保留一条，避免大量 DOM 与定时器堆积。
    if (
      notices.value.some(
        (notice) =>
          notice.message === normalizedMessage && notice.type === type,
      )
    )
      return;
    // 全局提示设置硬上限，异常链接很多时也不会拖慢渲染。
    while (notices.value.length >= 20) dismissNotice(notices.value[0].id);
    // id 单调递增：提示可被手动关闭，用数组下标做 :key 会让 Vue 复用错的节点。
    const id = ++noticeSequence;
    notices.value.push({ id, message: normalizedMessage, type });
    // 错误保留更久；多条问题会同时展示，避免后一个提示覆盖前一个错误。
    const timeout = type === "error" ? Math.max(duration, 9000) : duration;
    noticeTimers.set(
      id,
      setTimeout(() => dismissNotice(id), timeout),
    );
  }

  /**
   * 批量展示 preload 服务返回的问题列表（issues）。
   * 这些问题来自目录扫描、链接同步等底层操作，属于“操作成功但有异常”的场景。
   *
   * @param {Array<{type?: string, message: string}>} issues - 问题列表
   * @returns {Array} 原样返回入参，便于调用方继续判断是否包含 error
   */
  function reportIssues(issues) {
    const safeIssues = Array.isArray(issues) ? issues : [];
    // notify 自带同文案去重，重复出现的同类问题不会刷屏，也不会拖慢渲染。
    safeIssues.forEach((issue) =>
      notify(issue?.message, issue?.type || "warning"),
    );
    return safeIssues;
  }

  /** 保存指定 Agent 最近一次同步的问题，空数组表示本轮已恢复正常。 */
  function setAgentSyncIssues(agentId, issues) {
    const normalized = (Array.isArray(issues) ? issues : []).filter(
      (issue) => issue?.message && ["error", "warning"].includes(issue.type),
    );
    agentSyncIssues.value = {
      ...agentSyncIssues.value,
      [agentId]: normalized,
    };
  }

  // ---------- 统一操作封装 ----------
  // 所有会触碰文件系统或数据库的动作都从这里走，避免每个页面重复实现
  // 「置忙 → 提示 → 回滚」三件事，也保证串行锁不会被漏掉。
  /**
   * 统一执行一次“可能改动本地状态”的业务操作。
   * 负责：置忙 → 调用接口 → 合并状态 → 展示问题 → 展示成功提示 → 异常兜底。
   *
   * @param {() => Promise<object>} operation - 实际调用 preload 服务的函数
   * @param {string} [successMessage] - 成功提示文案；若存在 error 级问题则不提示成功
   * @param {{reportResultIssues?: boolean}} [options] - 是否逐条展示服务端返回的问题
   * @returns {Promise<object>} preload 服务返回的最新状态
   */
  async function execute(
    operation,
    successMessage,
    { reportResultIssues = true } = {},
  ) {
    // 并发守卫：宁可让后一次点击立刻失败并提示，也不能让两轮链接同步交叉执行。
    if (operationInFlight) {
      const error = new Error("已有操作正在进行，请等待完成后再试");
      notify(error.message, "warning");
      throw error;
    }
    operationInFlight = true;
    busy.value = true;
    try {
      // preload 调用前先让界面完成一次更新，即使底层偶发变慢也能看到明确的处理中状态。
      await waitForRender();
      // 具体调用由上层传入（preload 服务），失败时抛出的是带中文说明的 Error。
      const result = await operation();
      // 大多数接口返回最新全量状态，applyState 按字段合并，不会误清空其他数据。
      if (result) applyState(result);
      // issues 表示「执行成功但存在异常」（例如某个链接被外部改动过）：
      // 与抛错不同，这类问题只提示，不阻断后续流程。
      const issues = Array.isArray(result?.issues) ? result.issues : [];
      if (reportResultIssues) reportIssues(issues);
      // 存在 error 级问题时不再提示成功，避免“成功”与“失败”同时出现造成误导。
      if (successMessage && !issues.some((issue) => issue?.type === "error"))
        notify(successMessage);
      return result;
    } catch (error) {
      // 直接展示 preload 抛出的中文文案，比包装成通用提示更利于定位问题。
      notify(error?.message || "操作失败，请重试", "error");
      // 继续向上抛出，交给调用方决定是否中断后续流程。
      throw error;
    } finally {
      // 无论成功还是失败都必须释放串行锁与忙碌状态，否则后续所有操作会被永久拒绝。
      operationInFlight = false;
      busy.value = false;
    }
  }

  // ---------- 应用配置开关合并 ----------
  // 这一分区解决的核心问题是「高频开关 + 慢速磁盘」：开关动作不直接落库，
  // 而是先更新界面，再把各 Agent 的最终选择合并成一次提交。
  /** 规范化 Skill id 数组，便于比较最终选择是否真正发生变化。 */
  // 顺序与重复项都不影响磁盘上的链接集合，因此先转字符串、再去重排序，
  // 这样「A、B」与「B、A、A」会被认定为同一次选择，避免多余写入。
  function normalizeSkillIds(skillIds) {
    return [
      ...new Set(Array.isArray(skillIds) ? skillIds.map(String) : []),
    ].sort();
  }

  /** 判断两个 Skill 选择是否等价。 */
  // 只有长度与逐项都相同才算「没有变化」；返回 true 时调用方会跳过 preload 调用。
  function skillIdsEqual(left, right) {
    const normalizedLeft = normalizeSkillIds(left);
    const normalizedRight = normalizeSkillIds(right);
    return (
      normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((id, index) => id === normalizedRight[index])
    );
  }

  /** 安排下一次防抖提交；其他业务操作进行中时稍后自动重试。 */
  // 每次都重置定时器，所以连续切换只会触发一次真正的提交（合并等待者）。
  // 延时参数用于「其他操作进行中」时的退避重试，见 flushPendingSkillSyncs。
  function scheduleSkillSync(delay = SKILL_SYNC_DEBOUNCE_MS) {
    clearTimeout(skillSyncTimer);
    skillSyncTimer = setTimeout(() => {
      skillSyncTimer = undefined;
      void flushPendingSkillSyncs();
    }, delay);
  }

  /** 顺序提交各 Agent 的最终 Skill 状态，确保不会与其他文件操作并发。 */
  // 每次只提交一个 Agent：setAgentSkills 会刷新整份状态，逐个提交既能合并同一 Agent 的
  // 连续选择，也不会长时间占住串行锁导致页面其他按钮一直不可用。
  async function flushPendingSkillSyncs() {
    // 队列为空时直接返回，定时器回调可以安全空转。
    if (!pendingSkillSyncs.size) return;
    // 已有文件操作在跑（或本函数正被重入）时退避重试，避免两轮同步交叉覆盖。
    if (skillSyncFlushing || operationInFlight) {
      scheduleSkillSync(100);
      return;
    }
    // 先出队再提交：提交期间用户的新选择会重新入队，下一轮会以最新终态提交。
    const [agentId, pending] = pendingSkillSyncs.entries().next().value;
    pendingSkillSyncs.delete(agentId);
    skillSyncFlushing = true;
    try {
      // 开关属于高频操作：静默处理成功与逐 Skill 检查结果，避免右下角提示堆积。
      // 接口直接抛出的致命错误仍由 execute 统一展示一条错误提示。
      const result = await execute(
        () => api().setAgentSkills(agentId, pending.skillIds),
        undefined,
        { reportResultIssues: false },
      );
      // 高频开关不弹逐项通知，但错误不能静默；由应用配置页集中展示本轮结果。
      setAgentSyncIssues(agentId, result?.issues);
      // 同一个 Agent 在防抖窗口内的多次调用共享一个 Promise，全部等待者一起完成。
      pending.waiters.forEach(({ resolve }) => resolve(result));
    } catch (error) {
      // 没有更新的同 Agent 请求时才回滚乐观状态，避免覆盖用户刚做出的新选择。
      // 回滚目标是入队时记录的 baseSkillIds（此时 enabledSkills 已被乐观更新改写）。
      if (!pendingSkillSyncs.has(agentId)) {
        enabledSkills.value = {
          ...enabledSkills.value,
          [agentId]: [...pending.baseSkillIds],
        };
      }
      setAgentSyncIssues(agentId, [
        { type: "error", message: error?.message || "链接同步失败，请重试" },
      ]);
      // 拒绝等待者，让页面里的 await 能感知失败；错误文案已由 execute 全局提示过。
      pending.waiters.forEach(({ reject }) => reject(error));
    } finally {
      skillSyncFlushing = false;
      // 队列里还有别的 Agent 时立即安排下一轮（0ms 即下一个宏任务），
      // 既不会饿死排队请求，也让界面在两轮提交之间有渲染机会。
      if (pendingSkillSyncs.size) scheduleSkillSync(0);
    }
  }

  /**
   * 乐观更新 Skill 集合，并把防抖窗口内的多次切换合并成一次最终提交。
   * 若最终选择回到提交前状态，则直接完成等待，不调用 preload。
   *
   * 设计原因：应用配置页的开关是高频操作，每次点击都立刻落库会产生大量磁盘写入
   * （链接同步要逐个创建或删除目录链接），界面也会因为反复等待 I/O 而卡顿。
   *
   * @param {string} agentId - 目标 Agent id
   * @param {Array<string>} skillIds - 目标启用集合（完整覆盖，不是增量）
   * @returns {Promise<object|null>} 落库后的服务端状态；终态与提交前相同（无需落库）时为 null
   */
  function setAgentSkillsDebounced(agentId, skillIds) {
    const normalizedIds = normalizeSkillIds(skillIds);
    // baseSkillIds 只在首次入队时记录：它是「是否真的发生变化」与失败回滚的共同基准。
    let pending = pendingSkillSyncs.get(agentId);
    if (!pending) {
      pending = {
        baseSkillIds: normalizeSkillIds(enabledSkills.value[agentId]),
        skillIds: normalizedIds,
        waiters: [],
      };
      pendingSkillSyncs.set(agentId, pending);
    } else pending.skillIds = normalizedIds;

    // 乐观更新：先改界面让开关立即响应；服务端回写或失败回滚时再修正为真实状态。
    enabledSkills.value = {
      ...enabledSkills.value,
      [agentId]: [...normalizedIds],
    };

    // 每次调用都返回一个 Promise，页面可以 await 到「本次合并提交」的结果。
    const completion = new Promise((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
    // 终态与提交前一致（快速开→关回到原点）时，直接完成等待并撤销排队，
    // 完全不触碰数据库与磁盘链接，这正是防抖合并带来的收益。
    if (skillIdsEqual(pending.baseSkillIds, normalizedIds)) {
      pendingSkillSyncs.delete(agentId);
      pending.waiters.forEach(({ resolve }) => resolve(null));
      // 队列已空就取消定时器，避免留下没有意义的空转回调。
      if (!pendingSkillSyncs.size) clearTimeout(skillSyncTimer);
      else scheduleSkillSync();
    } else scheduleSkillSync();
    return completion;
  }

  /** 取消指定 Agent 尚未落库的开关请求，用于删除 Agent 前收敛前端状态。 */
  // 必须做这一步：若不取消，延迟任务会在 Agent 已被删除后再次调用 setAgentSkills，
  // 服务端会以「未找到该 Agent」失败，用户会看到莫名其妙的报错。
  function cancelPendingAgentSkills(agentId) {
    const pending = pendingSkillSyncs.get(agentId);
    if (!pending) return;
    // 取消意味着本轮选择永远不会落库，必须恢复入队前的真实值，避免删除/清除失败后留下假状态。
    enabledSkills.value = {
      ...enabledSkills.value,
      [agentId]: [...pending.baseSkillIds],
    };
    // 等待者以 null 完成（表示「不必再提交」），不抛错，避免打断删除或清除流程。
    pendingSkillSyncs.delete(agentId);
    pending.waiters.forEach(({ resolve }) => resolve(null));
    if (!pendingSkillSyncs.size) clearTimeout(skillSyncTimer);
  }

  /** 清除所有尚未落库的开关请求，避免清除数据后又被延迟任务恢复。 */
  // 先取 key 的副本再遍历，因为 cancelPendingAgentSkills 会就地删除 Map 中的条目。
  function cancelAllPendingAgentSkills() {
    [...pendingSkillSyncs.keys()].forEach(cancelPendingAgentSkills);
  }

  // ---------- 确认对话框 ----------
  // 只用于不可逆操作（删除 Agent、清除数据），普通增删改不需要二次确认。
  /**
   * 弹出全局确认对话框，并等待用户选择结果。
   *
   * @param {{title?: string, message?: string, confirmText?: string, cancelText?: string, tone?: 'primary'|'danger'}} options
   * @returns {Promise<boolean>} true 表示用户点了确认，false 表示取消或关闭
   */
  // 返回 Promise，让业务页面可以用统一方式等待用户选择。
  // 全局只有一份对话框实例，由 App.vue 的 ConfirmDialog 渲染，页面无需自建弹窗。
  function confirm(options) {
    // 若上一个对话框尚未收尾，先按“取消”处理，避免 Promise 永远挂起。
    if (dialogResolver) dialogResolver(false);
    // 未传的字段统一走默认值，保证对话框不会出现空白按钮或空标题。
    dialog.value = {
      open: true,
      title: options.title || "请确认",
      message: options.message || "",
      confirmText: options.confirmText || "确定",
      cancelText: options.cancelText || "取消",
      tone: options.tone || "primary",
    };
    return new Promise((resolve) => {
      dialogResolver = resolve;
    });
  }

  /**
   * 结束当前确认对话框，并回传用户选择。
   * 由 App.vue 中的 ConfirmDialog 通过 resolve 事件调用。
   *
   * @param {boolean} accepted - 是否点击了确认按钮
   */
  function resolveDialog(accepted) {
    // 先关弹窗再回传结果：用户可以重复点击按钮，而 Promise 只允许被 resolve 一次。
    dialog.value.open = false;
    dialogResolver?.(accepted);
    dialogResolver = null;
  }

  // ---------- 初始化与主题 ----------
  // 初始化只读数据库缓存、主题切换只写数据库：两者都不依赖仓库在线，保证插件随时可用。
  /**
   * 插件启动时读取 uTools 本地数据库中的配置，并同步到界面。
   * 未运行在 uTools 环境时退化为浅色主题，保证在浏览器预览时仍可用。
   */
  async function initialize() {
    // 启动分两步：先只读数据库缓存（很快）完成首屏绘制，再异步做一致性校验，
    // 这样即使仓库很大、磁盘很慢，窗口也不会卡在空白加载态。
    let needsReconcile = false;
    try {
      // 浏览器预览（vite dev 直接打开页面）没有 preload，此时跳过读取。
      if (window.skillsManager) {
        // getState 不扫描仓库、不改链接，只把上次完整扫描的缓存返回给界面。
        const result = await api().getState();
        applyState(result);
        reportIssues(result?.issues);
        // 全新环境（没有仓库也没有 Agent）没有必要去扫磁盘，省掉一次后台开销。
        needsReconcile = Boolean(
          result?.repositoryPath ||
            result?.groups?.length ||
            result?.agents?.length,
        );
        // 其他设备同步数据库后，等待本地操作空闲再读取并收敛链接；连续事件会自动合并。
        if (!unsubscribeDataChanged && api().onDataChanged) {
          unsubscribeDataChanged = api().onDataChanged(() =>
            scheduleExternalRefresh(),
          );
        }
      }
      // 非 uTools 环境没有持久化能力，强制使用浅色主题，避免残留 class。
      else document.documentElement.classList.remove("dark");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      // 无论成功失败都标记为已初始化，避免页面一直停留在加载态。
      ready.value = true;
    }
    // 首屏缓存状态已经绘制后，再异步检查仓库和链接；失败由 execute 统一提示。
    if (needsReconcile && api().reconcile) {
      try {
        // 这一步才会真正扫描仓库并同步受管链接；耗时较长，因此放在首屏之后。
        await execute(() => api().reconcile());
      } catch (_) {}
      // 失败（例如只读保护、仓库被移走）已由 execute 统一提示，这里静默吞掉即可，
      // 否则会在控制台留下未处理的 Promise 拒绝。
    }
  }

  /** 在本地队列空闲后应用其他设备同步来的配置，避免覆盖正在编辑的乐观状态。 */
  function scheduleExternalRefresh(delay = 250) {
    clearTimeout(externalRefreshTimer);
    externalRefreshTimer = setTimeout(async () => {
      if (operationInFlight || skillSyncFlushing || pendingSkillSyncs.size) {
        scheduleExternalRefresh(300);
        return;
      }
      try {
        await execute(() => api().reconcile());
      } catch (_) {
        // execute 已提供明确错误提示；这里仅防止事件回调产生未处理的 Promise 拒绝。
      }
    }, delay);
  }

  /**
   * 切换主题：先乐观更新界面，再持久化到 uTools 本地数据库；失败时回滚。
   *
   * @param {'light'|'dark'} nextTheme - 目标主题
   * @returns {Promise<boolean>} 是否保存成功
   */
  async function setTheme(nextTheme) {
    // 非法取值直接忽略，避免把异常主题写进数据库后持久污染界面。
    if (nextTheme !== "light" && nextTheme !== "dark") return false;
    // 记录旧值，用于写入失败（如只读保护）时回滚。
    const previousTheme = theme.value;
    // 立即生效，避免等待磁盘写入造成界面迟滞。
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    theme.value = nextTheme;
    try {
      // 浏览器预览环境没有 preload，只切换界面主题，不做持久化。
      if (window.skillsManager) await execute(() => api().setTheme(nextTheme));
      return true;
    } catch (error) {
      // 保存失败时回滚到切换前的主题，保持界面与数据库一致。
      theme.value = previousTheme;
      document.documentElement.classList.toggle(
        "dark",
        previousTheme === "dark",
      );
      notify(error.message, "error");
      return false;
    }
  }

  /**
   * 在浅色与深色之间切换主题（供设置页或快捷键使用）。
   *
   * @returns {Promise<boolean>} 是否保存成功
   */
  // 只负责决定目标主题，乐观更新与失败回滚全部复用 setTheme。
  function toggleTheme() {
    return setTheme(theme.value === "dark" ? "light" : "dark");
  }

  // ---------- 对外暴露 ----------
  // 状态与纯本地方法直接导出；所有会触碰文件系统或数据库的动作都包一层 execute()，
  // 以获得统一的忙碌状态、错误提示与状态回写。
  return {
    repositoryPath,
    skills,
    groups,
    agents,
    enabledSkills,
    agentSyncIssues,
    theme,
    ready,
    busy,
    notices,
    dialog,
    // 状态与纯本地方法按原名导出，页面可直接以 store.xxx 消费（只读使用）。
    hasRepository,
    initialize,
    setTheme,
    toggleTheme,
    notify,
    confirm,
    resolveDialog,
    // 关闭单条提示（App.vue 的提示卡片关闭按钮会调用）。
    dismissNotice,
    // 打开系统目录选择框，仅返回路径，不修改任何配置，因此无需 execute 包装。
    chooseDirectory: (current) => api().chooseDirectory(current),
    // 设置统一 Skills 仓库目录，成功后服务端会重新扫描并同步链接。
    setRepository: (directory) =>
      execute(() => api().setRepository(directory), "Skills 仓库已更新"),
    // 重新扫描仓库目录（不修改仓库路径）。
    refreshSkills: () =>
      execute(() => api().refreshSkills(), "已重新扫描 Skills"),
    // 保存分组列表（新增、改名、增删 Skills 均复用该接口）。
    saveGroups: (nextGroups) =>
      execute(() => api().saveGroups(nextGroups), "分组已保存"),
    // 新增或更新 Agent（携带 id 表示更新）。
    upsertAgent: (agent) =>
      execute(
        () => api().upsertAgent(agent),
        agent.id ? "Agent 已更新" : "Agent 已添加",
      ),
    // 删除 Agent，同时清理本应用在其目录创建的链接。
    // 先取消该 Agent 尚未落库的开关请求，否则延迟任务会在 Agent 已删除后再提交而失败。
    deleteAgent: (id) => {
      cancelPendingAgentSkills(id);
      return execute(
        () => api().deleteAgent(id),
        "Agent 已删除，相关链接已清理",
      );
    },
    // 清除 uTools 本地数据库配置（保留仓库中的源文件）。
    // 同样要先取消全部排队请求，否则清空后会被延迟任务把旧配置重新写回数据库。
    clearData: () => {
      cancelAllPendingAgentSkills();
      return execute(() => api().clearData(), "本地数据已清除");
    },
    // 设置某个 Agent 启用的 Skills，分组与单项开关统一复用该入口。
    // 注意暴露的是防抖版本：页面连续调用只会产生一次最终落库（见上文合并逻辑）。
    setAgentSkills: setAgentSkillsDebounced,
  };
});
