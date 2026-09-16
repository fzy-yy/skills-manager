/**
 * 分组编辑草稿：选中项、名称与勾选 Skills 的状态机。
 *
 * 从 GroupsView 抽出的原因：这套状态机（临时 id、脏检查、切换确认、保存映射）
 * 与模板无关，独立后视图只剩展示职责，状态机也能脱离组件单独阅读。
 */
import { computed, ref, watch } from "vue";
import { useAppStore } from "../stores/appStore";

export function useGroupDraft() {
  const store = useAppStore();
  const selectedId = ref("");
  const draftName = ref("");
  const draftSkills = ref([]);
  const selectedGroup = computed(() =>
    store.groups.find((group) => group.id === selectedId.value),
  );
  const draftDirty = computed(() => {
    if (!selectedId.value) return false;
    if (!selectedGroup.value) return selectedId.value.startsWith("group-new-");
    const currentIds = [...(selectedGroup.value.skillIds || [])].sort();
    const draftIds = [...draftSkills.value].sort();
    return (
      draftName.value.trim() !== selectedGroup.value.name ||
      currentIds.length !== draftIds.length ||
      currentIds.some((id, index) => id !== draftIds[index])
    );
  });

  // 分组列表变化（保存、删除、外部刷新）后，保证选中项始终有效。
  watch(
    () => store.groups,
    (groups) => {
      if (
        !groups.some((group) => group.id === selectedId.value) &&
        !selectedId.value.startsWith("group-new-")
      ) {
        selectedId.value = groups[0]?.id || "";
      }
    },
    { immediate: true },
  );

  // 切换选中分组时，把草稿重置为该分组的当前内容。
  watch(
    selectedGroup,
    (group) => {
      if (!group) return;
      draftName.value = group.name;
      draftSkills.value = [...(group.skillIds || [])];
    },
    { immediate: true },
  );

  /** 草稿有改动时确认是否放弃，未改动则直接允许切换。 */
  async function confirmDiscardDraft() {
    if (!draftDirty.value) return true;
    return store.confirm({
      title: "放弃未保存的修改？",
      message: "当前分组还有未保存的内容，切换后这些修改将丢失。",
      confirmText: "放弃修改",
      tone: "danger",
    });
  }

  /**
   * 进入「新建分组」状态：生成临时 id，并清空名称与勾选项。
   * 临时 id 前缀是 group-new-，保存时会被替换为正式的 group- 前缀。
   */
  async function createGroup() {
    if (!(await confirmDiscardDraft())) return;
    selectedId.value = `group-new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    draftName.value = "新分组";
    draftSkills.value = [];
  }

  /**
   * 切换当前选中的分组（左侧列表点击）。
   *
   * @param {{id: string, name: string, skillIds: string[]}} group - 被点击的分组
   */
  async function selectGroup(group) {
    if (group.id === selectedId.value || !(await confirmDiscardDraft())) return;
    selectedId.value = group.id;
  }

  /**
   * 勾选/取消勾选一个 Skill（在草稿上操作，保存后生效）。
   *
   * @param {string} skillId - Skill 的仓库相对路径 id
   */
  function toggleSkill(skillId) {
    draftSkills.value = draftSkills.value.includes(skillId)
      ? draftSkills.value.filter((id) => id !== skillId)
      : [...draftSkills.value, skillId];
  }

  /**
   * 保存分组：新建时追加到列表，编辑时替换对应项，然后整体提交给 store。
   * 保存成功后若原来处于新建状态，需要把选中项切换到刚创建的分组。
   */
  async function save() {
    const name = draftName.value.trim();
    if (!name) return store.notify("请输入分组名称", "error");
    const next = selectedGroup.value
      ? store.groups.map((group) =>
          group.id === selectedId.value
            ? { ...group, name, skillIds: [...draftSkills.value] }
            : group,
        )
      : [
          ...store.groups,
          {
            id: selectedId.value.replace("group-new-", "group-"),
            name,
            skillIds: [...draftSkills.value],
          },
        ];
    const saved = await store.saveGroups(next);
    if (saved && !selectedGroup.value)
      selectedId.value = next[next.length - 1].id;
  }

  /**
   * 删除分组：先弹确认框，确认后提交新列表并回退到剩余分组中的第一个。
   * 组内 Skills 的仓库源文件和 Agent 当前启用状态都不会被删除。
   */
  async function remove() {
    if (!selectedGroup.value) return;
    const accepted = await store.confirm({
      title: "删除分组",
      message: `确定删除“${selectedGroup.value.name}”吗？这不会关闭 Agent 已启用的 Skills。`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!accepted) return;
    const next = store.groups.filter((group) => group.id !== selectedId.value);
    const saved = await store.saveGroups(next);
    if (saved) selectedId.value = next[0]?.id || "";
  }

  return {
    createGroup,
    draftDirty,
    draftName,
    draftSkills,
    remove,
    save,
    selectGroup,
    selectedGroup,
    selectedId,
    toggleSkill,
  };
}
