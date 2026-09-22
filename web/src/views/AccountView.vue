<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { credentialApi } from '@/api';
import { PLATFORM_LABEL, type Platform } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import QrBindDialog from '@/components/QrBindDialog.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useCredentialStore } from '@/stores/credential';
import { avatarGradient, formatRelativeTime } from '@/utils/format';

/**
 * 账户中心：只放「身份」相关的内容——Sakura 账号资料、密码，
 * 以及第三方音乐账号的绑定与凭据管理。
 * 外观、音质这类播放偏好放在「设置」，两边互不干扰。
 */
const auth = useAuthStore();
const credentials = useCredentialStore();
const toast = useToast();
const confirm = useConfirm();

const bindPlatform = ref<Platform | null>(null);
const nickname = ref(auth.user?.nickname ?? '');
const avatarUrl = ref(auth.user?.avatar ?? '');
const savingProfile = ref(false);

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const savingPassword = ref(false);

const refreshing = ref<Platform | null>(null);
const statusMap = ref<Partial<Record<Platform, { bound: boolean; valid: boolean }>>>({});

const platforms: Platform[] = ['netease', 'qq'];

const modeOf = (platform: Platform) => credentials.modeByPlatform[platform] ?? null;
const profileOf = (platform: Platform) => credentials.profileOf(platform);

const stats = computed(() => auth.stats);
const boundCount = computed(() => platforms.filter((platform) => modeOf(platform)).length);
const localCount = computed(() => credentials.localItems.length);

/**
 * 已绑定账号可用于展示的头像地址，「一键取用」和下面的凭据卡片共用。
 *
 * - 网易云：直接用它自己返回的头像地址。
 * - QQ：走 qlogo CDN，`nk` 就是 QQ 号（凭据里的 musicid）。微信登录拿不到 QQ 号，
 *   此时退回上游返回的头像；再没有就交给占位图，不伪造。
 */
function platformAvatarUrl(platform: Platform): string {
  const profile = credentials.profileOf(platform);
  if (platform === 'qq') {
    const qqNumber = profile?.userId?.trim();
    if (qqNumber) return `https://q1.qlogo.cn/g?b=qq&nk=${qqNumber}&s=640`;
  }
  return profile?.avatar ?? '';
}

const avatarPresets = computed(() => [
  {
    key: 'netease',
    label: '网易云头像',
    url: platformAvatarUrl('netease'),
    reason: '未绑定网易云账号，或该账号没有返回头像',
  },
  {
    key: 'qq',
    label: 'QQ 头像',
    url: platformAvatarUrl('qq'),
    reason: '未绑定 QQ 账号，或该账号取不到 QQ 号（微信登录暂时拿不到）',
  },
]);

/** 点一下即填入并保存，省掉「先填地址再点保存」两步。 */
async function usePresetAvatar(url: string): Promise<void> {
  if (!url) return;
  avatarUrl.value = url;
  await saveProfile();
}

onMounted(async () => {
  await credentials.refreshLists();
  nickname.value = auth.user?.nickname ?? '';
  avatarUrl.value = auth.user?.avatar ?? '';
  void refreshAllStatus();
});

async function refreshAllStatus(): Promise<void> {
  for (const platform of platforms) {
    if (!modeOf(platform)) continue;
    try {
      statusMap.value[platform] = await credentialApi.status(platform);
    } catch {
      statusMap.value[platform] = { bound: true, valid: false };
    }
  }
}

async function saveProfile(): Promise<void> {
  savingProfile.value = true;
  try {
    await auth.updateProfile({
      nickname: nickname.value.trim() || undefined,
      avatar: avatarUrl.value.trim() ? avatarUrl.value.trim() : null,
    });
    toast.success('资料已更新');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingProfile.value = false;
  }
}

async function changePassword(): Promise<void> {
  if (newPassword.value !== confirmPassword.value) {
    toast.error('两次输入的新密码不一致');
    return;
  }
  savingPassword.value = true;
  try {
    await auth.changePassword(oldPassword.value, newPassword.value);
    toast.success('密码已更新，请重新登录');
    oldPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    auth.user = null;
    window.location.href = '/login';
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '修改失败');
  } finally {
    savingPassword.value = false;
  }
}

async function unbind(platform: Platform): Promise<void> {
  const mode = modeOf(platform);
  const label = mode === 'server' ? '服务器上加密保存的' : '本机保存的';
  const ok = await confirm.ask({
    title: `解绑${PLATFORM_LABEL[platform]}`,
    message: `${label}凭据将被删除，之后需要重新扫码登录才能继续使用该平台。`,
    confirmLabel: '解绑',
    danger: true,
  });
  if (!ok) return;
  try {
    await credentials.unbind(platform);
    delete statusMap.value[platform];
    toast.success(`已解绑${PLATFORM_LABEL[platform]}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '解绑失败');
  }
}

async function refresh(platform: Platform): Promise<void> {
  refreshing.value = platform;
  try {
    const result = await credentialApi.refresh(platform);
    if (!result.valid) {
      toast.error(result.message ?? '凭据已失效，请重新扫码登录');
      statusMap.value[platform] = { bound: true, valid: false };
      return;
    }
    // 「仅本机」模式刷新后拿到新凭据，需要写回浏览器存储。
    if (result.mode === 'local' && result.credential) {
      await credentials.saveLocal(
        platform,
        result.credential.cookie,
        result.profile ?? { nickname: PLATFORM_LABEL[platform] },
        result.credential.raw,
      );
    } else {
      await credentials.refreshLists();
    }
    statusMap.value[platform] = { bound: true, valid: true };
    toast.success(`${PLATFORM_LABEL[platform]}凭据已刷新`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '刷新失败');
  } finally {
    refreshing.value = null;
  }
}

async function onBound(): Promise<void> {
  await credentials.refreshLists();
  await refreshAllStatus();
}
</script>

<template>
  <div>
    <div style="padding: 4px 6px 16px">
      <h1 class="section-title">账户中心</h1>
      <span class="muted" style="font-size: 12.5px">
        Sakura 账号资料、第三方音乐账号与安全设置
      </span>
    </div>

    <!-- 账号资料 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="user" :size="17" />
        <h2>账号资料</h2>
        <span class="muted" style="font-size: 12px; margin-left: auto">
          已绑定 {{ boundCount }} / {{ platforms.length }} 个音乐账号
        </span>
      </div>

      <div class="row" style="gap: 18px; flex-wrap: wrap; align-items: flex-start">
        <span
          class="avatar"
          style="width: 68px; height: 68px; font-size: 24px"
          :style="{ background: avatarGradient(auth.user?.username ?? 'sakura') }"
        >
          <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
          <template v-else>{{ (auth.user?.nickname ?? 'S').slice(0, 1) }}</template>
        </span>

        <div class="stack" style="gap: 12px; flex: 1; min-width: 260px">
          <label class="stack" style="gap: 6px">
            <span class="field-label">用户名（不可修改）</span>
            <input class="input" :value="auth.user?.username" disabled />
          </label>
          <label class="stack" style="gap: 6px">
            <span class="field-label">昵称</span>
            <input v-model="nickname" class="input" maxlength="32" placeholder="展示用的名字" />
          </label>
          <label class="stack" style="gap: 6px">
            <span class="field-label">头像图片地址（留空使用渐变色头像）</span>
            <input v-model="avatarUrl" class="input" placeholder="https://..." />
          </label>

          <div class="stack" style="gap: 8px">
            <span class="field-label">或直接取用已绑定平台的头像</span>
            <div class="row" style="gap: 8px; flex-wrap: wrap; align-items: center">
              <button
                v-for="preset in avatarPresets"
                :key="preset.key"
                class="avatar-preset"
                type="button"
                :disabled="!preset.url || savingProfile"
                :title="preset.url ? `使用${preset.label}` : preset.reason"
                @click="usePresetAvatar(preset.url)"
              >
                <CoverArt
                  :src="preset.url"
                  :size="24"
                  radius="999px"
                  fallback-icon="user"
                  :seed="preset.key"
                />
                {{ preset.label }}
              </button>

              <span class="avatar-preset is-unavailable" title="微信登录目前拿不到头像地址">
                <CoverArt :size="24" radius="999px" fallback-icon="user" seed="wechat" />
                微信头像 · 暂不可用
              </span>
            </div>
          </div>
          <div class="row" style="gap: 10px">
            <button class="btn btn-primary" type="button" :disabled="savingProfile" @click="saveProfile">
              {{ savingProfile ? '保存中…' : '保存资料' }}
            </button>
            <span class="muted" style="font-size: 12px">
              收藏 {{ stats?.favorites ?? 0 }} · 歌单 {{ stats?.playlists ?? 0 }} · 历史
              {{ stats?.history ?? 0 }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- 第三方音乐账号 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="link" :size="17" />
        <h2>第三方音乐账号</h2>
        <span class="muted" style="font-size: 12px; margin-left: auto">
          扫码后需选择凭据保存位置
        </span>
      </div>

      <p class="muted" style="font-size: 12.5px; margin: 0 0 14px; line-height: 1.7">
        「保存在服务器」会以 AES-256-GCM 加密后写入 Sakura 的 PostgreSQL，可在任意设备使用；
        「仅保存在本机」只写入当前浏览器 IndexedDB，请求时临时透传给上游，服务器不落库、不记录。
      </p>

      <div class="cred-grid">
        <div v-for="platform in platforms" :key="platform" class="cred-card">
          <div class="row" style="gap: 12px">
            <!-- 头像与「一键取用」用同一套来源：QQ 走 qlogo，微信登录则退回上游头像或占位图 -->
            <CoverArt
              :src="platformAvatarUrl(platform)"
              :size="46"
              radius="14px"
              fallback-icon="user"
              :seed="platform"
            />
            <div class="stack" style="gap: 3px; min-width: 0; flex: 1">
              <div class="row" style="gap: 8px">
                <strong>{{ PLATFORM_LABEL[platform] }}</strong>
                <span
                  v-if="modeOf(platform)"
                  class="tag"
                  :style="
                    modeOf(platform) === 'server'
                      ? 'color: var(--brand-600)'
                      : 'color: var(--success)'
                  "
                >
                  {{ modeOf(platform) === 'server' ? '服务器保存' : '仅本机' }}
                </span>
              </div>
              <span class="muted truncate" style="font-size: 12px">
                {{ modeOf(platform) ? (profileOf(platform)?.nickname ?? '已绑定') : '未绑定' }}
              </span>
            </div>
          </div>

          <div class="row" style="gap: 8px; margin-top: 14px; flex-wrap: wrap">
            <template v-if="modeOf(platform)">
              <button class="btn" type="button" :disabled="refreshing === platform" @click="refresh(platform)">
                <AppIcon name="refresh" :size="13" :class="{ spin: refreshing === platform }" />
                刷新凭据
              </button>
              <button class="btn btn-danger" type="button" @click="unbind(platform)">
                <AppIcon name="trash" :size="13" />
                解绑
              </button>
              <span
                v-if="statusMap[platform]"
                class="chip"
                :style="statusMap[platform]?.valid ? '' : 'color: var(--danger); border-color: rgba(224,69,58,.3)'"
              >
                {{ statusMap[platform]?.valid ? '凭据有效' : '凭据可能已失效' }}
              </span>
            </template>
            <button v-else class="btn btn-primary" type="button" @click="bindPlatform = platform">
              <AppIcon name="qr" :size="14" />
              扫码绑定
            </button>
          </div>
        </div>
      </div>

      <p class="muted" style="font-size: 12px; margin: 16px 0 0; line-height: 1.7">
        「仅本机」凭据保存在当前浏览器的 IndexedDB（{{ localCount > 0 ? `当前 ${localCount} 条` : '当前无' }}），
        服务器不落库、不记录；「服务器保存」的凭据可随时在上方解绑删除。
        <template v-if="credentials.serverItems.length > 0">
          最近一次更新：{{ formatRelativeTime(credentials.serverItems[0]?.updatedAt ?? '') }}。
        </template>
      </p>
    </section>

    <!-- 修改密码 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="lock" :size="17" />
        <h2>修改密码</h2>
      </div>
      <div class="row" style="gap: 10px; flex-wrap: wrap; align-items: flex-end">
        <label class="stack" style="gap: 6px; flex: 1; min-width: 180px">
          <span class="field-label">当前密码</span>
          <input v-model="oldPassword" class="input" type="password" autocomplete="current-password" />
        </label>
        <label class="stack" style="gap: 6px; flex: 1; min-width: 180px">
          <span class="field-label">新密码</span>
          <input v-model="newPassword" class="input" type="password" autocomplete="new-password" />
        </label>
        <label class="stack" style="gap: 6px; flex: 1; min-width: 180px">
          <span class="field-label">确认新密码</span>
          <input v-model="confirmPassword" class="input" type="password" autocomplete="new-password" />
        </label>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="savingPassword || !oldPassword || !newPassword"
          @click="changePassword"
        >
          {{ savingPassword ? '提交中…' : '修改密码' }}
        </button>
      </div>
      <p class="muted" style="font-size: 12px; margin: 12px 0 0">修改后所有设备的登录态都会失效，需要重新登录。</p>
    </section>

    <QrBindDialog :platform="bindPlatform" @close="bindPlatform = null" @bound="onBound" />
  </div>
</template>

<style scoped>
/* 一键取用平台头像的小胶囊：左边是缩略图，右边是平台名。 */
.avatar-preset {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 12px 3px 4px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  color: var(--text-soft);
  font-size: 12px;
  font-weight: 650;
  transition: all 0.18s ease;
}

.avatar-preset:hover:not(:disabled):not(.is-unavailable) {
  color: var(--brand-600);
  border-color: var(--brand-300);
  transform: translateY(-1px);
}

.avatar-preset:disabled,
.avatar-preset.is-unavailable {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
