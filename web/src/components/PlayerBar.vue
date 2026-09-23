<script setup lang="ts">
import { usePlayerStore } from '@/stores/player';
import { formatArtists } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';
import DevicePicker from './DevicePicker.vue';
import LikeButton from './LikeButton.vue';
import PlayModePicker from './PlayModePicker.vue';
import ProgressBar from './ProgressBar.vue';
import QualityPicker from './QualityPicker.vue';
import QueueButton from './QueueButton.vue';
import SourcePicker from './SourcePicker.vue';
import VolumeControl from './VolumeControl.vue';

const player = usePlayerStore();
</script>

<template>
  <div class="player-bar">
    <div class="player-inner">
      <!-- 左侧：当前歌曲 -->
      <div class="row player-left" style="min-width: 0">
        <template v-if="player.current">
          <!-- 点封面展开全屏歌词（与 Apple Music 一致的手感） -->
          <button
            class="cover-button"
            type="button"
            title="展开歌词页"
            @click="player.toggleExpanded()"
          >
            <CoverArt
              :src="player.current.album.cover"
              :size="52"
              radius="12px"
              :alt="player.current.title"
              :seed="player.current.title"
            />
            <span class="cover-button-hint"><AppIcon name="chevron-up" :size="16" /></span>
          </button>
          <div class="stack" style="min-width: 0; gap: 2px">
            <div class="row" style="gap: 7px; min-width: 0">
              <strong class="truncate">{{ player.current.title }}</strong>
              <span v-if="player.current.vip" class="tag" style="color: var(--brand-600)">VIP</span>
            </div>
            <span class="muted truncate" style="font-size: 12px">
              {{ formatArtists(player.current.artists) }}
            </span>
          </div>
          <LikeButton />
        </template>
        <div v-else class="stack" style="gap: 2px">
          <strong>还没有播放音乐</strong>
          <span class="muted" style="font-size: 12px">从搜索或发现页挑一首吧</span>
        </div>
      </div>

      <!-- 中间：控制与进度 -->
      <div class="stack player-center" style="gap: 6px">
        <div class="transport">
          <PlayModePicker />
          <button class="icon-btn transport-skip" type="button" title="上一首" @click="player.prev()">
            <AppIcon name="prev" :size="21" filled />
          </button>
          <button
            class="play-btn"
            type="button"
            :title="player.playing ? '暂停（空格）' : '播放（空格）'"
            @click="player.toggle()"
          >
            <AppIcon v-if="player.loading" name="refresh" :size="20" class="spin" />
            <AppIcon v-else-if="player.playing" name="pause" :size="20" filled />
            <AppIcon v-else name="play" :size="20" filled />
          </button>
          <button class="icon-btn transport-skip" type="button" title="下一首" @click="player.next()">
            <AppIcon name="next" :size="21" filled />
          </button>
          <!-- 音量：与左侧的模式按钮对称，滑杆悬停时从上方浮出 -->
          <VolumeControl />
        </div>

        <ProgressBar show-times />
      </div>

      <!-- 右侧：音源、音质、播放队列 -->
      <div class="row player-right" style="justify-content: flex-end; gap: 10px; min-width: 0">
        <div v-if="player.current" class="row" style="gap: 6px">
          <SourcePicker />
          <span
            v-if="player.trial"
            class="tag"
            style="color: var(--brand-600)"
            title="受版权或会员限制，当前平台仅能提供试听片段，可在左侧切换音源"
          >
            试听
          </span>
        </div>

        <QualityPicker />

        <QueueButton />

        <DevicePicker />

      </div>
    </div>
  </div>
</template>

<style scoped>
.cover-button {
  position: relative;
  display: block;
  flex: none;
  padding: 0;
  border-radius: 12px;
  overflow: hidden;
  line-height: 0;
  transition: transform 0.2s ease;
}

.cover-button:hover {
  transform: translateY(-2px);
}

.cover-button-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  /* 中性黑，别带主题色相：写死粉紫在其它配色下会显得脏。 */
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.cover-button:hover .cover-button-hint {
  opacity: 1;
}
</style>
