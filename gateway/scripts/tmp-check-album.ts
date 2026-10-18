/** 临时探查：同名单曲/翻唱在 trackCount、平台序位上的区别。 */
import { mergeAlbumGroups } from '../src/services/catalog';
import * as netease from '../src/upstream/netease';
import * as qq from '../src/upstream/qq';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.,'’"“”()（）[\]【】·!！?？&+]/g, '');

async function main(): Promise<void> {
  for (const kw of ['太阳之子', '范特西', '叶惠美']) {
    const ne = await netease.searchAlbums(kw, 1, 20, null);
    await sleep(500);
    const q = await qq.searchAlbums(kw, 1, 20, null);
    const merged = mergeAlbumGroups([
      { platform: 'netease' as const, items: ne },
      { platform: 'qq' as const, items: q },
    ]);
    console.log(`\n=== 「${kw}」共 ${merged.length} 条（按 title 命中 + trackCount 排列）`);
    for (const { album, rank } of merged) {
      const exact = norm(album.name) === norm(kw) ? '同名' : '    ';
      console.log(
        ` ${exact} rank=${String(rank).padStart(2)} tracks=${String(album.trackCount ?? '-').padStart(2)} ${album.releaseDate ?? '----------'} ${album.artists.map((a) => a.name).join('/')} ｜ ${album.name}`,
      );
    }
    await sleep(500);
  }
}

void main();
