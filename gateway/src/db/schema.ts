/**
 * 数据库结构定义。
 * 全部使用 `create table if not exists` 与 `create index if not exists`，
 * 因此启动时执行本脚本是幂等的，可直接作为迁移使用。
 */
export const SCHEMA_SQL = `
create table if not exists users (
  id            bigserial primary key,
  username      text        not null,
  password_hash text        not null,
  nickname      text        not null,
  avatar        text,
  role          text        not null default 'user',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists users_username_key on users (lower(username));

create table if not exists sessions (
  id         bigserial   primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  token_hash text        not null unique,
  user_agent text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

-- 服务端保存的第三方凭据（AES-256-GCM 加密）。
-- “仅本机”模式不会写入本表，凭据只存在于浏览器 IndexedDB。
create table if not exists credentials (
  id              bigserial   primary key,
  user_id         bigint      not null references users(id) on delete cascade,
  platform        text        not null,
  iv              bytea       not null,
  tag             bytea       not null,
  ciphertext      bytea       not null,
  profile         jsonb       not null default '{}'::jsonb,
  status          text        not null default 'active',
  last_error      text,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists credentials_user_platform_key on credentials (user_id, platform);

create table if not exists playlists (
  id          bigserial   primary key,
  user_id     bigint      not null references users(id) on delete cascade,
  name        text        not null,
  description text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists playlists_user_idx on playlists (user_id, created_at desc);

create table if not exists playlist_tracks (
  id          bigserial   primary key,
  playlist_id bigint      not null references playlists(id) on delete cascade,
  platform    text        not null,
  track_id    text        not null,
  track_mid   text,
  numeric_id  text,
  title       text        not null,
  artists     text        not null default '',
  album       text        not null default '',
  cover       text,
  duration_ms integer     not null default 0,
  position    integer     not null default 0,
  added_at    timestamptz not null default now()
);
create index if not exists playlist_tracks_idx on playlist_tracks (playlist_id, position);

/*
 * 后补的三列：歌手与专辑的 id / platform。
 *
 * 原先只存了歌手名文本与专辑名，于是从歌单里读回来的曲目缺 artist.id / album.id，
 * 前端「歌手」「专辑」两个链接的判据（name 之外还要有 id 与 platform）不成立，
 * 只能渲染成纯文本、点不动。收藏与播放历史是同一套列，一并补。
 *
 * add column if not exists 让老库同样能升上来 —— 本文件本来就是幂等的迁移脚本。
 * 老数据补不了 id（当初就没存），重新加一次歌即会有；这里不做回填。
 */
alter table playlist_tracks add column if not exists artists_json   jsonb;
alter table playlist_tracks add column if not exists album_id       text;
alter table playlist_tracks add column if not exists album_platform text;

create table if not exists favorites (
  id          bigserial   primary key,
  user_id     bigint      not null references users(id) on delete cascade,
  platform    text        not null,
  track_id    text        not null,
  track_mid   text,
  numeric_id  text,
  title       text        not null,
  artists     text        not null default '',
  album       text        not null default '',
  cover       text,
  duration_ms integer     not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists favorites_unique on favorites (user_id, platform, track_id);

alter table favorites add column if not exists artists_json   jsonb;
alter table favorites add column if not exists album_id       text;
alter table favorites add column if not exists album_platform text;

create table if not exists play_history (
  id          bigserial   primary key,
  user_id     bigint      not null references users(id) on delete cascade,
  platform    text        not null,
  track_id    text        not null,
  track_mid   text,
  numeric_id  text,
  title       text        not null,
  artists     text        not null default '',
  album       text        not null default '',
  cover       text,
  duration_ms integer     not null default 0,
  played_at   timestamptz not null default now()
);
create index if not exists play_history_idx on play_history (user_id, played_at desc);

alter table play_history add column if not exists artists_json   jsonb;
alter table play_history add column if not exists album_id       text;
alter table play_history add column if not exists album_platform text;
`;
