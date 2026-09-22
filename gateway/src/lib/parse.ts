/** 防御式解析工具：上游返回结构不稳定时保证不抛异常。 */

export function asObj(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

export function asArr(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function firstStr(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value).trim();
    if (text) return text;
  }
  return '';
}

export function firstNum(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed !== 0) return parsed;
  }
  return 0;
}

/** 去掉搜索结果里的 `<em>` 高亮标签。 */
export function stripHtml(value: unknown): string {
  return str(value).replace(/<[^>]+>/g, '');
}

/**
 * 跨平台去重用的标题归一化：小写、去括号内容、去 feat. 段落、去标点与空白。
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s+.*$/i, ' ')
    .replace(/[\s\-_.·・'"!?,，。！？、:：;；&＆+*]/g, '')
    .trim();
}

/** 跨平台去重用的歌手归一化。 */
export function normalizeArtist(artist: string): string {
  return artist.toLowerCase().replace(/[\s\-_.·・'"!?,，。！？、:：;；&＆+*]/g, '').trim();
}
