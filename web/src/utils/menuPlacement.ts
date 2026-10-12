/**
 * 弹层朝哪边弹的纯规则。
 *
 * 候选弹层（音质 / 音源 / 设备 / 队列）都贴在某个芯片旁边，而芯片可能在屏幕底部（播放条）、
 * 顶部（全屏歌词页顶栏）或中间。规则本身只有三行，但它是一个「输入三元」的布尔判断，
 * 写反了很难在设计稿上发现 —— 实际症状是"面板明明该往上弹，却全被屏幕底边裁掉"。
 * 所以单独抽出来，让它可以被自检钉住。
 */

/** 一侧至少有这么多像素才算"放得下"：比这更矮的话面板只能塞一两行，不如换边。 */
export const MENU_MIN_SPACE_PX = 160;

export interface MenuSpace {
  /** 芯片上方可用高度（px）。 */
  above: number;
  /** 芯片下方可用高度（px）。 */
  below: number;
}

/**
 * 返回面板该往哪边弹。
 *
 * 顺序是：**首选那侧放得下就用它**（尊重调用方声明的语义，比如"播放条上的芯片一律朝上"），
 * 首选那侧哪怕放不下、但只要比另一侧宽敞也还是用它（换过去只会更差），
 * 只有首选那侧明显更窄时才翻到另一侧。
 */
export function resolveMenuDirection(space: MenuSpace, preferDown: boolean): 'up' | 'down' {
  const primary = preferDown ? space.below : space.above;
  const secondary = preferDown ? space.above : space.below;

  // `primary` 的含义随 preferDown 变（声明 up 时它是"上方空间"），
  // 所以最后要按 preferDown 折算回来：直接把 primary 当"该往下弹"用，方向就正好反了。
  const usePrimary = primary >= MENU_MIN_SPACE_PX || primary >= secondary;
  const down = preferDown ? usePrimary : !usePrimary;

  return down ? 'down' : 'up';
}
