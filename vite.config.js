/** uTools 通过本地文件加载产物，因此资源路径必须保持相对。 */
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  base: "./",
  // 与 public/plugin.json 的 development.main 保持一致：uTools 开发模式按该地址加载入口，
  // 端口固定可避免 Vite 自动切换端口后插件仍指向旧地址。
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // test_dir 是测试沙箱（测试会频繁移动 / 重命名其中的目录），不参与前端热更新监视。
    // 忽略它可以避免 dev server 的文件监视器占用目录句柄，导致测试中的重命名操作
    // 在 Windows 上报 EPERM（拒绝访问）；同时也减少无关的文件监视开销。
    watch: { ignored: ["**/test_dir/**"] },
  },
});
