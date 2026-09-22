import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /*
     * 监听所有网卡，手机/平板可以直接开 http://<内网IP>:5173。
     *
     * 只把 dev server 暴露出去，网关仍只听 127.0.0.1：页面请求的是同源的 /api，
     * 由这里的 proxy 在宿主机内部转发到网关。因此不必改网关的 HOST / WEB_ORIGIN，
     * 也不会引入跨域、预检和 Cookie SameSite 这些问题。
     */
    host: true,
    // 开发环境把 /api 代理到网关，前后端同源，避免额外的跨域与 Cookie 配置。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
