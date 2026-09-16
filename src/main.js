/** Vue 应用入口：注册 Pinia、路由与全局错误兜底。 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
import { useAppStore } from "./stores/appStore";
import "./main.css";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia).use(router);

const store = useAppStore(pinia);
/**
 * 将组件树中的意外异常转为用户可见提示。
 *
 * 不再额外监听 unhandledrejection：所有会改动配置或文件系统的动作都由
 * operation-runner 统一捕获并提示（失败返回 null，不向外抛异常），
 * 因此业务异常不会以"未处理的 Promise 拒绝"形式出现。
 */
app.config.errorHandler = (error) => {
  store.notify(`界面发生错误：${error?.message || "未知错误"}`, "error");
};

app.mount("#app");
