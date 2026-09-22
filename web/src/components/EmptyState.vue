<script setup lang="ts">
import AppIcon from './AppIcon.vue';

withDefaults(
  defineProps<{
    icon?: string;
    title: string;
    description?: string;
  }>(),
  { icon: 'music' },
);
</script>

<template>
  <div class="empty fade-in">
    <span class="empty-icon"><AppIcon :name="icon" :size="38" :stroke-width="1.4" /></span>
    <strong style="font-size: 15px">{{ title }}</strong>
    <span v-if="description" style="max-width: 420px">{{ description }}</span>
    <slot />
  </div>
</template>
