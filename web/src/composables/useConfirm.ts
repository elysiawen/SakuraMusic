import { readonly, ref } from 'vue';

/** 一条后果：一行只说一件事，扫得动也就真的会被读到。 */
export interface ConfirmPoint {
  text: string;
  /** 会造成账号风险的条目，用危险色标出来；全都标红等于没标。 */
  danger?: boolean;
}

export interface ConfirmOptions {
  title: string;
  /** 铺垫一句就够，别把长段话塞进来——后果请用 [points] 逐条列。 */
  message?: string;
  /** 逐条列出的后果。列表比一整段话好读，也不会被一眼扫过去。 */
  points?: ConfirmPoint[];
  /** 列表之后的一句收尾（比如「随时可以取消」）。 */
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除、解绑等）：确认按钮渲染成红色。 */
  danger?: boolean;
}

/**
 * 全局确认弹窗。
 *
 * 用法：`if (!(await useConfirm().ask({ title: '删除歌单' }))) return;`
 * 与 window.confirm 一样是「等待用户选择」的语义，但用的是项目自己的弹窗，
 * 不会出现浏览器原生那种和整站风格脱节的样式。
 */
interface PendingConfirm extends ConfirmOptions {
  id: number;
}

const pending = ref<PendingConfirm | null>(null);
let settleFn: ((value: boolean) => void) | null = null;
let seed = 0;

function ask(options: string | ConfirmOptions): Promise<boolean> {
  const detail: ConfirmOptions = typeof options === 'string' ? { title: options } : options;
  // 上一个还没处理就再弹一个：把前者按「取消」结掉，否则它的 Promise 永远挂着。
  settleFn?.(false);
  seed += 1;
  pending.value = { ...detail, id: seed };
  return new Promise<boolean>((resolve) => {
    settleFn = resolve;
  });
}

function settle(value: boolean): void {
  pending.value = null;
  const resolve = settleFn;
  settleFn = null;
  resolve?.(value);
}

export function useConfirm() {
  return { ask };
}

/** 仅供 ConfirmHost 使用：读取待确认项并回填结果。 */
export function useConfirmHost() {
  return { pending: readonly(pending), settle };
}
