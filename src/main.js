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
 * 业务动作的异常已由 appStore.run 统一捕获并提示，这里是最后一道兜底，
 * 只处理渲染期间的意外错误。
 */
app.config.errorHandler = (error) => {
  store.notify(`界面发生错误：${error?.message || "未知错误"}`, "error");
};

app.mount("#app");
