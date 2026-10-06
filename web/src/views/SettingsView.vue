<script setup lang="ts">
import { PLATFORM_LABEL, QUALITY_LABEL, type Platform, type Quality } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import BackgroundPicker from '@/components/BackgroundPicker.vue';
import ThemePicker from '@/components/ThemePicker.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { useToast } from '@/composables/useToast';
import { usePlayerStore, type RouteMode } from '@/stores/player';
import { useThemeStore } from '@/stores/theme';

/**
 * 设置：只管「这台设备怎么用」，即外观与播放偏好。
 * 账号资料、第三方绑定、密码等身份相关内容都在「账户中心」。
 */
const player = usePlayerStore();
const theme = useThemeStore();
const toast = useToast();

const platforms: Platform[] = ['netease', 'qq'];
/*
 * 默认音质的候选。高级档（高清臻音 / 超清母带 / 沉浸环绕声）也要列出来：音质面板里选了它们就会写进
 * 这个偏好，设置页要是没有对应的芯片，用户会发现"面板里选了、这里却没有任何一个是选中的"。
 */
const qualities: Quality[] = [
  'standard',
  'high',
  'lossless',
  'hires',
  'spatial',
  'master',
  'surround',
];

/*
 * 取流方式按平台分别设置（智能 / 直连 / 中转）。
 * 文案对齐手机客户端那一组「连接方式」：三项的区别恰恰在"直连不通时怎么办"，
 * 所以说明里必须写清失败后的行为，只写「直连」「中转」看不出差别。
 */
const routeOptions = [
  { value: 'auto', label: '智能', hint: '直连优先，被 CDN 拒绝时自动改用中转并记住' },
  { value: 'direct', label: '直连', hint: '始终从平台 CDN 取流；不通就直接失败，不自动改走中转' },
  { value: 'proxy', label: '中转', hint: '始终经网关转发，用服务器带宽换稳定' },
];

function chooseRoute(platform: Platform, value: string): void {
  player.setRouteMode(platform, value as RouteMode);
}

/**
 * 「实际走法」与所选档位不一致时补一句提示。
 *
 * 只有一种情况需要说：这个平台直连被拒过，而档位不是「中转」——
 * 此时「智能」实际走的是网关、「直连」则会直接播放失败，跟按钮上选的那个名字对不上。
 * 正常情况返回空串，不占版面。
 */
function routeStatus(platform: Platform): string {
  if (!player.proxyOnly.includes(platform)) return '';
  const mode = player.routeModeOf(platform);
  if (mode === 'proxy') return '';
  return mode === 'direct'
    ? '直连被拒过；这个档位不自动回退，播放会直接失败'
    : '直连被拒过，当前实际走网关中转';
}

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

/**
 * 「关于」里列出来的**上游**项目。
 *
 * 只列真正的上游（网易云与 QQ 音乐这两条链路各自依赖了什么），框架/库不进这里。
 * 地址一律用官方仓库（取自 `scripts/bootstrap.mjs` 的克隆地址与 PyPI 包元数据，不是凭印象写的）；
 * 用途写清楚"它在本项目里干什么"，否则一堆库名看不出所以然。
 */
const CREDITS = [
  {
    group: '音乐上游',
    items: [
      {
        name: 'api-enhanced',
        note: '网易云音乐上游（MIT）。本仓库不含其源码，只在同级目录以独立进程 + HTTP 使用',
        url: 'https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced',
      },
      {
        name: 'QQMusicApi / qqmusic-api-python',
        note: 'QQ 音乐 SDK（GPLv3，PyPI 发布版 0.7.3）。本仓库自带的 qq-upstream 基于它实现三种扫码登录',
        url: 'https://github.com/l-1124/QQMusicApi',
      },
    ],
  },
];

const REPO_URL = 'https://github.com/elysiawen/SakuraMusic';
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
          <span class="muted" style="font-size: 11px">
            「高清臻音」「超清母带」「沉浸环绕声」两个平台都有，但需要对应等级的会员；等级不够时会自动降级到能播的档位。
          </span>
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
          <span class="field-label">取流方式（按平台分别设置）</span>
          <div v-for="platform in platforms" :key="platform" class="stack" style="gap: 8px">
            <span class="muted" style="font-size: 12px; font-weight: 650; padding-left: 2px">
              {{ PLATFORM_LABEL[platform] }}
            </span>
            <div class="row" style="gap: 8px; flex-wrap: wrap">
              <button
                v-for="option in routeOptions"
                :key="option.value"
                class="chip"
                :class="{ 'is-active': player.routeModeOf(platform) === option.value }"
                type="button"
                :title="option.hint"
                @click="chooseRoute(platform, option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <!-- 只有「实际走法」和所选档位不一致（直连被拒过）时才补一句，正常情况不占地方 -->
            <span v-if="routeStatus(platform)" class="muted" style="font-size: 11.5px; padding-left: 2px">
              {{ routeStatus(platform) }}
            </span>
          </div>
          <div v-if="player.proxyOnly.length > 0" class="row" style="gap: 8px; flex-wrap: wrap">
            <button class="chip" type="button" @click="retryDirect">
              <AppIcon name="refresh" :size="13" />
              重新尝试直连
            </button>
            <span class="muted" style="font-size: 11.5px">清除「直连被拒」的记录，下次播放重新试直连</span>
          </div>
          <span class="muted" style="font-size: 11.5px; padding-left: 2px">
            能直连时由浏览器自己向平台 CDN 取流，不占服务器带宽；CDN 会校验来源（防盗链、混合内容），被拒时「智能」会自动改用网关中转并记住这个平台，「直连」直接失败，「中转」始终走网关。
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
        <li>登录 Sakura 的会话使用 HttpOnly Cookie + 服务端 Session，密码使用 scrypt 加盐散列。</li>
        <li>音乐版权归各平台所有，本项目仅供个人学习与研究使用。</li>
      </ul>

      <p class="muted credit-note" style="margin: 12px 0 0">
        源码：
        <a :href="REPO_URL" target="_blank" rel="noreferrer noopener">{{ REPO_URL }}</a>
      </p>

      <!--
        用到的第三方项目：名字、用途、地址都写出来。
        地址用官方仓库（网易云上游与 QQ 音乐 SDK 的地址取自 scripts/bootstrap.mjs 的克隆地址与 PyPI 包元数据），
        方便自行核对版本与许可证。
      -->
      <div v-for="credit in CREDITS" :key="credit.group" class="credit-group">
        <h3 class="credit-title">{{ credit.group }}</h3>
        <ul class="credit-list">
          <li v-for="item in credit.items" :key="item.url">
            <a :href="item.url" target="_blank" rel="noreferrer noopener">{{ item.name }}</a>
            <span v-if="item.note" class="muted credit-note">{{ item.note }}</span>
            <code class="credit-url">{{ item.url }}</code>
          </li>
        </ul>
      </div>
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

/* ------------------------- 「关于」里的第三方项目 ------------------------- */

.credit-group {
  margin-top: 14px;
}

.credit-title {
  margin: 0 0 7px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-soft);
}

.credit-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}

.credit-list li {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-strong);
}

.credit-list a {
  font-size: 13px;
  font-weight: 600;
  color: var(--brand-600);
  text-decoration: none;
}

.credit-list a:hover {
  text-decoration: underline;
}

.credit-note {
  font-size: 12px;
  line-height: 1.7;
}

/* 地址单独一行、等宽字体：好看清是哪个站点，也方便复制。 */
.credit-url {
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
}

.account-hint svg:last-child {
  margin-left: auto;
}
</style>
