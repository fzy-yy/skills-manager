/**
 * preload 服务（window.skillsManager）的类型描述。
 *
 * 渲染层与 preload 之间只有这一份字符串契约，因此在类型层面集中声明：
 *  - 渲染层调用处可以获得补全与类型提示；
 *  - preload 侧改动返回结构时，这里是唯一需要同步的地方。
 *
 * 注意：字段与 public/preload/api.js 的 buildState 保持一致。
 */

/** 一个被识别出来的 Skill（来自仓库扫描）。 */
export interface SkillRecord {
  /** Skill id：仓库第一层子目录名，同时是 Agent 目录中的链接名与唯一标识 */
  id: string;
  /** SKILL.md 元数据中的 name（界面显示名） */
  name: string;
  /** 仓库中的绝对路径 */
  sourcePath: string;
}

export interface GroupRecord {
  id: string;
  name: string;
  skillIds: string[];
}

/** Agent 配置 Skills 的同步方式：符号链接或直接复制源文件。 */
export type AgentSyncMode = "symlink" | "copy";

export interface AgentRecord {
  id: string;
  name: string;
  directory: string;
  syncMode: AgentSyncMode;
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
  /** 仅当本次操作实际检查了仓库空状态时出现；省略表示保持上一次判定 */
  emptyRepository?: boolean;
  /** 按 Agent 归因的链接同步问题（全局问题仍位于 issues） */
  agentIssues?: Record<string, IssueRecord[]>;
  issues: IssueRecord[];
}

export interface SkillsManagerApi {
  /** 打开系统目录选择框；用户取消时返回空串 */
  chooseDirectory(defaultPath?: string): string;
  /** 只读取本地配置与扫描缓存，不触发扫描或链接同步 */
  getState(): Promise<SkillsManagerState>;
  /** 在系统文件管理器中打开某个 Skill 所在文件夹（Skills 卡片双击） */
  openSkillFolder(skillId: string): Promise<void>;
  /** 在系统文件管理器中打开某个 Agent 的 Skills 目录（Agents 卡片按钮） */
  openAgentFolder(agentId: string): Promise<void>;
  setTheme(theme: string): Promise<SkillsManagerState>;
  /** 设置仓库目录并扫描、同步所有 Agent 链接 */
  setRepository(repositoryPath: string): Promise<SkillsManagerState>;
  /** 重新扫描；allowEmptyRepository 为用户确认仓库已清空后清理失效记录 */
  refresh(options?: {
    allowEmptyRepository?: boolean;
  }): Promise<SkillsManagerState>;
  saveGroups(groups: GroupRecord[]): Promise<SkillsManagerState>;
  /** 新建 Agent；目录必须存在、可读且未被占用，创建后名称、目录与配置方式均不可修改 */
  createAgent(input: {
    name: string;
    directory: string;
    syncMode?: AgentSyncMode;
  }): Promise<SkillsManagerState>;
  deleteAgent(agentId: string): Promise<SkillsManagerState>;
  /** 更新一个 Agent 的启用 Skills 并同步链接 */
  setAgentSkills(
    agentId: string,
    skillIds: string[],
  ): Promise<SkillsManagerState>;
  /** 清理受管链接并删除本地配置 */
  clearData(): Promise<SkillsManagerState>;
}

declare global {
  interface Window {
    /** 仅在 uTools 中加载了 public/preload/services.js 后存在 */
    skillsManager?: SkillsManagerApi;
    /** uTools 注入的全局对象（浏览器预览时不存在） */
    utools?: {
      getPath(name: string): string;
      showOpenDialog(options: object): string[] | undefined;
      onPluginEnter(callback: () => void): void;
      onPluginOut(callback: (isKill: boolean) => void): void;
    };
  }
}
