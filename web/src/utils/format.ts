import type { ArtistRef } from '@/api/types';

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


