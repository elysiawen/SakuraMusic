<script setup lang="ts">
/**
 * 开关。用于设置页里的布尔项（外观特效等）。
 * 用 button + role="switch" 而不是 checkbox，语义与样式都更直接。
 */
const props = defineProps<{
  modelValue: boolean;
  label: string;
  /** 补充说明，写清楚开启/关闭的影响。 */
  hint?: string;
}>();

const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>();
</script>

<template>
  <div class="row" style="gap: 16px; align-items: center; justify-content: space-between">
    <span class="stack" style="gap: 2px; min-width: 0">
      <span style="font-size: 12.5px; font-weight: 650">{{ props.label }}</span>
      <span v-if="props.hint" class="muted" style="font-size: 11.5px; line-height: 1.6">
        {{ props.hint }}
      </span>
    </span>

    <button
      class="switch"
      type="button"
      role="switch"
      :aria-checked="props.modelValue"
      :aria-label="props.label"
      :title="props.modelValue ? '点击关闭' : '点击开启'"
      @click="emit('update:modelValue', !props.modelValue)"
    >
      <span class="switch-knob" />
    </button>
  </div>
</template>

<style scoped>
.switch {
  position: relative;
  flex: none;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.switch-knob {
  position: absolute;
  top: 50%;
  left: 3px;
  width: 16px;
  height: 16px;
  margin-top: -8px;
  border-radius: 999px;
  background: var(--text-mute);
  transition:
    left 0.2s ease,
    background 0.2s ease;
}

.switch[aria-checked='true'] {
  background: rgba(var(--brand-rgb), 0.22);
  border-color: var(--brand-400);
}

.switch[aria-checked='true'] .switch-knob {
  /* 42 - 边框 2 = 40 内宽，滑块 16，两侧留 3 才对称。 */
  left: 21px;
  background: var(--brand-500);
}
</style>
