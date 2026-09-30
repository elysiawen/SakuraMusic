<script setup lang="ts">
/**
 * 详情页（专辑 / 歌单 / 歌手 / 榜单）的加载占位骨架。
 *
 * 关键做法：**复用真实的布局类**（.page-header / .stack / .track-row / .cover），
 * 于是三套形状都自动跟着走，不必在这里重写一遍：
 *   - 桌面：封面 208 方块 + 右侧文字块；
 *   - 手机（≤480）：封面通栏正方形 + 下方信息流（.page-header 的那些规则）；
 *   - 歌手页：居中圆头像（.is-avatar）。
 *
 * 之前各页面是一整块 190~220px 的空白流光方块：形状与真实内容完全对不上，
 * 内容到位时会明显跳一下，看着也像"页面坏了"。
 */
withDefaults(
  defineProps<{
    /** 曲目行占位数量。 */
    rows?: number;
    /** 歌手页：封面是圆形头像。 */
    avatar?: boolean;
  }>(),
  { rows: 4, avatar: false },
);
</script>

<template>
  <div class="detail-skeleton">
    <section class="page-header" :class="{ 'is-avatar': avatar }">
      <div class="cover" style="width: 208px; height: 208px; border-radius: 16px">
        <div class="sk skeleton-cover" />
      </div>

      <div class="stack" style="gap: 10px; min-width: 0; flex: 1">
        <!-- 依次对应：平台标签 / 标题 / 副标题 / 统计 -->
        <div class="sk" style="height: 12px; width: 34%" />
        <div class="sk" style="height: 30px; width: 64%" />
        <div class="sk" style="height: 13px; width: 44%" />
        <div class="sk" style="height: 13px; width: 52%" />

        <!-- 操作按钮那一行：手机端会被 .page-header 的规则拉通整行（见 main.css） -->
        <div class="row" style="gap: 8px">
          <div class="sk" style="height: 40px; width: 160px" />
        </div>
      </div>
    </section>

    <div class="track-list">
      <div v-for="index in rows" :key="index" class="track-row">
        <div class="row-index"><div class="sk" style="width: 12px; height: 12px" /></div>

        <div class="cover-btn">
          <div class="cover" style="width: 42px; height: 42px">
            <div class="sk skeleton-cover" />
          </div>
        </div>

        <div class="row-title"><div class="sk" style="height: 13px; width: 72%" /></div>

        <div class="row-meta">
          <div class="row-sub"><div class="sk" style="height: 11px; width: 58%" /></div>
          <div class="row-sub"><div class="sk" style="height: 11px; width: 46%" /></div>
        </div>

        <div class="row-sub row-duration"><div class="sk" style="height: 11px; width: 34px" /></div>

        <div class="row-actions">
          <div class="sk" style="width: 18px; height: 18px; border-radius: 999px" />
          <div class="sk" style="width: 18px; height: 18px; border-radius: 999px" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* .cover 是行内尺寸写死的（208 / 42），手机端由 main.css 的通栏规则改成满宽，
   里面的占位块跟着父盒走，所以这里只负责铺满。 */
.skeleton-cover {
  width: 100%;
  height: 100%;
  border-radius: inherit;
}

/* 歌曲信息那一列的两行占位在手机上要并排（.row-meta 在 ≤480 才变成 flex）。 */
.row-meta .row-sub .sk {
  margin-top: 2px;
}
</style>
