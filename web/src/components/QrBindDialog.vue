<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { credentialApi } from '@/api';
import {
  PLATFORM_LABEL,
  type AccountProfile,
  type BindStatus,
  type Platform,
  type QqLoginType,
} from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useCredentialStore } from '@/stores/credential';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ platform: Platform | null }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'bound', mode: 'server' | 'local'): void }>();

const credentialStore = useCredentialStore();
const toast = useToast();

type Step = 'loading' | 'scan' | 'choose' | 'saving';

const step = ref<Step>('loading');
const qrImage = ref('');
const identifier = ref('');
const loginType = ref<QqLoginType>('qq');
const status = ref<BindStatus>('waiting');
const message = ref('');
const ticket = ref('');
const profile = ref<AccountProfile | null>(null);
const selectedMode = ref<'server' | 'local' | null>(null);

let timer: number | null = null;

const platformLabel = computed(() => (props.platform ? PLATFORM_LABEL[props.platform] : ''));
const showLoginTypePicker = computed(() => props.platform === 'qq' && step.value === 'scan');
const isQq = computed(() => props.platform === 'qq');

const statusText: Record<BindStatus, string> = {
  waiting: '请使用手机 App 扫描二维码',
  scanned: '已扫描，请在手机上确认登录',
  confirmed: '已确认，正在获取登录状态…',
  success: '登录成功',
  expired: '二维码已过期，请点击刷新',
  refused: '已取消本次登录',
  error: '登录出现异常，请重试',
};

function stopPolling(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/**
 * 释放服务端扫码会话。
 * 手机端扫码在 sidecar 里维持着一条 MQTT 长连接，用户关闭弹窗或刷新二维码时
 * 需要显式告知服务端断开，否则要空耗到超时。
 */
async function releaseSession(): Promise<void> {
  const currentIdentifier = identifier.value;
  if (!currentIdentifier) return;
  const type = loginType.value;
  identifier.value = '';
  try {
    await credentialApi.releaseBind(type, currentIdentifier);
  } catch {
    // 释放失败不影响界面，服务端会话会在超时后自行回收。
  }
}

function close(): void {
  stopPolling();
  void releaseSession();
  emit('close');
}

async function start(): Promise<void> {
  if (!props.platform) return;
  // 刷新二维码前先释放上一轮会话（此时 loginType 与 identifier 仍是旧的一对）。
  await releaseSession();
  stopPolling();
  step.value = 'loading';
  status.value = 'waiting';
  message.value = '';
  selectedMode.value = null;
  try {
    const result = await credentialApi.startBind(props.platform, isQq.value ? loginType.value : undefined);
    qrImage.value = result.qrImage;
    identifier.value = result.identifier;
    step.value = 'scan';
    timer = window.setInterval(() => void poll(), 2000);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '二维码获取失败');
    close();
  }
}

async function poll(): Promise<void> {
  if (!props.platform || !identifier.value) return;
  try {
    const result = await credentialApi.pollBind(props.platform, identifier.value, loginType.value);
    status.value = result.status;
    if (result.message) message.value = result.message;

    if (result.status === 'success' && result.ticket) {
      stopPolling();
      ticket.value = result.ticket;
      profile.value = result.profile ?? null;
      step.value = 'choose';
      return;
    }
    if (result.status === 'expired' || result.status === 'refused' || result.status === 'error') {
      stopPolling();
    }
  } catch (error) {
    stopPolling();
    status.value = 'error';
    message.value = error instanceof Error ? error.message : '轮询失败';
  }
}

async function changeLoginType(type: QqLoginType): Promise<void> {
  if (type === loginType.value) return;
  // 先按旧的 loginType 释放会话，再切换，避免手机端那条 MQTT 连接被漏掉。
  await releaseSession();
  loginType.value = type;
  await start();
}

/** 手机端扫码需要在 QQ 音乐 App 内操作，给一句明确指引。 */
const scanHint = computed(() => {
  if (props.platform !== 'qq') return '打开网易云音乐 App，扫描二维码并在手机上确认';
  if (loginType.value === 'wx') return '打开微信扫一扫，扫描后请在手机上确认登录';
  if (loginType.value === 'mobile') return '打开 QQ 音乐 App → 左上角菜单 → 扫一扫';
  return '打开手机 QQ 扫一扫，扫描后请在手机上确认登录';
});

async function commit(): Promise<void> {
  if (!selectedMode.value || !ticket.value) return;
  step.value = 'saving';
  try {
    const result = await credentialApi.commitBind(ticket.value, selectedMode.value);
    if (result.mode === 'local' && result.credential) {
      await credentialStore.saveLocal(result.platform, result.credential.cookie, result.profile, result.credential.raw);
    } else {
      await credentialStore.refreshLists();
    }
    toast.success(
      result.mode === 'server'
        ? `${platformLabel.value} 已绑定，凭据加密保存到服务器`
        : `${platformLabel.value} 已绑定，凭据只保存在本机`,
    );
    emit('bound', result.mode);
    close();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '保存失败');
    step.value = 'choose';
  }
}

watch(
  () => props.platform,
  (platform) => {
    if (platform) {
      void start();
      return;
    }
    stopPolling();
    void releaseSession();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopPolling();
  void releaseSession();
});
</script>

<template>
  <div v-if="platform" class="modal-mask" @click.self="close()">
    <div class="modal" style="width: min(520px, 100%)">
      <div class="between">
        <div class="stack" style="gap: 2px">
          <h3 class="modal-title">登录{{ platformLabel }}</h3>
          <span class="muted" style="font-size: 12px">
            使用你自己的账号，播放与推荐才会按你的偏好生效
          </span>
        </div>
        <button class="icon-btn" type="button" @click="close()"><AppIcon name="close" /></button>
      </div>

      <!-- 第一步：扫码 -->
      <template v-if="step === 'loading' || step === 'scan'">
        <div class="qr-area">
          <div class="qr-frame">
            <div v-if="step === 'loading'" class="qr-loading">
              <AppIcon name="refresh" :size="26" class="spin" />
            </div>
            <img v-else :src="qrImage" alt="登录二维码" />
          </div>
          <p class="muted" style="text-align: center; margin: 14px 0 0">
            {{ step === 'loading' ? '正在获取二维码…' : statusText[status] }}
          </p>
          <p class="muted" style="text-align: center; font-size: 12px; margin: 6px 0 0">
            {{ scanHint }}
          </p>
          <p v-if="message" class="muted" style="text-align: center; font-size: 12px; margin: 4px 0 0">
            {{ message }}
          </p>

          <div
            v-if="showLoginTypePicker"
            class="row"
            style="justify-content: center; gap: 8px; margin-top: 12px; flex-wrap: wrap"
          >
            <button
              class="chip"
              :class="{ 'is-active': loginType === 'qq' }"
              type="button"
              :disabled="step === 'loading'"
              @click="changeLoginType('qq')"
            >
              手机 QQ 扫码
            </button>
            <button
              class="chip"
              :class="{ 'is-active': loginType === 'wx' }"
              type="button"
              :disabled="step === 'loading'"
              @click="changeLoginType('wx')"
            >
              微信扫码
            </button>
            <button
              class="chip"
              :class="{ 'is-active': loginType === 'mobile' }"
              type="button"
              :disabled="step === 'loading'"
              @click="changeLoginType('mobile')"
            >
              QQ音乐扫码
            </button>
          </div>

          <div
            v-if="status === 'expired' || status === 'refused' || status === 'error'"
            class="row"
            style="justify-content: center; margin-top: 14px"
          >
            <button class="btn btn-primary" type="button" @click="start">
              <AppIcon name="refresh" :size="14" />
              刷新二维码
            </button>
          </div>
        </div>
      </template>

      <!-- 第二步：强制选择存储位置 -->
      <template v-else>
        <div class="row" style="gap: 12px; margin: 16px 0 4px">
          <span class="avatar" style="width: 46px; height: 46px; background: linear-gradient(135deg, var(--brand-300), var(--brand-600))">
            <img v-if="profile?.avatar" :src="profile.avatar" alt="" />
            <template v-else>{{ (profile?.nickname ?? 'S').slice(0, 1) }}</template>
          </span>
          <div class="stack" style="gap: 2px">
            <strong>{{ profile?.nickname ?? platformLabel + ' 用户' }}</strong>
            <span class="muted" style="font-size: 12px">
              {{ platformLabel }}登录成功，请选择凭据保存在哪里
            </span>
          </div>
        </div>

        <div class="mode-grid">
          <button
            type="button"
            class="mode-card"
            :class="{ 'is-selected': selectedMode === 'server' }"
            @click="selectedMode = 'server'"
          >
            <AppIcon name="server" :size="22" />
            <strong>保存在服务器</strong>
            <span class="muted">
              凭据经 AES-256-GCM 加密后入库，换设备、换浏览器都能直接用，无需重新扫码。
            </span>
          </button>
          <button
            type="button"
            class="mode-card"
            :class="{ 'is-selected': selectedMode === 'local' }"
            @click="selectedMode = 'local'"
          >
            <AppIcon name="device" :size="22" />
            <strong>仅保存在本机</strong>
            <span class="muted">
              凭据只写入浏览器 IndexedDB，请求时临时透传，服务器不落库、不记录；换设备需重新扫码。
            </span>
          </button>
        </div>

        <p class="muted" style="font-size: 12px; margin: 12px 0 0">
          <AppIcon name="lock" :size="12" />
          {{
            selectedMode === 'local'
              ? '已选择仅本机：服务器不会保存你的第三方登录态。'
              : '已选择服务器保存：可在设置页随时解绑并删除。'
          }}
        </p>

        <div class="modal-actions">
          <button class="btn" type="button" @click="close()">稍后再说</button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="!selectedMode || step === 'saving'"
            @click="commit"
          >
            {{ step === 'saving' ? '保存中…' : '确认绑定' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qr-area {
  padding: 18px 0 4px;
}

.qr-frame {
  display: grid;
  place-items: center;
  width: 208px;
  height: 208px;
  margin: 0 auto;
  padding: 10px;
  border-radius: var(--radius);
  background: #fff;
  box-shadow: var(--shadow-md);
}

.qr-frame img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.qr-loading {
  color: var(--brand-500);
}

.mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 16px;
}

.mode-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  padding: 15px;
  border-radius: var(--radius);
  border: 1.5px solid var(--border);
  background: var(--surface);
  text-align: left;
  transition: all 0.2s ease;
}

.mode-card span {
  font-size: 12px;
  line-height: 1.5;
}

.mode-card:hover {
  border-color: var(--brand-300);
  transform: translateY(-2px);
}

.mode-card.is-selected {
  border-color: var(--brand-500);
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.16), rgba(var(--brand-rgb), 0.08));
  box-shadow: 0 12px 26px -18px var(--brand-500);
}

@media (max-width: 560px) {
  .mode-grid {
    grid-template-columns: 1fr;
  }
}
</style>
