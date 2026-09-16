/**
 * 链接同步结果的持久化与回滚。
 *
 * 这是全项目最需要小心的时序，单独成文件以便把顺序讲清楚。
 * 一次 refreshState 涉及"改配置"和"改磁盘链接"两类操作，二者不可能同时原子完成，
 * 因此用「先落检查点、再动文件、最后写终态」的顺序把风险收敛到最小：
 *
 *  ① refreshState 开头 writeConfig(config)          —— 业务目标（启用集合、分组）先落盘
 *  ② syncAgent 创建链接前 writeConfig（pending 记录）—— 待创建的链接先落盘为检查点
 *  ③ syncAgent 创建链接 / 删除链接                  —— 真正动文件系统
 *  ④ 本文件 writeConfig(config)                     —— 写终态（含文件标识）
 *
 * 于是任意时刻中断都只会有两种可收敛的状态：
 *  - 崩在 ③ 之前：磁盘上没有链接，配置里的 pending 记录会在下次同步时被识别并清理；
 *  - 崩在 ③ 之后：链接已存在，配置里仍有 pending 记录，下次同步会补记文件标识后继续管理。
 *
 * ④ 失败时的回滚原则：只回滚"本轮新建"的链接，并且只有在链接确实被移除时才丢弃记录
 * （否则保留记录，让下次同步继续按归属校验处理，避免链接脱离管理）。
 */
const { createIssue } = require("./runtime");

function createSyncPersistence({ writeConfig, removeOwnedLink }) {
  /**
   * 保存同步后的链接状态；保存失败时安全回滚本轮新建链接，并重试记录最终状态。
   *
   * @param {object} config - 当前完整配置
   * @param {object} syncResults - 本轮参与同步的 Agent 结果
   * @returns {Promise<Array>} 持久化或回滚期间产生的问题
   */
  async function persistSyncResults(config, syncResults) {
    const persistenceIssues = [];
    if (config._syncLocked) return persistenceIssues;
    try {
      await writeConfig(config);
    } catch (error) {
      const rollbackIssues = [];
      for (const agent of config.agents) {
        const createdLinks = syncResults[agent.id]?.createdLinks || [];
        for (const link of createdLinks) {
          const removal = await removeOwnedLink(
            link,
            `保存失败后的新建链接 ${link.linkPath}`,
            agent.directory,
          );
          rollbackIssues.push(...removal.issues);
          const syncResult = syncResults[agent.id];
          if (removal.relinquished) {
            delete agent.managedLinks[link.skillId];
            syncResult.linked = syncResult.linked.filter(
              (id) => id !== link.skillId,
            );
          } else if (removal.remainingLink) {
            // 链接已隔离到随机路径但未能删除：改用隔离路径继续追踪，
            // 该链接已不在预期位置，不再计入 linked。
            agent.managedLinks[link.skillId] = removal.remainingLink;
            syncResult.linked = syncResult.linked.filter(
              (id) => id !== link.skillId,
            );
          }
          // 其余情况（既未放弃管理、也没有隔离路径）说明链接仍留在原位置，
          // 保留记录与 linked，交由下次同步重试移除。
        }
      }
      try {
        await writeConfig(config);
        const detail = rollbackIssues.length
          ? `部分新建链接未能回滚，但其受管记录已保留：${rollbackIssues.map((issue) => issue.message).join("；")}`
          : "本轮新建链接已回滚，本地配置重试保存成功";
        persistenceIssues.push(
          createIssue("warning", `${error.message}；${detail}。`),
        );
      } catch (retryError) {
        const detail = rollbackIssues.length
          ? `；新建链接回滚存在问题：${rollbackIssues.map((issue) => issue.message).join("；")}`
          : "；本轮新建链接已回滚，其余状态将在下次启动时按安全检查点自动收敛";
        persistenceIssues.push(
          createIssue(
            "error",
            `${error.message}；重试保存仍失败：${retryError.message}${detail}`,
          ),
        );
      }
    }
    return persistenceIssues;
  }

  return { persistSyncResults };
}

module.exports = { createSyncPersistence };
