<script setup lang="ts">
import { computed } from 'vue';
import { PLATFORM_LABEL, type Platform } from '@/api/types';
import { useCredentialStore } from '@/stores/credential';
import { useLibraryStore } from '@/stores/library';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const emit = defineEmits<{ (event: 'bind', platform: Platform): void }>();

const library = useLibraryStore();
const credentials = useCredentialStore();

const navItems = [
  { name: 'home', label: '发现', icon: 'sparkles' },
  { name: 'library', label: '我的音乐', icon: 'heart' },
  { name: 'settings', label: '设置', icon: 'settings' },
];

const unboundPlatforms = computed<Platform[]>(() =>
  (['netease', 'qq'] as Platform[]).filter((platform) => !credentials.modeByPlatform[platform]),
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

    <nav class="stack" style="gap: 3px">
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
      <div class="stack" style="gap: 6px; padding: 0 6px">
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
      <nav class="stack" style="gap: 2px">
        <RouterLink
          v-for="playlist in library.playlists.slice(0, 12)"
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

    <div style="flex: 1" />
    <p class="muted" style="font-size: 11px; padding: 12px 10px 2px; line-height: 1.6">
      音乐版权归各平台所有<br />本平台仅供个人学习使用
    </p>
  </aside>
</template>
