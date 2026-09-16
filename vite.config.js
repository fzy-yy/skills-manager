/** uTools 通过本地文件加载产物，因此资源路径必须保持相对。 */
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  base: "./",
  // 与 public/plugin.json 的 development.main 保持一致：uTools 开发模式按该地址加载入口，
  // 端口固定可避免 Vite 自动切换端口后插件仍指向旧地址。
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
