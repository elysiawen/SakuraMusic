<script setup lang="ts">
import { computed } from 'vue';
import { PLATFORMS, PLATFORM_LABEL, type Platform } from '@/api/types';
import { useCredentialStore } from '@/stores/credential';
import { useLibraryStore } from '@/stores/library';
import { usePreferencesStore } from '@/stores/preferences';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const emit = defineEmits<{ (event: 'bind', platform: Platform): void }>();

const library = useLibraryStore();
const credentials = useCredentialStore();
const preferences = usePreferencesStore();

const navItems = [
  { name: 'home', label: '发现', icon: 'sparkles' },
  { name: 'library', label: '我的音乐', icon: 'heart' },
  { name: 'settings', label: '设置', icon: 'settings' },
];

/*
 * 只提示「还没绑定、而且用户还想用它」的平台：
 * 在设置里把这平台的「账号歌单」关掉后，侧栏就不该继续劝人去绑定。
 */
const unboundPlatforms = computed<Platform[]>(() =>
  PLATFORMS.filter(
    (platform) => !credentials.modeByPlatform[platform] && preferences.isEnabled(platform, 'library'),
  ),
);
</script>

<template>
  <aside class="app-sidebar">
    <div class="brand">
      <span class="brand-mark">🌸</span>
      <div class="stack" style="gap: 0">
        <span class="brand-text">Sakura Music</span>
        <span class="brand-sub">Aggregated</span>
      </div>
    </div>

    <!-- 窄屏会被 main.css 改成横排：.stack 自带 column，不改就竖着叠成三行 -->
    <nav class="stack sidebar-nav" style="gap: 3px">
      <RouterLink
        v-for="item in navItems"
        :key="item.name"
        class="nav-item"
        :class="{ 'is-active': $route.name === item.name }"
        :to="{ name: item.name }"
      >
        <AppIcon :name="item.icon" :size="17" />
        {{ item.label }}
      </RouterLink>
    </nav>

    <template v-if="unboundPlatforms.length > 0">
      <div class="nav-group-title">未绑定账号</div>
      <!-- 窄屏会被 main.css 改成横排，否则两个按钮竖着叠会把整条导航撑高一截 -->
      <div class="stack sidebar-bind" style="gap: 6px; padding: 0 6px">
        <button
          v-for="platform in unboundPlatforms"
          :key="platform"
          class="btn"
          type="button"
          style="justify-content: flex-start"
          @click="emit('bind', platform)"
        >
          <AppIcon name="qr" :size="15" />
          绑定{{ PLATFORM_LABEL[platform] }}
        </button>
      </div>
    </template>

    <template v-if="library.playlists.length > 0">
      <div class="nav-group-title">我的歌单</div>
      <!--
        窄屏会被 main.css 隐藏：横向导航条塞不下歌单，入口在「我的音乐」页。
        桌面端这里是侧栏里唯一滚动的一块（见 main.css 的 .sidebar-playlists）：
        歌单再多也只让这一段滚，品牌、导航与版权文字都不会被推走 ——
        所以这里**不截断**：以前只放前 12 个（那时整条侧栏一起滚，放全了会把导航顶出去），
        现在滚动收在列表内部，列表有多长就放多长。
      -->
      <nav class="stack sidebar-playlists" style="gap: 2px">
        <RouterLink
          v-for="playlist in library.playlists"
          :key="playlist.id"
          class="nav-item"
          :class="{ 'is-active': $route.name === 'playlist' && $route.params.id === playlist.id }"
          :to="{ name: 'playlist', params: { id: playlist.id } }"
        >
          <CoverArt
            :src="playlist.cover"
            :size="24"
            radius="7px"
            fallback-icon="list"
            :seed="playlist.name"
          />
          <span class="truncate">{{ playlist.name }}</span>
        </RouterLink>
      </nav>
    </template>

    <!-- 占位块：桌面端把版权文字顶到侧栏底部；窄屏会被 main.css 隐藏（否则会破坏横条居中） -->
    <div class="sidebar-spacer" style="flex: 1" />
    <!-- 窄屏会被 main.css 隐藏：横条里没有它的位置 -->
    <p class="muted sidebar-legal" style="font-size: 11px; padding: 12px 10px 2px; line-height: 1.6">
      音乐版权归各平台所有<br />本平台仅供个人学习使用
    </p>
  </aside>
</template>
