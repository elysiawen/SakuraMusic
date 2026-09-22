export interface LyricLine {
  time: number;
  text: string;
  trans?: string;
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 解析 LRC 文本；同一行有多个时间标签时会展开成多条。 */
function parseLines(source: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!source) return map;

  for (const rawLine of source.split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(TIME_TAG)];
    if (tags.length === 0) continue;
    const text = rawLine.replace(TIME_TAG, '').trim();
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const fraction = tag[3] ? Number(tag[3].padEnd(3, '0')) / 1000 : 0;
      const time = minutes * 60 + seconds + fraction;
      map.set(Math.round(time * 100) / 100, text);
    }
  }
  return map;
}

/** 合并原词与翻译，按时间排序，过滤纯空行。 */
export function parseLyric(lrc: string, trans = '', roma = ''): LyricLine[] {
  const main = parseLines(lrc);
  const translation = parseLines(trans);
  const roman = parseLines(roma);
  const times = [...new Set([...main.keys(), ...translation.keys()])].sort((a, b) => a - b);

  return times
    .map((time) => {
      const text = main.get(time) ?? '';
      const transText = translation.get(time) ?? roman.get(time) ?? '';
      return { time, text, trans: transText || undefined };
    })
    .filter((line) => line.text || line.trans);
}

/** 返回当前时间对应的歌词行下标，未命中时返回 -1。 */
export function activeLineIndex(lines: LyricLine[], currentSeconds: number): number {
  if (lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const line = lines[mid];
    if (line && line.time <= currentSeconds) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}
