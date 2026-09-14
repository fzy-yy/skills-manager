import { expect, test } from "./fixtures";

test("完成仓库、分组、Agent 和 Skills 联动配置", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Skills 仓库" })).toBeVisible();

  await page.getByLabel("仓库目录").fill("C:\\skills-repo");
  await page.getByRole("button", { name: "扫描目录" }).click();
  await expect(page.getByLabel("Skills 列表")).toContainText("Alpha");
  await expect(page.getByLabel("Skills 列表")).toContainText("Beta");

  await page.getByRole("link", { name: "分组管理" }).click();
  await page.getByRole("button", { name: "新建分组" }).first().click();
  await page.getByLabel("分组名称").fill("基础开发");
  await page.locator("label").filter({ hasText: /^Alpha$/ }).click();
  await page.locator("label").filter({ hasText: /^Beta$/ }).click();
  await page.getByRole("button", { name: "保存分组" }).click();
  await expect(page.getByText("基础开发", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByLabel("Agent 名称").fill("Codex");
  await page.getByLabel("Skills 目录").fill("C:\\codex\\skills");
  await page.getByRole("button", { name: "添加 Agent" }).click();
  await expect(page.getByText("Codex", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "应用配置" }).click();
  const groupSwitch = page.getByRole("button", { name: "基础开发 分组开关" });
  const alphaSwitch = page.getByRole("button", { name: "Alpha Skill 开关" });
  const betaSwitch = page.getByRole("button", { name: "Beta Skill 开关" });
  await groupSwitch.click();
  await expect(alphaSwitch).toHaveAttribute("aria-pressed", "true");
  await expect(betaSwitch).toHaveAttribute("aria-pressed", "true");
  await expect(groupSwitch).toHaveAttribute("aria-pressed", "true");

  await betaSwitch.click();
  await expect(betaSwitch).toHaveAttribute("aria-pressed", "false");
  await expect(alphaSwitch).toHaveAttribute("aria-pressed", "true");
  await expect(groupSwitch).toHaveAttribute("aria-pressed", "false");
});

test("主题切换、错误提示和清除确认框工作正常", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("仓库目录").fill("C:\\invalid-repo");
  await page.getByRole("button", { name: "扫描目录" }).click();
  await expect(page.getByText("仓库目录不可用", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.getByRole("button", { name: "清除数据" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();

  await page.getByRole("button", { name: "清除数据" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "清除数据" })
    .click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByText("本地数据已清除", { exact: true })).toBeVisible();
});
