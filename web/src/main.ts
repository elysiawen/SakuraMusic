import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { bootstrapCredentials } from './api/localVault';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import './styles/main.css';
// 配色主题必须在 main.css 之后加载，否则无法覆盖 :root 中的默认品牌色。
import './styles/themes.css';

async function bootstrap(): Promise<void> {
  const pinia = createPinia();
  const app = createApp(App).use(pinia).use(router);

  // 先把「仅本机」凭据读进内存缓存，后续请求才能同步附加请求头。
  await bootstrapCredentials();

  // 提前实例化主题 store：主题属性在挂载前就写到 <html> 上；
  // 本机背景图存在 IndexedDB 里，读取是异步的，挂到 store 上并行进行，不阻塞首屏。
  void useThemeStore(pinia).loadBackground();

  app.mount('#app');
}

void bootstrap();
