<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { roomApi, type TogetherPartnerDetail } from '@/api/room';
import { avatarGradient, formatSessionTime, formatTogetherDuration } from '@/utils/format';
import AppIcon from './AppIcon.vue';

/**
 * 「和某位好友的一起听记录」弹窗：每次一起听的日期与时长。
 *
 * 由账户中心点伙伴那一行打开。明细可能不可用（服务端那张表可以随时被删），
 * 这时要说清「只有累计可用」，而不是显示成"一次都没听过"。
 */
const props = defineProps<{
  visible: boolean;
  partnerId: string | null;
  /** 兜底标题：明细还没回来时先用列表里的昵称。 */
  partnerName: string;
}>();

const emit = defineEmits<{ (event: 'close'): void }>();

const detail = ref<TogetherPartnerDetail | null>(null);
const loading = ref(false);
const error = ref('');

watch(
  () => [props.visible, props.partnerId] as const,
  async ([visible, partnerId]) => {
    if (!visible || !partnerId) return;
    loading.value = true;
    error.value = '';
    detail.value = null;
    try {
      detail.value = await roomApi.partnerDetail(partnerId);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '记录加载失败';
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** 服务端最多返回 200 条：被截断时补一句说明，别让人以为只听过这么几次。 */
const truncated = computed(() => {
  const current = detail.value;
  if (!current?.sessions || current.sessionCount === null) return false;
  return current.sessions.length < current.sessionCount;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="emit('close')">
      <div class="modal">
        <div class="between">
          <h3 class="modal-title">一起听记录</h3>
          <button class="icon-btn" type="button" @click="emit('close')">
            <AppIcon name="close" />
          </button>
        </div>

        <p v-if="loading" class="muted together-dialog-hint">正在读取…</p>
        <p v-else-if="error" class="muted together-dialog-hint">{{ error }}</p>

        <template v-else-if="detail">
          <div class="row" style="gap: 12px; margin: 12px 0 16px">
            <span
              class="avatar"
              :style="{
                width: '46px',
                height: '46px',
                fontSize: '18px',
                background: avatarGradient(detail.partner.nickname || detail.partner.userId),
              }"
            >
              <img v-if="detail.partner.avatar" :src="detail.partner.avatar" alt="" />
              <template v-else>{{ (detail.partner.nickname || '友').slice(0, 1) }}</template>
            </span>
            <div class="stack" style="gap: 2px; min-width: 0">
              <strong class="truncate">{{ detail.partner.nickname }}</strong>
              <span class="muted" style="font-size: 12px">
                一起听过 {{ formatTogetherDuration(detail.totalSeconds) }}
                <template v-if="detail.sessionCount !== null"> · {{ detail.sessionCount }} 次</template>
              </span>
            </div>
          </div>

          <!-- 明细表被删掉的情况：说明清楚，不假装"没听过"。 -->
          <p v-if="detail.sessions === null" class="muted together-dialog-hint">
            这里只有累计时长可用：每一次的明细已经不再记录了。
          </p>
          <template v-else>
            <p v-if="detail.sessions.length === 0" class="muted together-dialog-hint">
              还没有一起听过的记录。
            </p>
            <ul v-else class="session-list">
              <li
                v-for="(item, index) in detail.sessions"
                :key="`${item.startedAt}-${index}`"
                class="session-row"
              >
                <span class="session-time">{{ formatSessionTime(item.startedAt) }}</span>
                <strong class="session-duration">{{ formatTogetherDuration(item.seconds) }}</strong>
              </li>
            </ul>
            <p v-if="truncated" class="muted session-more">
              仅显示最近 {{ detail.sessions.length }} 次
            </p>
          </template>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.together-dialog-hint {
  margin: 0;
  padding: 16px 0;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.7;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.session-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
}

.session-row:hover {
  background: var(--surface-hover);
}

.session-time {
  font-size: 12.5px;
  color: var(--text-soft);
  font-variant-numeric: tabular-nums;
}

.session-duration {
  flex: none;
  color: var(--brand-600);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.session-more {
  margin: 10px 0 0;
  text-align: center;
  font-size: 11.5px;
}
</style>
