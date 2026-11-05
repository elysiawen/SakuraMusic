export interface LyricWord {
  text: string;
  /** 起止时间（秒）；上游给的是毫秒，解析时换算。 */
  start: number;
  end: number;
}

export interface LyricLine {
  time: number;
  text: string;
  trans?: string;
  /** 逐字歌词才有；按行 LRC 模式下为 undefined。 */
  words?: LyricWord[];
  /** 本行结束时间（秒），逐字歌词才有。 */
  end?: number;
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

/* ------------------------------ 逐字歌词 ------------------------------ */

/** 网关的歌词响应（结构类型，避免 utils 反向依赖 api 层）。 */
export interface LyricResultLike {
  lrc?: string;
  trans?: string;
  roma?: string;
  /** 网易云 YRC 逐字歌词原文。 */
  yrc?: string;
  /** QQ 音乐 QRC 逐字歌词原文。 */
  qrc?: string;
}

export interface LyricDocument {
  lines: LyricLine[];
  /** 这份数据是否带字级时间轴（false 时按行渲染）。 */
  wordByWord: boolean;
}

/** 行首 `[开始ms,时长ms]`，YRC / QRC 共用。 */
const WORD_LINE = /^\[(\d+),(\d+)\](.*)$/;
/** YRC 字标签 `(开始ms,时长ms,0)`，文字跟在标签后面。 */
const YRC_WORD = /\((\d+),(\d+),\d+\)/g;
/** QRC 字标签 `(开始ms,时长ms)`，少数实现多一段 `(开始ms,时长ms,0)`。 */
const QRC_WORD = /\((\d+),(\d+)(?:,\d+)?\)/g;

/**
 * QQ 上游的 QRC 不是标签文本，而是 `<Lyric_1 ... LyricContent="...">` 的**属性**：
 * 整份逐字歌词（含换行）都塞在属性里，直接剥标签会把歌词一起丢掉。
 * 少数来源会给纯 QRC 文本，此时退回「去掉 XML 标签」的兜底。
 */
function extractQrc(source: string): string {
  const attr = source.match(/LyricContent\s*=\s*(["'])([\s\S]*?)\1/);
  const raw = attr?.[2] ?? source.replace(/<[^>]+>/g, '\n');
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;|&#x0A;/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    // 最后解 &amp;，避免把 &amp;quot; 二次解码成引号。
    .replace(/&amp;/g, '&');
}

function makeWordLine(startMs: number, durationMs: number, words: LyricWord[]): LyricLine {
  const time = startMs / 1000;
  /*
   * 多数上游的字时间戳是绝对值（与行首同一时间轴）；少数 QRC 变体给的是
   * 「相对本行开头」的偏移。第一个字明显早于行首时按相对值处理。
   */
  const firstStart = words[0]?.start ?? 0;
  const offset = firstStart >= 0 && firstStart < time - 0.5 ? time : 0;
  const normalized = offset
    ? words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset }))
    : words;
  return {
    time,
    end: (startMs + durationMs) / 1000,
    text: normalized.map((word) => word.text).join(''),
    words: normalized,
  };
}

/** YRC：`(开始,时长,0)字`，文字在标签之后、到下一个标签为止。 */
function yrcWords(rest: string): LyricWord[] {
  const tags = [...rest.matchAll(YRC_WORD)];
  const words: LyricWord[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag) continue;
    const from = (tag.index ?? 0) + tag[0].length;
    const to = tags[index + 1]?.index ?? rest.length;
    const text = rest.slice(from, to);
    if (!text) continue;
    const startMs = Number(tag[1]);
    words.push({ text, start: startMs / 1000, end: (startMs + Number(tag[2])) / 1000 });
  }
  return words;
}

/**
 * QRC：字标签是 `(开始,时长)`，但文字可能在标签前（`字(0,300)字(300,300)`）
 * 也可能在标签后（`(0,300)字(300,300)字`）。按首尾哪一侧有正文来判断。
 */
function qrcWords(rest: string): LyricWord[] {
  const tags = [...rest.matchAll(QRC_WORD)];
  if (tags.length === 0) return [];

  const chunks: string[] = [];
  let cursor = 0;
  for (const tag of tags) {
    const at = tag.index ?? cursor;
    chunks.push(rest.slice(cursor, at));
    cursor = at + tag[0].length;
  }
  chunks.push(rest.slice(cursor));

  const first = chunks[0] ?? '';
  const last = chunks[chunks.length - 1] ?? '';
  const prefersBefore = first.trim().length > 0 && last.trim().length === 0;
  const prefersAfter = first.trim().length === 0 && last.trim().length > 0;

  const words: LyricWord[] = [];
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag) continue;
    const before = chunks[index] ?? '';
    const after = chunks[index + 1] ?? '';
    let text: string;
    if (prefersBefore) text = before;
    else if (prefersAfter) text = after;
    else if (after.trim() && !before.trim()) text = after;
    else if (before.trim() && !after.trim()) text = before;
    else text = after.length >= before.length ? after : before;
    if (!text.trim()) continue;
    const startMs = Number(tag[1]);
    words.push({ text, start: startMs / 1000, end: (startMs + Number(tag[2])) / 1000 });
  }
  return words;
}

/** 解析逐字歌词原文；解析不出任何字级时间轴时返回空数组，调用方按行降级。 */
export function parseWordLines(source: string, format: 'yrc' | 'qrc'): LyricLine[] {
  if (!source?.trim()) return [];
  const text = (format === 'qrc' ? extractQrc(source) : source).replace(/^\uFEFF/, '');
  const lines: LyricLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(WORD_LINE);
    if (!match) continue;
    const words = format === 'yrc' ? yrcWords(match[3] ?? '') : qrcWords(match[3] ?? '');
    if (words.length > 0) lines.push(makeWordLine(Number(match[1]), Number(match[2]), words));
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** 逐字行是毫秒级、LRC 翻译是秒级，按最接近的时间点（容差 0.6s）挂上翻译。 */
function nearestTranslation(lines: LyricLine[], time: number): string | undefined {
  if (lines.length === 0) return undefined;
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((lines[mid]?.time ?? 0) < time) low = mid + 1;
    else high = mid;
  }
  let best: LyricLine | undefined;
  // 翻译 LRC 的时间戳常与原文差几十毫秒，会被 parseLyric 拆成相邻的空文本行；
  // 所以在落点附近几行里挑「有翻译且时间最近」的那条，而不是只取落点本身。
  for (let index = Math.max(0, low - 3); index <= Math.min(lines.length - 1, low + 3); index += 1) {
    const candidate = lines[index];
    if (!candidate?.trans || Math.abs(candidate.time - time) > 0.6) continue;
    if (!best || Math.abs(candidate.time - time) < Math.abs(best.time - time)) best = candidate;
  }
  return best?.trans;
}

/**
 * 统一入口：按行歌词始终保留，上游给了逐字歌词且能解析出字级时间轴时才用它覆盖主时间轴，
 * 翻译仍从按行数据里带过来。客户端只认这个结果，不用关心上游是网易云还是 QQ 音乐。
 */
export function parseLyricResult(result: LyricResultLike): LyricDocument {
  const lineLyrics = parseLyric(result.lrc ?? '', result.trans ?? '', result.roma ?? '');
  let wordLyrics = result.yrc ? parseWordLines(result.yrc, 'yrc') : [];
  if (wordLyrics.length === 0 && result.qrc) wordLyrics = parseWordLines(result.qrc, 'qrc');
  if (wordLyrics.length === 0) return { lines: lineLyrics, wordByWord: false };
  return {
    lines: wordLyrics.map((line) => ({ ...line, trans: nearestTranslation(lineLyrics, line.time) })),
    wordByWord: true,
  };
}

/** 每个字的演唱进度：0 未唱、1 已唱完，中间值为当前字的擦除比例。 */
export function wordProgress(words: LyricWord[], currentSeconds: number): number[] {
  return words.map((word) => {
    if (currentSeconds >= word.end) return 1;
    if (currentSeconds <= word.start) return 0;
    const duration = Math.max(word.end - word.start, 0.01);
    return Math.min(1, (currentSeconds - word.start) / duration);
  });
}
