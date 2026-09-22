import type { ArtistRef } from '@/api/types';

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
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

/** 音质档位的中文名，播放器里展示。 */
export function qualityLabel(quality: string): string {
  return { standard: '标准', high: '高品', lossless: '无损', hires: 'Hi-Res' }[quality] ?? quality;
}
