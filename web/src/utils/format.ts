import type { ArtistRef, Platform } from '@/api/types';

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 把「一起听了多久」说成人话。
 *
 * 与 `formatDuration`（mm:ss，给单曲进度用）不同：这是长期累计的时段，以分钟/小时为主，
 * 而且要能表达「刚开始」这种 0 附近的状况，不能显示成 0:00。
 */
export function formatTogetherDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '刚刚开始';
  const total = Math.floor(seconds);
  if (total < 60) return '不到 1 分钟';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes} 分钟`;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

/**
 * 一起听明细里的时间点：日期 + 时刻。
 *
 * 与 `formatRelativeTime`（「3 分钟前」）不同：翻明细时要的是**具体哪天**，相对时间反而看不出先后。
 * 同一年不写年份，跨年的才带上 —— 明细里绝大多数都是今年的。
 */
export function formatSessionTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  const sameYear = time.getFullYear() === new Date().getFullYear();
  return time.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatArtists(artists: ArtistRef[]): string {
  return artists.map((item) => item.name).filter(Boolean).join(' / ') || '未知歌手';
}

export function formatCount(value: number | undefined): string {
  if (!value) return '';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

export function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(time).toLocaleDateString('zh-CN');
}

/** 由昵称生成一个稳定的柔和渐变色，用于默认头像。 */
export function avatarGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  const from = `hsl(${hash}, 78%, 72%)`;
  const to = `hsl(${(hash + 48) % 360}, 74%, 62%)`;
  return `linear-gradient(135deg, ${from}, ${to})`;
}

/**
 * 会员档位标识 → 界面文案。
 *
 * 网关发的 `vipLabel` 是**上游字段名**（ASCII，不本地化，接口里不塞展示文案），
 * 所以中文只出现在这里 —— 要改叫法、要出英文版，都只动这张表：
 *   QQ 音乐  `vip` → 绿钻、`svip` → 豪华绿钻、`huge_vip` → 超级会员
 *
 * ⚠️ **QQ 那三行看着别扭，但别"顺手修"**：QQ 的字段名和产品名是反的 ——
 * `huge_vip`（名字像"豪华"）实际是**超级会员**，`svip` 才是**豪华绿钻**。
 * 这是拿真实账号核对过的（`huge_vip_end` 与其超级会员到期日、`eight_end` 与 App 里
 * 豪华绿钻到期日一一对上），原因与证据写在 `gateway/src/upstream/qq.ts` 那段注释里。
 *
 * **网易云不查这张表**：上游给不出可靠的档位（`redVipLevel` 是「红VIP等级」不是档位，
 * 产品编码 `vipCode` 又没有官方枚举表），所以网关干脆不发 `vipLabel` —— 既然只知道
 * 「是不是会员」，就统一显示 `VIP`，不假装知道哪一档。依据见
 * `gateway/src/upstream/netease.ts` 与 docs/API.md。
 *
 * 同一个标识在两个平台含义不同（都是 `vip`，一边是绿钻、一边是黑胶VIP），
 * 所以必须按平台查。QQ 侧认不出来的标识、以及旧数据里没有标识的，退到通用的「会员」——
 * 「是会员但不知道哪一档」，比空着或不显示都准。
 */
const VIP_LABEL_TEXT: Record<Platform, Record<string, string>> = {
  qq: { vip: '绿钻', svip: '豪华绿钻', huge_vip: '超级会员' },
  netease: {},
};

export function formatVipLabel(platform: Platform, vipLabel: string | undefined): string {
  if (platform === 'netease') return 'VIP';
  return (vipLabel && VIP_LABEL_TEXT[platform][vipLabel]) || '会员';
}


