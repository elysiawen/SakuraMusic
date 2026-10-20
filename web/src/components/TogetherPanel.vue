<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { EntitlementPlatform, RoomEntitlementPending } from '@/api/room';
import { useRoomStore } from '@/stores/room';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { formatTogetherDuration } from '@/utils/format';
import AppIcon from './AppIcon.vue';

/**
 * 「一起听」面板内容。
 *
 * **双人房与多人房是两套界面**，由 `room.kind` 分岔（不要在这里散落其它判据）：
 * - 不在房间：提供创建（双人）与加入；多人房入口暂时禁用（逻辑未开放）；
 * - `duo` 双人房：两人对置的专用布局，没有成员管理，双方平权；
 * - `group` 多人房：成员列表 + 管理区（房主才可解散/踢人）——**空壳**，逻辑待实现。
 *
 * 弹层（TogetherButton）与整页（TogetherView）共用这一份内容。
 */
const room = useRoomStore();
const toast = useToast();
const confirm = useConfirm();

const joinCode = ref('');
const busy = ref(false);

/** 邀请链接：整页路由带房间码，好友打开即自动入房。 */
const inviteLink = computed(() =>
  room.code ? `${window.location.origin}/together?code=${room.code}` : '',
);

/** 双人房里对面那位是否在线（决定「同步中 / 等待中」与在线小圆点）。 */
const partnerOnline = computed(() => room.partner?.online === true);

/*
 * 时长读数的每秒节拍。
 *
 * 服务端只在房间快照里给一个整数秒，正在走表时并不会每秒推送 —— 靠这个节拍让读数自己走。
 * 只在走表（两人都在）时才起定时器，没人一起听的时候没有必要空转。
 */
const tick = ref(0);
let tickTimer: number | undefined;

watch(
  () => room.togetherCounting,
  (counting) => {
    if (counting && tickTimer === undefined) {
      tickTimer = window.setInterval(() => {
        tick.value += 1;
      }, 1000);
    } else if (!counting && tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
});

/*
 * 两个时长读数。都要读一下 tick 建立依赖，否则它们不会自己走。
 * 「本次」与「累计」必须分开显示：前者是这一次房间听了多久，后者是两人历史上的总时长。
 */
const sessionText = computed(() => {
  void tick.value;
  return formatTogetherDuration(room.togetherSessionLive());
});

const totalText = computed(() => {
  void tick.value;
  return formatTogetherDuration(room.togetherLive());
});

/* ---- 会员共享（按平台分开） ---- */

const PLATFORM_LABEL: Record<EntitlementPlatform, string> = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
};

const PLATFORMS: EntitlementPlatform[] = ['netease', 'qq'];

/** 我的账号 id（这里用账号级成员，旁观时也对得上）。 */
const myUserId = computed(() => room.accountMember?.userId ?? null);

/**
 * 两个平台各一行，三选一的当前值。
 *
 * `ownerId` 为 `null` = 各用各的（默认）；等于我的 id = 我在提供；等于对方 = 用对方的。
 */
const shareRows = computed(() =>
  PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABEL[platform],
    ownerId: room.entitlement.active[platform] ?? null,
    pending: room.entitlement.pending[platform] ?? null,
  })),
);

/** 需要**我**点头的请求：对方想用我的会员。 */
const pendingForMe = computed(() => room.entitlementRequestsForMe);

/** 我发出去、还没被确认的请求。 */
const pendingFromMe = computed(() => {
  const out: RoomEntitlementPending[] = [];
  for (const platform of PLATFORMS) {
    const item = room.entitlement.pending[platform];
    if (item && item.requestedBy === myUserId.value) out.push(item);
  }
  return out;
});

/** 我正在提供权益的平台（用于常驻提示，避免用户忘了自己开着共享）。 */
const sharedByMe = computed(() => room.mySharedPlatforms.map((platform) => PLATFORM_LABEL[platform]));

/**
 * 唯一一行状态说明。
 *
 * 面板里只留**必须说**的那句：等待对方确认（功能性的），或「你的播放会被记账」（合规性的）。
 * 「正在借用中」不在这里重复——播放条上已经有「共享」标记，说第二遍只会把面板塞满。
 */
const shareStatus = computed(() => {
  if (pendingFromMe.value.length) {
    const labels = pendingFromMe.value.map((item) => PLATFORM_LABEL[item.platform]);
    return `已发出请求，等 TA 确认${labels.join('、')}`;
  }
  if (sharedByMe.value.length) return 'TA 的播放会记在你的账号下';
  return '';
});

/**
 * 切换某平台的权益归属。
 *
 * 选对方时只是**发起请求**，不弹窗——真正需要知情并承担风险的是对方，
 * 由 TA 在自己的界面上确认（见 [confirmShare]）。
 */
function chooseShare(platform: EntitlementPlatform, targetUserId: string | null): void {
  const current = room.entitlement.active[platform] ?? null;
  const pending = room.entitlement.pending[platform] ?? null;
  // 已经是这个状态、或已经发过同一个请求：不重复打扰服务端和对方。
  if (current === targetUserId) return;
  if (targetUserId && pending?.targetUserId === targetUserId) return;

  room.setEntitlement(platform, targetUserId);
  if (targetUserId && targetUserId !== myUserId.value) {
    toast.info('已发起请求，等待 TA 确认');
  }
}

/**
 * 权益提供方确认/拒绝。
 *
 * 风险告知放在这里而不是发起方那边：被借用的是 TA 的账号，只有 TA 需要真正知情。
 */
async function confirmShare(platform: EntitlementPlatform, accept: boolean): Promise<void> {
  if (accept) {
    const ok = await confirm.ask({
      title: `把${PLATFORM_LABEL[platform]}的会员借给 TA？`,
      message: '同意后，TA 会用你的会员权益播放这一平台的歌。',
      // 逐条列后果：连成一段时只会被扫一眼就点掉。
      points: [
        { text: '可能违反平台协议，账号被限制或封禁', danger: true },
        { text: 'TA 的播放会记在你账号的播放记录里' },
        { text: '会占用你账号的并发设备数' },
      ],
      note: '随时可以切回「各自」，或退出房间来终止。',
      confirmLabel: '同意共享',
      // 这里是「关掉弹窗」，请求还挂在服务端——拒绝是下方卡片上的按钮，语义不能混。
      cancelLabel: '取消',
      danger: true,
    });
    if (!ok) return;
  }
  room.ackEntitlement(platform, accept);
}

function initial(nickname: string): string {
  return nickname.trim().slice(0, 1) || '友';
}

/**
 * 把播放从同账号的另一台设备转移过来。
 *
 * 走的就是 `join`：服务端那边「一个账号只占一个席位」，join 的语义本来就是接席位。
 * 对面会收到「席位已被接走」，降级为旁观（房间继续显示在那台上，可随时转移回来）。
 */
async function transferHere(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await room.transfer();
  } finally {
    busy.value = false;
  }
}

async function createDuo(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await room.create(undefined, 'duo');
  } finally {
    busy.value = false;
  }
}

async function joinRoom(): Promise<void> {
  const code = joinCode.value.trim();
  if (!code || busy.value) return;
  busy.value = true;
  try {
    await room.join(code);
    joinCode.value = '';
  } finally {
    busy.value = false;
  }
}

/** 复制房间码（链接复制不了时的退路，也方便直接口头报给对面）。 */
async function copyCode(): Promise<void> {
  if (!room.code) return;
  try {
    await navigator.clipboard.writeText(room.code);
    toast.success('房间码已复制');
  } catch {
    toast.info(`房间码：${room.code}`);
  }
}

async function copyInvite(): Promise<void> {
  const link = inviteLink.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    toast.success('邀请链接已复制，发给好友即可');
  } catch {
    // 剪贴板不可用（非 https / 无权限）：退回直接把房间码报出来。
    toast.info(`房间码：${room.code}`);
  }
}

async function leaveRoom(): Promise<void> {
  const ok = await confirm.ask({
    title: '退出一起听',
    message: '退出后本机恢复你自己的播放；房间会保留给另一位。',
    confirmLabel: '退出',
  });
  if (ok) await room.leave();
}

/**
 * 结束 / 解散房间。
 *
 * 双人房里「退出」就等于「结束」——一个人走，房间就散了，所以只有一个动作；
 * 文案也要把这条说清楚，避免用户以为对方还能继续听。
 */
async function dissolveRoom(): Promise<void> {
  const ok = await confirm.ask(
    room.isDuo
      ? {
          title: '结束一起听',
          message: '一个人结束，双方就都退出一起听，各自恢复自己的播放。',
          confirmLabel: '结束',
          danger: true,
        }
      : {
          title: '解散房间',
          message: '房间会被解散，所有成员都会退出。',
          confirmLabel: '解散',
          danger: true,
        },
  );
  if (ok) await room.dissolve();
}
</script>

<template>
  <!-- 不在房间：创建（双人）/ 加入 -->
  <div v-if="!room.active" class="together">
    <p class="muted together-intro">
      和朋友在同一首歌上同步播放，任一方都能切歌、拖动进度。
    </p>

    <button class="btn btn-primary together-cta" type="button" :disabled="busy" @click="createDuo">
      <AppIcon name="users" :size="16" />
      创建双人一起听
    </button>

    <!-- 多人房入口：先摆出来，点不动——逻辑尚未开放（见 room-store 的 isGroup / 服务端 roomPolicy）。 -->
    <button class="btn together-cta" type="button" disabled title="多人一起听还在开发中">
      <AppIcon name="users" :size="16" />
      创建多人一起听
      <span class="tag together-soon">开发中</span>
    </button>

    <div class="row together-join">
      <input
        v-model="joinCode"
        class="input"
        :maxlength="6"
        placeholder="输入房间码"
        @keyup.enter="joinRoom"
      />
      <button class="btn" type="button" :disabled="busy || !joinCode.trim()" @click="joinRoom">加入</button>
    </div>
  </div>

  <!-- ============ 双人房：两人对置，人人平权，无成员管理 ============ -->
  <div v-else-if="room.isDuo" class="together duo">
    <div class="duo-pair">
      <div class="duo-side">
        <!--
          用 accountMember 而不是 me：me 是**设备级**的，旁观（播放落在另一台设备上）
          时本机这条也是 false，照它画会把账号席位和对面那位画反。
        -->
        <span class="duo-avatar is-me">
          <img
            v-if="room.accountMember?.avatar"
            :src="room.accountMember.avatar"
            :alt="room.accountMember?.nickname"
          />
          <template v-else>{{ initial(room.accountMember?.nickname ?? '') }}</template>
        </span>
        <strong class="duo-name truncate">{{ room.accountMember?.nickname ?? '我' }}</strong>
        <span class="muted duo-sub truncate">{{ room.accountMember?.deviceName }}</span>
      </div>

      <!-- 中间那条「关系」：对面在线就是在同步，没来就是在等人。 -->
      <div class="duo-link" :class="{ 'is-live': partnerOnline, 'is-waiting': !partnerOnline }">
        <AppIcon name="link" :size="15" />
        <span>{{ partnerOnline ? '同步中' : room.partner ? '对方离线' : '等待中' }}</span>
      </div>

      <div class="duo-side">
        <template v-if="room.partner">
          <!--
            在线小圆点必须挂在这一层，不能放进 `.duo-avatar` 里面：
            头像为了裁成圆形开了 `overflow: hidden`，放在里面的话圆框会把点切掉一角。
          -->
          <span class="duo-avatar-wrap">
            <span class="duo-avatar" :class="{ 'is-offline': !partnerOnline }">
              <img v-if="room.partner.avatar" :src="room.partner.avatar" :alt="room.partner.nickname" />
              <template v-else>{{ initial(room.partner.nickname) }}</template>
            </span>
            <span v-if="partnerOnline" class="duo-dot" />
          </span>
          <strong class="duo-name truncate">{{ room.partner.nickname }}</strong>
          <span class="muted duo-sub truncate">
            {{ partnerOnline ? room.partner.deviceName : '暂时离线' }}
          </span>
        </template>
        <template v-else>
          <span class="duo-avatar is-empty"><AppIcon name="plus" :size="16" /></span>
          <strong class="duo-name">等待好友</strong>
          <span class="muted duo-sub">邀请 TA 加入</span>
        </template>
      </div>
    </div>

    <!--
      播放不在这台设备上（同账号的另一台在放）：必须把这句话写出来。
      不说的话，用户看到「一起听」「两人头像」「时长」都在、唯独这台设备没声，
      只会以为一起听坏了。
    -->
    <div v-if="room.spectating" class="duo-spectate">
      <p class="muted together-hint duo-spectate-hint">
        <AppIcon name="device" :size="14" />
        正在「{{ room.seatDeviceName ?? '你的另一台设备' }}」上播放，本机没在放。
      </p>
      <button class="btn btn-primary together-cta" type="button" :disabled="busy" @click="transferHere">
        转移到本机
      </button>
      <p class="muted together-hint">转移之后，那台设备会恢复单独播放。</p>
    </div>

    <!-- 人还没到齐：把邀请放在最显眼的地方。 -->
    <div v-if="!room.spectating && !room.partner" class="duo-invite">
      <div class="duo-invite-code">
        <span class="muted">房间码</span>
        <strong>{{ room.code }}</strong>
      </div>
      <div class="row together-actions">
        <button class="btn" type="button" @click="copyCode">
          <AppIcon name="copy" :size="14" />
          复制房间码
        </button>
        <button class="btn btn-primary" type="button" @click="copyInvite">
          <AppIcon name="link" :size="14" />
          复制邀请链接
        </button>
      </div>
      <p class="muted together-hint">把房间码或链接发给好友，TA 打开后自动加入。</p>
    </div>

    <!--
      人齐了：显示时长。两个读数必须各自标清楚 ——
      「本次」是这一次房间听了多久，「累计」是你们俩历史上一起听的总时长（跨房间、跨会话，落库）。
      对方还没进来时不知道"跟谁"一起听，所以这块也要等人齐才有意义。
    -->
    <div v-else-if="!room.spectating" class="duo-together">
      <div class="duo-together-row">
        <span class="duo-together-label">
          <AppIcon name="clock" :size="12" />
          本次
        </span>
        <strong>{{ sessionText }}</strong>
      </div>
      <div class="duo-together-row">
        <span class="duo-together-label">
          <AppIcon name="users" :size="12" />
          累计
        </span>
        <strong>{{ totalText }}</strong>
      </div>
    </div>

    <!--
      会员共享：两个平台各一行三选一。
      默认「各自」；选「用 TA 的」只是发起请求，必须 TA 本人确认才生效。
    -->
    <div v-if="!room.spectating && room.partner" class="duo-share">
      <div class="duo-share-head">
        <span class="duo-share-title">会员共享</span>
        <!--
          「会员不代表任意歌曲可播」这类说明挂在这里，而不是常年占一行正文：
          它只在有人想深究时才有用，平时是噪音。
        -->
        <span
          class="duo-share-info"
          title="会员状态来自平台账号，不代表任意歌曲可播（数字专辑、独家内容不随会员解锁）"
        >
          ?
        </span>
      </div>

      <div v-for="row in shareRows" :key="row.platform" class="duo-share-row">
        <span class="duo-share-label">{{ row.label }}</span>
        <div class="duo-share-seg" role="group" :aria-label="`${row.label}会员`">
          <button
            type="button"
            class="duo-share-opt"
            :class="{ 'is-on': !row.ownerId }"
            @click="chooseShare(row.platform, null)"
          >
            各自
          </button>
          <button
            type="button"
            class="duo-share-opt"
            :class="{ 'is-on': Boolean(myUserId) && row.ownerId === myUserId }"
            :disabled="!myUserId"
            @click="chooseShare(row.platform, myUserId)"
          >
            用我的
          </button>
          <button
            type="button"
            class="duo-share-opt"
            :class="{ 'is-on': Boolean(row.ownerId) && row.ownerId === room.partner?.userId }"
            :disabled="!room.partner"
            @click="chooseShare(row.platform, room.partner?.userId ?? null)"
          >
            用 TA 的
          </button>
        </div>
      </div>

      <!-- 全块唯一需要动手的地方：给边框和主按钮，别混在说明文字里 -->
      <div v-for="item in pendingForMe" :key="item.platform" class="duo-share-request">
        <span class="duo-share-request-text">
          {{ room.partner?.nickname ?? 'TA' }} 想用你的{{ PLATFORM_LABEL[item.platform] }}会员
        </span>
        <div class="duo-share-request-actions">
          <button
            class="duo-share-mini is-primary"
            type="button"
            @click="confirmShare(item.platform, true)"
          >
            同意
          </button>
          <button class="duo-share-mini" type="button" @click="confirmShare(item.platform, false)">
            拒绝
          </button>
        </div>
      </div>

      <p v-if="shareStatus" class="duo-share-status">{{ shareStatus }}</p>
    </div>

    <!--
      人齐之后不再显示房间码：双人房已经满了，这个号码没有任何用处了。
      露出它反而会让人以为"还能再叫一个人"。
    -->

    <!--
      双人房只有一个动作：一个人结束，房间就散了。
      「退出但让房间留着」在两个人之间没有意义（剩下那一个人也听不成一起听）。
      旁观设备上没有这个入口：服务端的解散是按席位设备鉴权的，本机连成员都不是。
    -->
    <button
      v-if="!room.spectating"
      class="btn together-dissolve together-end"
      type="button"
      @click="dissolveRoom"
    >
      <AppIcon name="logout" :size="14" />
      结束一起听
    </button>
  </div>

  <!-- ============ 多人房（空壳）：成员列表 + 管理区，逻辑待实现 ============ -->
  <div v-else class="together group">
    <!-- 多人房还没满，房间码要留着——这里随时可能再叫人来。 -->
    <div class="together-code-row">
      <span class="muted">房间码</span>
      <strong>{{ room.code }}</strong>
      <span class="muted group-count">{{ room.members.length }} / {{ room.capacity }} 人</span>
      <button class="btn together-code-copy" type="button" @click="copyInvite">
        <AppIcon name="link" :size="13" />
        复制邀请链接
      </button>
    </div>

    <ul class="together-members">
      <li v-for="member in room.members" :key="member.deviceId" class="together-member">
        <span class="together-avatar">
          <img v-if="member.avatar" :src="member.avatar" :alt="member.nickname" />
          <template v-else>{{ initial(member.nickname) }}</template>
        </span>
        <span class="stack" style="gap: 1px; min-width: 0">
          <strong class="truncate">{{ member.nickname }}</strong>
          <span class="muted truncate" style="font-size: 11.5px">{{ member.deviceName }}</span>
        </span>
        <span v-if="member.role === 'owner'" class="tag together-owner">房主</span>
        <span v-if="member.me" class="tag">我</span>
        <span v-else-if="!member.online" class="tag">离线</span>
      </li>
      <li v-if="room.members.length < room.capacity" class="muted together-waiting">
        还可加入 {{ room.capacity - room.members.length }} 人
      </li>
    </ul>

    <!-- 管理区：只有房主能解散/踢人；多人房逻辑未开放，所以整体是空壳。 -->
    <div class="group-manage">
      <span class="muted group-manage-title">成员管理</span>
      <div class="row together-actions">
        <button class="btn" type="button" disabled title="多人一起听还在开发中">踢出成员</button>
        <button
          class="btn together-dissolve"
          type="button"
          :disabled="!room.isOwner"
          :title="room.isOwner ? '解散房间，所有人都会退出' : '只有房主可以解散房间'"
          @click="dissolveRoom"
        >
          解散房间
        </button>
      </div>
      <p class="muted together-hint">多人一起听还在开发中，当前只支持双人房。</p>
    </div>

    <div class="row together-actions">
      <button class="btn" type="button" @click="leaveRoom">退出房间</button>
    </div>
  </div>
</template>

<style scoped>
.together {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.together-intro {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.together-cta {
  justify-content: center;
  gap: 6px;
}

.together-soon {
  margin-left: auto;
  color: var(--text-mute);
}

.together-join {
  gap: 6px;
}

.together-join .input {
  flex: 1;
  min-width: 0;
  text-transform: uppercase;
}

/* ---- 双人房：两人对置 ---- */
.duo-pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 6px;
  padding: 14px 10px;
  border-radius: var(--radius);
  background: var(--surface-hover);
}

.duo-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.duo-name {
  font-size: 13px;
  max-width: 100%;
}

.duo-sub {
  font-size: 11px;
  max-width: 100%;
}

/* 头像 + 在线小圆点的定位容器。 */
.duo-avatar-wrap {
  position: relative;
  display: grid;
  place-items: center;
}

.duo-avatar {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  /* 裁剪成圆：也正因为这个，在线小圆点不能放在里面（会被切掉一角）。 */
  overflow: hidden;
  font-size: 17px;
  font-weight: 640;
  color: var(--brand-600);
  background: var(--surface-strong);
  border: 1px solid var(--border);
}

.duo-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.duo-avatar.is-me {
  border-color: var(--brand-300);
  box-shadow: 0 0 0 3px rgba(var(--brand-rgb), 0.14);
}

.duo-avatar.is-offline {
  opacity: 0.55;
}

/* 等人：虚位以待，别做成一个看起来已经有人但灰掉的头像。 */
.duo-avatar.is-empty {
  color: var(--text-mute);
  background: transparent;
  border-style: dashed;
}

/*
 * 在线小圆点：压在头像右下缘。
 *
 * 46px 的圆在 45° 方向的边缘正好落在离包围盒右下角约 2px 处，所以右上对齐到这里，
 * 绿点看起来是「骑在」圆的边上，而不是浮在外面的空白处。
 */
.duo-dot {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #34c759;
  /* 描边取面板底色：绿点像是从圆的边缘切出来的，与头像之间有干净的缝隙。 */
  box-shadow: 0 0 0 2px var(--surface-hover);
}

/* 中间那条关系：在线是品牌色实心，等待中弱化成灰。 */
.duo-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 4px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

.duo-link.is-live {
  color: var(--brand-600);
}

.duo-link.is-waiting {
  color: var(--text-mute);
}

.duo-invite {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--brand-300);
  background: rgba(var(--brand-rgb), 0.06);
}

.duo-invite-code {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.duo-invite-code strong {
  font-size: 20px;
  letter-spacing: 3px;
  font-variant-numeric: tabular-nums;
}

/* 两种房间共用的说明文字（双人房的邀请提示、多人房的开发中提示）。 */
.together-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
}

/*
 * 「播放不在这台设备上」那一块。
 *
 * 用虚线框圈起来：它是一条**提示**，不是这个房间的常规内容——说清楚
 * 「歌在哪台上响、怎么搬过来」，本机才有意义。
 */
.duo-spectate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border);
}

.duo-spectate-hint {
  display: flex;
  align-items: center;
  gap: 6px;
}



/* 房间码一行：多人房用它继续拉人（双人房人齐后不再显示）。 */
.together-code-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
}

.together-code-row strong {
  font-size: 15px;
  letter-spacing: 2px;
  font-variant-numeric: tabular-nums;
}

.together-code-copy {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 4px 9px;
}

/* ---- 多人房：成员列表 + 管理区（空壳） ---- */
.group-count {
  font-size: 11.5px;
}

.group-manage {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border);
}

.group-manage-title {
  font-size: 11.5px;
  letter-spacing: 0.04em;
}

.together-members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.together-member {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
}

.together-avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  font-size: 13px;
  font-weight: 620;
  color: var(--brand-600);
  background: var(--surface-strong);
  border: 1px solid var(--border);
}

.together-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.together-owner {
  color: var(--brand-600);
}

.together-waiting {
  padding: 6px 4px;
  font-size: 12px;
  line-height: 1.6;
}

/* 一起听时长：两人都在时的两行小结（本次 / 累计）。 */
.duo-together {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  font-size: 12px;
}

.duo-together-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

/* 标签带个小图标：数字要能一眼分清是"这一次"还是"历史上总共"。 */
.duo-together-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--text-soft);
}

.duo-together-row strong {
  color: var(--brand-600);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* ---- 会员共享：两行分段控件，状态只说一句 ---- */
.duo-share {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.duo-share-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.duo-share-title {
  color: var(--text-soft);
  font-size: 12px;
}

/* 「会员不代表任意歌曲可播」挂在问号上，不占正文。 */
.duo-share-info {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--border);
  color: var(--text-mute);
  font-size: 9px;
  line-height: 1;
  cursor: help;
}

.duo-share-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.duo-share-label {
  flex: none;
  width: 64px;
  color: var(--text-soft);
}

/* 分段控件：三格等宽，选中整块填色——比描边更容易一眼看出「谁在出会员」。 */
.duo-share-seg {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  flex: 1;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
}

.duo-share-opt {
  height: 24px;
  padding: 0 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-soft);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.duo-share-opt:hover:not(:disabled):not(.is-on) {
  background: var(--surface-hover);
}

.duo-share-opt.is-on {
  background: var(--brand-600);
  color: #fff;
}

.duo-share-opt:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 待确认：全块唯一需要动手的地方，给主色边框把它拎出来。 */
.duo-share-request {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--brand-500);
  background: color-mix(in srgb, var(--brand-500) 8%, transparent);
}

.duo-share-request-text {
  min-width: 0;
  color: var(--text);
  line-height: 1.4;
}

.duo-share-request-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.duo-share-mini {
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-soft);
  font-size: 11px;
  cursor: pointer;
}

.duo-share-mini.is-primary {
  border-color: var(--brand-600);
  background: var(--brand-600);
  color: #fff;
}

.duo-share-status {
  margin: 0;
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.4;
}

/* 双人房唯一的动作：占满一行，别让它看起来像个次要按钮。 */
.together-end {
  justify-content: center;
  gap: 6px;
  width: 100%;
}

.together-actions {
  gap: 6px;
}

.together-actions .btn {
  flex: 1;
}

.together-dissolve {
  color: #d9534f;
}

.together-dissolve:disabled {
  color: var(--text-mute);
}
</style>
