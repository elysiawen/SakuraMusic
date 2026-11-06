import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { setSessionExpiredHandler } from './api/client';
import { bootstrapCredentials } from './api/localVault';
import { router } from './router';
import { useAuthStore } from './stores/auth';
import { useThemeStore } from './stores/theme';
import './styles/main.css';
// 配色主题必须在 main.css 之后加载，否则无法覆盖 :root 中的默认品牌色。
import './styles/themes.css';

async function bootstrap(): Promise<void> {
  const pinia = createPinia();
  const app = createApp(App).use(pinia).use(router);

  /**
   * 会话在别处过期（或超过绝对上限）时统一收尾：清认证态并带当前地址跳登录页。
   * App.vue 的 isAuthenticated 监听会顺带断开设备长连接与房间订阅；
   * 用 window.location 取地址，避免 router 初始导航还没完成时只拿到 '/'。
   */
  setSessionExpiredHandler(() => {
    const auth = useAuthStore(pinia);
    // 多个并发请求同时 401 时只处理一次。
    if (!auth.isAuthenticated) return;
    auth.expireSession();

    if (window.location.pathname === '/login') return;
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    void router.push({ name: 'login', query: currentPath === '/' ? {} : { redirect: currentPath } });
  });

  // 先把「仅本机」凭据读进内存缓存，后续请求才能同步附加请求头。
  await bootstrapCredentials();

  // 提前实例化主题 store：主题属性在挂载前就写到 <html> 上；
  // 本机背景图存在 IndexedDB 里，读取是异步的，挂到 store 上并行进行，不阻塞首屏。
  void useThemeStore(pinia).loadBackground();

  app.mount('#app');
}

void bootstrap();
