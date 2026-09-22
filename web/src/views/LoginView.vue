<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import SakuraPetals from '@/components/SakuraPetals.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const theme = useThemeStore();
const toast = useToast();

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const confirm = ref('');
const submitting = ref(false);

const submitLabel = computed(() => (mode.value === 'login' ? '登录' : '注册并进入'));

function switchMode(next: 'login' | 'register'): void {
  mode.value = next;
  password.value = '';
  confirm.value = '';
}

async function submit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    toast.error('请填写用户名与密码');
    return;
  }
  if (mode.value === 'register' && password.value !== confirm.value) {
    toast.error('两次输入的密码不一致');
    return;
  }

  submitting.value = true;
  try {
    if (mode.value === 'login') {
      await auth.login(username.value.trim(), password.value);
      toast.success('登录成功，开始听歌吧');
    } else {
      await auth.register(username.value.trim(), password.value);
      toast.success('注册成功，第一个账号将成为管理员');
    }
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <SakuraPetals />
  <div class="login-page">
    <button class="icon-btn login-theme" type="button" @click="theme.toggle()">
      <AppIcon :name="theme.resolved === 'dark' ? 'sun' : 'moon'" :size="18" />
    </button>

    <div class="login-card glass">
      <div class="stack" style="align-items: center; gap: 10px; margin-bottom: 22px">
        <span class="brand-mark" style="width: 54px; height: 54px; font-size: 26px">🌸</span>
        <!-- 固定品牌名：登录/注册的区分交给下面的页签与按钮文案 -->
        <h1 style="font-size: 22px">Sakura Music</h1>
      </div>

      <div class="tabs">
        <button
          class="tab"
          :class="{ 'is-active': mode === 'login' }"
          type="button"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          class="tab"
          :class="{ 'is-active': mode === 'register' }"
          type="button"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <form class="stack" style="gap: 12px" @submit.prevent="submit">
        <label class="stack" style="gap: 6px">
          <span class="field-label">用户名</span>
          <input
            v-model="username"
            class="input"
            autocomplete="username"
            placeholder="3-24 位字母、数字、下划线或短横线"
          />
        </label>

        <label class="stack" style="gap: 6px">
          <span class="field-label">密码</span>
          <input
            v-model="password"
            class="input"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="至少 8 位"
          />
        </label>

        <label v-if="mode === 'register'" class="stack" style="gap: 6px">
          <span class="field-label">确认密码</span>
          <input
            v-model="confirm"
            class="input"
            type="password"
            autocomplete="new-password"
            placeholder="再输入一次"
          />
        </label>

        <button class="btn btn-primary" type="submit" style="margin-top: 6px; padding: 12px" :disabled="submitting">
          {{ submitting ? '处理中…' : submitLabel }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: grid;
  place-items: center;
  /* dvh：iOS 地址栏伸缩时 100vh 会把登录卡片顶出可视区。 */
  min-height: 100vh;
  min-height: 100dvh;
  padding: calc(24px + var(--safe-top)) 24px calc(24px + var(--safe-bottom));
  position: relative;
  z-index: 1;
}

.login-theme {
  position: fixed;
  top: calc(20px + var(--safe-top));
  right: calc(22px + var(--safe-right));
}

.login-card {
  width: min(400px, 100%);
  padding: 32px 28px 26px;
  animation: fade-in 0.5s ease both;
}

.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 4px;
  margin-bottom: 20px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.tab {
  padding: 8px;
  border-radius: 999px;
  font-weight: 650;
  font-size: 13px;
  color: var(--text-soft);
  transition: all 0.2s ease;
}

.tab.is-active {
  color: #fff;
  background: linear-gradient(135deg, var(--brand-400), var(--brand-600));
  box-shadow: 0 10px 22px -14px var(--brand-500);
}

.field-label {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-soft);
  padding-left: 4px;
}
</style>
