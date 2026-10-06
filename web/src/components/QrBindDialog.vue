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

const POLL_INTERVAL_MS = 2000;
let timer: number | null = null;
let polling = false;

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
  polling = false;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/**
 * 安排下一次轮询。
 *
 * 用「上一次跑完再安排下一次」（setTimeout 自调度）而不是 setInterval：后者在上一次还没回来时
 * 会继续发新请求，而微信那条的状态查询本身是一次最长 35 秒的长轮询 —— 于是「用户一确认」
 * 会有好几个请求同时醒来、各自拿同一个**一次性 code** 去换凭据，一个成功其余全被 QQ 回
 * 「登录鉴权参数无效或已过期」（弹窗里显示为「上游返回 400」）。
 */
function schedulePoll(): void {
  if (!polling) return;
  timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
}

/**
 * 释放服务端扫码会话。
 * 手机端扫码在 QQ 上游（qq-upstream/mobile.py）里维持着一条 MQTT 长连接，用户关闭弹窗或刷新二维码时
 * 需要显式告知它断开，否则要空耗到超时。
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
    polling = true;
    schedulePoll();
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
  } finally {
    // 单次跑完才安排下一次：不重叠，避免同一条一次性 code 被并发换取。
    schedulePoll();
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

/**
 * 已经扫到码、正等你在手机上确认的那一段。
 * 这时候二维码本身没用了：糊掉它，把视线让给"接下来在手机上做什么"。
 */
const scanned = computed(() => status.value === 'scanned' || status.value === 'confirmed');

/**
 * 压在二维码上的那句，按逗号**刻意**断成两行。
 *
 * 不交给自动换行：CJK 没有词边界，`text-wrap: balance` 会把「手机」劈到两行去；而按宽度硬凑
 * （14px 刚好一行）又太依赖字体度量。逗号断行是确定的，两行都短，居中看着像有意为之。
 */
const overlayLines = computed(() => {
  const parts = statusText[status.value].split('，');
  return parts.map((part, index) => (index < parts.length - 1 ? `${part}，` : part));
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
  <!--
    Teleport 到 body：账户页里这个弹窗长在路由组件内部，而路由组件带着 transform 动画（fade-in），
    祖先一旦有 transform 就成了 fixed 的包含块 —— 遮罩只会盖住内容区，盖不到侧栏与播放条（同 CreatePlaylistDialog）。
  -->
  <Teleport to="body">
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
            <div class="qr-frame" :class="{ 'is-scanned': scanned }">
              <div v-if="step === 'loading'" class="qr-loading">
                <AppIcon name="refresh" :size="26" class="spin" />
              </div>
              <img v-else :src="qrImage" alt="登录二维码" />
              <!-- 码已扫过：把这句"接下来在手机上做什么"直接压在糊掉的二维码上。 -->
              <div v-if="scanned" class="qr-overlay">
                <span v-for="line in overlayLines" :key="line">{{ line }}</span>
              </div>
            </div>
            <p v-if="!scanned" class="muted qr-status">
              {{ step === 'loading' ? '正在获取二维码…' : statusText[status] }}
            </p>
            <!-- 扫到码之后这句就撤了：文案已经挪到二维码上，这里不再重复。 -->
            <p v-if="!scanned" class="muted qr-hint">
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
  </Teleport>
</template>

<style scoped>
.qr-area {
  padding: 18px 0 4px;
}

.qr-frame {
  position: relative;
  display: grid;
  place-items: center;
  width: 208px;
  height: 208px;
  margin: 0 auto;
  padding: 10px;
  border-radius: var(--radius);
  background: #fff;
  box-shadow: var(--shadow-md);
  /* 裁掉模糊放大后溢出的那圈，顺带把圆角切干净。 */
  overflow: hidden;
}

/* 压在二维码上的那句：垫一层薄白纱，任何底纹下都读得清。 */
.qr-overlay {
  position: absolute;
  inset: 0;
  /* 竖排居中（grid 会把两行各自铺满半格，看着像上下分离）。 */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.6;
  color: var(--brand-600);
  background: rgba(255, 255, 255, 0.62);
}

/* 每行一句（断行由 overlayLines 决定，见上面的注释）。 */
.qr-overlay span {
  display: block;
}

.qr-frame img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  transition: filter 0.3s ease, transform 0.3s ease;
}

/*
 * 扫到码之后二维码就没用了：糊掉它，视线自然落到下面那句提示上。
 * 略微放大是为了盖住模糊在边缘取样到背景时产生的虚边。
 */
.qr-frame.is-scanned img {
  filter: blur(7px) saturate(0.6);
  transform: scale(1.08);
}

/* 还没扫到时的那句状态说明（扫到码之后它会挪到二维码上，见 .qr-overlay）。 */
.qr-status {
  margin: 14px 0 0;
  text-align: center;
}

/* 「怎么扫」那句：只在还没扫到时出现。 */
.qr-hint {
  margin: 6px 0 0;
  text-align: center;
  font-size: 12px;
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
