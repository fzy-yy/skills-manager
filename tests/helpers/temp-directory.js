import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 为文件系统测试创建独立目录，并保证用例结束后可完整清理。 */
export async function createTempDirectory(prefix = "skills-manager-test-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    directory,
    resolve: (...parts) => path.join(directory, ...parts),
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

/** 创建一个带最小合法元数据的 Skill 目录。 */
export async function createSkill(root, folderName, name) {
  const directory = path.join(root, folderName);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${JSON.stringify(name)}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return directory;
}
