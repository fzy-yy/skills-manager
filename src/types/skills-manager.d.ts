/**
 * preload 服务（window.skillsManager）的类型描述。
 *
 * 渲染层与 preload 之间只有这一份字符串契约，因此把方法与返回结构写在这里：
 *  - 渲染层调用处可获得补全与类型提示；
 *  - preload 侧改动返回结构时，这里是唯一需要同步的地方。
 *
 * 注意：字段与 public/preload/state-service.js 的 buildState 保持一致。
 */

/** 一个被识别出来的 Skill（来自仓库扫描）。 */
export interface SkillRecord {
  /** 仓库相对路径（使用 / 分隔），同时作为 Skill 的唯一标识 */
  id: string;
  /** SKILL.md 元数据中的 name */
  name: string;
  relativePath: string;
  /** 目录名，决定链接在 Agent 目录中的名字 */
  folderName: string;
  /** 仓库中的绝对路径 */
  sourcePath: string;
}

export interface GroupRecord {
  id: string;
  name: string;
  skillIds: string[];
}

export interface AgentRecord {
  id: string;
  name: string;
  directory: string;
}

export interface IssueRecord {
  type: "error" | "warning" | "info";
  message: string;
}

/** 一次操作或一次状态读取后返回给渲染层的完整状态。 */
export interface SkillsManagerState {
  repositoryPath: string;
  skills: SkillRecord[];
  groups: GroupRecord[];
  agents: AgentRecord[];
  /** Agent id → 已启用的 Skill id 列表 */
  enabledSkills: Record<string, string[]>;
  theme: "light" | "dark";
  /** 仅当本次操作实际检查仓库空状态时出现；省略表示保持上一次判定 */
  emptyRepository?: boolean;
  /** 定向同步时按 Agent 归因的问题；全局问题仍位于 issues */
  agentIssues?: Record<string, IssueRecord[]>;
  issues: IssueRecord[];
}

export interface SkillsManagerApi {
  /** 打开系统目录选择框；用户取消时返回空串 */
  chooseDirectory(defaultPath?: string): string;
  /** 只读取本地配置与扫描缓存，不触发扫描或链接同步 */
  getState(): Promise<SkillsManagerState>;
  setTheme(
    theme: string,
  ): Promise<{ theme: "light" | "dark"; issues: IssueRecord[] }>;
  setRepository(repositoryPath: string): Promise<SkillsManagerState>;
  refreshSkills(options?: {
    allowEmptyRepository?: boolean;
  }): Promise<SkillsManagerState>;
  saveGroups(groups: GroupRecord[]): Promise<SkillsManagerState>;
  upsertAgent(input: {
    id?: string;
    name: string;
    directory: string;
  }): Promise<SkillsManagerState>;
  deleteAgent(agentId: string): Promise<SkillsManagerState>;
  clearData(): Promise<SkillsManagerState>;
  setAgentSkills(
    agentId: string,
    skillIds: string[],
  ): Promise<SkillsManagerState>;
  /** 同步记录最后一次开关选择，确保进程立即结束后仍可恢复 */
  recordPendingSkillSync(
    agentId: string,
    skillIds: string[],
    token: string,
  ): { ok: boolean; issue?: IssueRecord | null };
  readPendingSkillSync(): {
    ok: boolean;
    records: Array<{
      id: string;
      skillIds: string[];
      token: string;
      updatedAt: string;
    }>;
    issue?: IssueRecord | null;
  };
  /** agentId 省略时清空全部待同步意图 */
  clearPendingSkillSync(
    agentId?: string,
    token?: string,
  ): { ok: boolean; issue?: IssueRecord | null };
}

declare global {
  interface Window {
    /** 仅在 uTools 中加载了 public/preload/services.js 时存在 */
    skillsManager?: SkillsManagerApi;
  }
}
