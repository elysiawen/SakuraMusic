import { readonly, ref } from 'vue';

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error';
}

const toasts = ref<Toast[]>([]);
let seed = 0;

function push(message: string, type: Toast['type'], duration = 3200): void {
  const id = (seed += 1);
  toasts.value = [...toasts.value, { id, message, type }];
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, duration);
}

export function useToast() {
  return {
    toasts: readonly(toasts),
    info: (message: string) => push(message, 'info'),
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error', 4200),
  };
}
