import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, bare: true },
    },
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
    { path: '/library', name: 'library', component: () => import('@/views/LibraryView.vue') },
    { path: '/playlist/:id', name: 'playlist', component: () => import('@/views/PlaylistView.vue') },
    {
      path: '/toplist/:platform/:id',
      name: 'toplist',
      component: () => import('@/views/ToplistView.vue'),
    },
    {
      path: '/collection/:platform/:id',
      name: 'collection',
      component: () => import('@/views/ToplistView.vue'),
    },
    {
      path: '/artist/:platform/:id',
      name: 'artist',
      component: () => import('@/views/ArtistView.vue'),
    },
    {
      path: '/album/:platform/:id',
      name: 'album',
      component: () => import('@/views/AlbumView.vue'),
    },
    {
      path: '/account',
      name: 'account',
      component: () => import('@/views/AccountView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.initialize();

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'home' };
  }
  return true;
});
