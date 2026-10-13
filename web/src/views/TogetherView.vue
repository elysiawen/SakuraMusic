<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import TogetherPanel from '@/components/TogetherPanel.vue';
import { useRoomStore } from '@/stores/room';

/**
 * 「一起听」整页。
 *
 * 除了给弹层一个更宽敞的落脚点，它也是**邀请链接的落点**：好友打开
 * `/together?code=XXXX`，这里会在挂载时自动入房（已登录的前提下）。
 */
const route = useRoute();
const room = useRoomStore();

onMounted(() => {
  const code = String(route.query.code ?? '').trim();
  if (code && !room.active) void room.join(code);
});
</script>

<template>
  <section class="glass panel">
    <div class="panel-title">
      <AppIcon name="users" :size="17" />
      <h2>一起听</h2>
    </div>
    <p class="muted" style="font-size: 12.5px; line-height: 1.7; margin: 0 0 14px">
      和朋友在同一首歌上同步播放。创建房间后把房间码或邀请链接发给 TA，
      任一方都能切歌、暂停、拖动进度；有一方播不了的歌会自动跳过。
      <br />
      当前支持<b>双人一起听</b>（两人平权）；多人一起听（带房主与成员管理）还在开发中。
    </p>
    <TogetherPanel />
  </section>
</template>
