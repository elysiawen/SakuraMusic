/** 临时脚本：验证专辑排序（相关度 + 发行年份 + 平台序位）。验证完即删。 */
import { detectArtistIntent, mergeAlbumGroups, rankAlbums } from '../src/services/catalog';
import * as netease from '../src/upstream/netease';
import * as qq from '../src/upstream/qq';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function search(kw: string) {
  const ne = await netease.searchAlbums(kw, 1, 20, null);
  await sleep(600);
  const q = await qq.searchAlbums(kw, 1, 20, null);
  await sleep(600);
  const merged = mergeAlbumGroups([
    { platform: 'netease' as const, items: ne },
    { platform: 'qq' as const, items: q },
  ]);
  const intent = await detectArtistIntent(kw, null, null);
  return { ranked: rankAlbums(merged, kw, intent), intent };
}

async function main(): Promise<void> {
  for (const kw of [
    '太阳之子',
    '最伟大的作品',
    '1989',
    '范特西',
    '七里香',
    '叶惠美',
    '周杰伦',
    '林俊杰',
    '五月天',
    '晴天',
  ]) {
    const { ranked, intent } = await search(kw);
    console.log(`\n「${kw}」byArtist=${intent ?? '兜底'} 前 4:`);
    ranked.slice(0, 4).forEach((album, index) => {
      console.log(
        ` ${index + 1} ${album.name} | ${album.artists.map((a) => a.name).join('/')} | ${album.releaseDate ?? '-'} | ${album.sources.map((s) => s.platform).join('+')}`,
      );
    });
  }
}

void main();
