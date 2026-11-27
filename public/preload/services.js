/**
 * uTools preload 入口：装配本地能力并暴露到 window.skillsManager。
 *
 * 本文件运行在 uTools 的 Node 环境（CommonJS），渲染层通过 window.skillsManager
 * 调用这里的方法；所有业务实现在同目录的其他模块中：
 *  - api.js：业务编排（对外方法）
 *  - config.js：本地配置读写
 *  - scanner.js：仓库扫描
 *  - links.js：符号链接同步（链接形式）
 *  - copies.js：文件副本同步（直接复制形式）
 *  - utils.js：通用工具
 */
const { createSkillsManagerApi } = require("./api");

window.skillsManager = createSkillsManagerApi({ utools: window.utools });
