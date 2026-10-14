/**
 * 网关用到的网易云接口，加上一批「常用、先暴露出来」的。
 *
 * 分两组：上半部分（到 `/likelist` 为止）是网关当前真正在调的；下半部分是一批常用的只读接口
 * （轮播、推荐歌单、热搜、相似歌曲……），网关还没接，留给后续接功能或别的客户端直接调用。
 *
 * 每一项对应上游 SDK 的一个模块函数（模块名 = 函数名，SDK 入口 `main.js` 按文件名逐个导出），
 * 路径与参数名沿用旧上游（api-enhanced 的 HTTP 层）那一套 —— 这个表就是契约，网关按它调。
 *
 * 参数表只作说明与自查用（对照 SDK 里 `query.xxx` 的实际读取），调用时 query 是原样透传的 ——
 * 与旧上游行为一致，少一个参数就悄悄少一个功能，不值得在这儿再维护一遍白名单。
 */
export interface Endpoint {
  /** HTTP 路径（网关按 `NETEASE_BASE_URL + path` 调用，必须与旧上游一致）。 */
  path: string;
  /** 上游 SDK 里的函数名。 */
  fn: string;
  /** 这个接口实际读取的查询参数。 */
  params: string[];
  /** 一句话说明（做什么、给谁用）。 */
  note: string;
}

export const ENDPOINTS: Endpoint[] = [
  {
    path: '/cloudsearch',
    fn: 'cloudsearch',
    params: ['keywords', 'type', 'limit', 'offset'],
    note: '搜索：单曲 / 专辑 / 歌手 / 歌单，靠 type 区分',
  },
  { path: '/song/detail', fn: 'song_detail', params: ['ids'], note: '曲目详情（含 privilege.maxBrLevel，音质档位靠它）' },
  { path: '/song/url/v1', fn: 'song_url_v1', params: ['id', 'level'], note: '取播放地址（按 level 要档位，拿不到时降级）' },
  { path: '/lyric', fn: 'lyric', params: ['id'], note: '歌词（原文 / 翻译 / 音译）' },
  { path: '/toplist', fn: 'toplist', params: [], note: '所有榜单' },
  { path: '/playlist/detail', fn: 'playlist_detail', params: ['id'], note: '歌单基础信息' },
  { path: '/playlist/track/all', fn: 'playlist_track_all', params: ['id', 'limit', 'offset'], note: '歌单曲目（分页）' },
  { path: '/artists', fn: 'artists', params: ['id'], note: '歌手信息 + 热门 50 首' },
  { path: '/artist/album', fn: 'artist_album', params: ['id', 'limit', 'offset'], note: '歌手专辑（分页）' },
  { path: '/album', fn: 'album', params: ['id'], note: '专辑详情 + 完整曲目' },
  { path: '/recommend/songs', fn: 'recommend_songs', params: [], note: '每日推荐（需登录）' },
  { path: '/personal_fm', fn: 'personal_fm', params: [], note: '私人 FM（需登录）' },
  { path: '/login/status', fn: 'login_status', params: [], note: '登录状态 / 账号资料（未登录时是匿名账号）' },
  { path: '/login/qr/key', fn: 'login_qr_key', params: [], note: '扫码登录：取二维码 key' },
  { path: '/login/qr/create', fn: 'login_qr_create', params: ['key', 'qrimg', 'platform'], note: '扫码登录：生成二维码图片' },
  { path: '/login/qr/check', fn: 'login_qr_check', params: ['key'], note: '扫码登录：轮询状态（803 成功，cookie 在 body 里）' },
  { path: '/user/playlist', fn: 'user_playlist', params: ['uid', 'limit', 'offset'], note: '账号的歌单（含「我喜欢的音乐」）' },
  { path: '/likelist', fn: 'likelist', params: ['uid'], note: '喜欢的歌曲 ID 列表' },

  /*
   * ── 常用、只读，网关还没接 ──────────────────────────────────────────────
   * 同样走那层 2 分钟响应缓存（GET + 200 就缓存、键含凭据），规则与上面一致。
   */
  { path: '/banner', fn: 'banner', params: ['type'], note: '首页轮播图（type 0 安卓 / 1 iOS / 2 PC …）' },
  { path: '/personalized', fn: 'personalized', params: ['limit', 'offset'], note: '推荐歌单' },
  { path: '/top/playlist', fn: 'top_playlist', params: ['cat', 'order', 'limit', 'offset'], note: '热门 / 分类歌单（cat 见 /playlist/catlist）' },
  { path: '/playlist/catlist', fn: 'playlist_catlist', params: [], note: '歌单分类标签（配合 /top/playlist）' },
  { path: '/search/hot', fn: 'search_hot', params: [], note: '热搜词' },
  { path: '/search/suggest', fn: 'search_suggest', params: ['keywords', 'type'], note: '搜索联想词' },
  { path: '/top/artists', fn: 'top_artists', params: ['limit', 'offset'], note: '歌手榜' },
  { path: '/top/album', fn: 'top_album', params: ['area', 'type', 'year', 'month', 'limit', 'offset'], note: '新碟榜' },
  { path: '/album/new', fn: 'album_new', params: ['area', 'limit', 'offset'], note: '新碟上架' },
  { path: '/simi/song', fn: 'simi_song', params: ['id', 'limit', 'offset'], note: '相似歌曲（“喜欢这首歌的人也听”）' },
  { path: '/simi/playlist', fn: 'simi_playlist', params: ['id', 'limit', 'offset'], note: '包含这首歌的歌单' },
  { path: '/user/record', fn: 'user_record', params: ['uid', 'type'], note: '听歌排行（type 0 本周 / 1 历史，需登录）' },
  {
    path: '/vip/info',
    fn: 'vip_info',
    params: ['uid'],
    note:
      '会员信息。**没被网关用上**：`redVipLevel` 是「红VIP等级」不是档位（官方文档的用词，且实测见过 7），' +
      '产品块 `associator` / `musicPackage` 的 `vipCode` / `vipLevel` 才是「VIP 类型」，' +
      '但官方没给枚举表、社区说法自相矛盾 —— 没有可靠依据就不猜档位，见 docs/API.md',
  },
];
