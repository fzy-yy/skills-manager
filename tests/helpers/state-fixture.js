export const REQUIRED_STATE_KEYS = [
  "repositoryPath",
  "skills",
  "groups",
  "agents",
  "enabledSkills",
  "theme",
  "issues",
];

export const OPTIONAL_STATE_KEYS = ["emptyRepository", "agentIssues"];

export function createStateSnapshot(overrides = {}) {
  return {
    repositoryPath: "",
    skills: [],
    groups: [],
    agents: [],
    enabledSkills: {},
    theme: "light",
    issues: [],
    emptyRepository: false,
    ...overrides,
  };
}

export function assertStateContract(state) {
  if (!state || typeof state !== "object" || Array.isArray(state))
    throw new Error("状态必须是对象");
  const missingKeys = REQUIRED_STATE_KEYS.filter(
    (key) => !Object.hasOwn(state, key),
  );
  if (missingKeys.length)
    throw new Error(`状态缺少字段：${missingKeys.join(", ")}`);
  const allowedKeys = new Set([...REQUIRED_STATE_KEYS, ...OPTIONAL_STATE_KEYS]);
  const unknownKeys = Object.keys(state).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length)
    throw new Error(`状态包含未知字段：${unknownKeys.join(", ")}`);
  return state;
}
