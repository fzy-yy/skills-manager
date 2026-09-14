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
/** 将组件树中的意外异常转为用户可见提示。 */
app.config.errorHandler = (error) => {
  store.notify(`界面发生错误：${error?.message || "未知错误"}`, "error");
};

/** 捕获未被业务调用方处理的 Promise 异常。 */
window.addEventListener("unhandledrejection", (event) => {
  store.notify(
    `操作发生未处理错误：${event.reason?.message || String(event.reason || "未知错误")}`,
    "error",
  );
});

app.mount("#app");
