import type { PlatformImportResult } from '@/api/types';

/**
 * 把导入结果说成一句人话。
 *
 * 被截断（触到单次上限）时必须说明白只导了前多少首 —— 否则用户以为整张都进来了。
 * 两个入口（音乐库、歌单详情页）共用这里，措辞只维护一份。
 */
export function describeImport(result: PlatformImportResult): string {
  return result.truncated
    ? `已导入「${result.playlist.name}」前 ${result.added} 首（原歌单共 ${result.total} 首）`
    : `已导入「${result.playlist.name}」共 ${result.added} 首`;
}
