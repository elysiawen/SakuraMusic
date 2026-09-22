<script setup lang="ts">
import { PLATFORM_LABEL, QUALITY_LABEL, type Platform, type Quality } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import BackgroundPicker from '@/components/BackgroundPicker.vue';
import ThemePicker from '@/components/ThemePicker.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { useToast } from '@/composables/useToast';
import { usePlayerStore } from '@/stores/player';
import { useThemeStore } from '@/stores/theme';

/**
 * 设置：只管「这台设备怎么用」，即外观与播放偏好。
 * 账号资料、第三方绑定、密码等身份相关内容都在「账户中心」。
 */
const player = usePlayerStore();
const theme = useThemeStore();
const toast = useToast();

const platforms: Platform[] = ['netease', 'qq'];
const qualities: Quality[] = ['standard', 'high', 'lossless', 'hires'];

/**
 * 清掉「这个平台直连不通」的记录。
 * 触发它的原因常常是一次性的（当时网络不通、上游临时改策略、页面一度跑在 http 下），
 * 所以要留个让它们重新试一次的入口。
 */
function retryDirect(): void {
  const count = player.proxyOnly.length;
  player.resetProxyOnly();
  toast.success(`已清除 ${count} 个平台的直连记录，下次播放会重新尝试直连`);
}
</script>

<template>
  <div>
    <div style="padding: 4px 6px 16px">
      <h1 class="section-title">设置</h1>
      <span class="muted" style="font-size: 12.5px">外观、音质与播放偏好</span>
    </div>

    <RouterLink class="account-hint" :to="{ name: 'account' }">
      <AppIcon name="user" :size="15" />
      <span>账号资料、第三方音乐账号与修改密码在「账户中心」</span>
      <AppIcon name="chevron-right" :size="14" />
    </RouterLink>

    <!-- 外观 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="palette" :size="17" />
        <h2>外观</h2>
        <span class="muted" style="font-size: 12px; margin-left: auto">
          明暗模式与配色可自由组合
        </span>
      </div>
      <ThemePicker variant="full" />

      <div
        class="stack"
        style="gap: 14px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border)"
      >
        <ToggleSwitch
          :model-value="theme.petals"
          label="樱花飘落特效"
          hint="页面背景的飘落花瓣；关闭后画面更安静，也能省一点渲染开销"
          @update:model-value="theme.setPetals($event)"
        />
      </div>
    </section>

    <!-- 自定义背景 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="image" :size="17" />
        <h2>自定义背景</h2>
        <span class="muted" style="font-size: 12px; margin-left: auto">仅保存在本机</span>
      </div>
      <BackgroundPicker />
    </section>

    <!-- 播放偏好 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="music" :size="17" />
        <h2>播放偏好</h2>
      </div>

      <div class="stack" style="gap: 16px">
        <div class="stack" style="gap: 8px">
          <span class="field-label">默认音质（不可用时自动降级，保证能播出来）</span>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button
              v-for="quality in qualities"
              :key="quality"
              class="chip"
              :class="{ 'is-active': player.quality === quality }"
              type="button"
              @click="player.setQuality(quality)"
            >
              {{ QUALITY_LABEL[quality] }}
            </button>
          </div>
        </div>

        <div class="stack" style="gap: 8px">
          <span class="field-label">音源偏好（同一首歌两个平台都有时优先使用）</span>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button
              class="chip"
              :class="{ 'is-active': player.preferredPlatform === null }"
              type="button"
              @click="player.setPreferredPlatform(null)"
            >
              自动
            </button>
            <button
              v-for="platform in platforms"
              :key="platform"
              class="chip"
              :class="{ 'is-active': player.preferredPlatform === platform }"
              type="button"
              @click="player.setPreferredPlatform(platform)"
            >
              {{ PLATFORM_LABEL[platform] }}
            </button>
          </div>
          <span class="muted" style="font-size: 11.5px; padding-left: 2px">
            播放条上的音源按钮可临时切换单首歌，这里设定的是全局默认
          </span>
        </div>

        <div class="stack" style="gap: 8px">
          <span class="field-label">音源直连</span>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <span
              v-for="platform in platforms"
              :key="platform"
              class="tag"
              :style="{ color: player.proxyOnly.includes(platform) ? 'var(--text-mute)' : 'var(--brand-600)' }"
            >
              {{ PLATFORM_LABEL[platform] }} · {{ player.proxyOnly.includes(platform) ? '网关中转' : '直连' }}
            </span>
            <button v-if="player.proxyOnly.length > 0" class="chip" type="button" @click="retryDirect">
              <AppIcon name="refresh" :size="13" />
              重新尝试直连
            </button>
          </div>
          <span class="muted" style="font-size: 11.5px; padding-left: 2px">
            能直连时由浏览器自己向平台 CDN 取流，不占服务器带宽；某个平台直连被拒（防盗链、混合内容、当时网络不通）后会被记住并改走网关中转，之后不再重试。点上面的按钮让它们重新试一次。
          </span>
        </div>

        <div class="stack" style="gap: 8px">
          <span class="field-label">播放模式</span>
          <span class="muted" style="font-size: 11.5px; padding-left: 2px">
            顺序 / 列表循环 / 单曲循环 / 随机在播放条左侧的按钮里切换，会随浏览器记住
          </span>
        </div>
      </div>
    </section>

    <!-- 关于 -->
    <section class="glass panel">
      <div class="panel-title">
        <AppIcon name="sparkles" :size="17" />
        <h2>关于 Sakura Music</h2>
      </div>
      <ul class="muted" style="font-size: 12.5px; line-height: 1.9; margin: 0; padding-left: 20px">
        <li>聚合网关自身不存储任何音频文件，音频均由网关按需代理两个平台的官方 CDN 流。</li>
        <li>网易云部分接口由 api-enhanced 提供，QQ 音乐部分由 QQMusicApi 提供，两者均保持原样运行。</li>
        <li>登录 Sakura 的会话使用 HttpOnly Cookie + 服务端 Session，密码使用 scrypt 加盐散列。</li>
        <li>音乐版权归各平台所有，本项目仅供个人学习与研究使用。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.account-hint {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 6px 18px;
  padding: 12px 16px;
  border-radius: var(--radius);
  border: 1px dashed var(--border);
  color: var(--text-soft);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.2s ease;
}

.account-hint:hover {
  color: var(--brand-600);
  border-color: var(--brand-300);
  border-style: solid;
  background: rgba(var(--brand-rgb), 0.05);
}

.account-hint svg:last-child {
  margin-left: auto;
}
</style>
