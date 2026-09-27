"""歌曲路由：详情 / 播放地址 / 歌词。

对齐原 web 层的声明（`QQMusicApi/web/src/routes/song.py`、`routes/lyric.py`）。
网关实际用到：详情（无查询参数）、取流（只传 `file_type`）、歌词（只传 `trans` 与 `roma`）。

`file_type` 是**枚举成员下标**而非枚举值：原 web 层就是这么换算的，
网关的 `QQ_FILE_TYPES`（1=MASTER、7=FLAC、12=MP3_320、13=MP3_128）也按这个下标定，
所以这里用 `list(SongFileType)[index]`，保证两边对同一档位取到同一个成员。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from qqmusic_api.modules.song import SongFileInfo, SongFileType

from cache import cache_key, response_cache
from envelope import ok
from session import as_id, credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/song", tags=["song"])

_SONG_FILE_TYPES = list(SongFileType)

# 取流地址里带着时效性 vkey，缓存必须短：只用来吸收「同一首歌被反复请求」的抖动
# （网关侧自己还有 10 分钟的直链缓存）。
URL_CACHE_TTL_SECONDS = 60.0


def _song_value(value: str) -> int | str:
    """纯数字按 song_id 传，其余按 song_mid 传（判据见 `session.as_id`）。"""
    return as_id(value)


def _file_type(value: int) -> SongFileType:
    if value < 0 or value >= len(_SONG_FILE_TYPES):
        raise HTTPException(status_code=422, detail=f"不支持的 file_type：{value}")
    return _SONG_FILE_TYPES[value]


@router.get("/{value}/detail")
async def song_detail(value: str, request: Request) -> dict[str, object]:
    """歌曲详情。响应里的 `data.track` 就是网关 mapQqSong 读的那个对象。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))
    song = _song_value(value)

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.song.get_detail(song)

    key = cache_key("song_detail", value, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/{mid}/url")
async def song_url(
    mid: str,
    request: Request,
    file_type: int = Query(13),
    song_type: int | None = Query(None),
    media_mid: str | None = Query(None),
) -> dict[str, object]:
    """取播放地址。

    没有权限时上游不是报错，而是回一条 `result != 0`（常见 104003）的记录 ——
    网关正是靠这个字段决定要不要降档重试，所以这里如实透传。
    """
    credential = credential_from_cookie(request.headers.get("cookie", ""))
    kind = _file_type(file_type)

    async def fetch() -> object:
        info = SongFileInfo(mid=mid, file_type=kind, song_type=song_type, media_mid=media_mid)
        async with open_client(credential) as client:
            return await client.song.get_song_urls([info], kind, credential=credential)

    key = cache_key("song_url", mid, file_type, song_type, media_mid, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch, ttl=URL_CACHE_TTL_SECONDS)))


@router.get("/{value}/lyric")
async def song_lyric(
    value: str,
    request: Request,
    song_type: int = Query(1),
    qrc: bool = Query(False),
    trans: bool = Query(False),
    roma: bool = Query(False),
    singing_annotations: bool = Query(False),
) -> dict[str, object]:
    """歌词。网关要 `lyric` / `trans` / `roma` 三个字段。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))
    song = _song_value(value)

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.lyric.get_lyric(
                song,
                song_type,
                qrc=qrc,
                trans=trans,
                roma=roma,
                singing_annotations=singing_annotations,
            )

    key = cache_key("song_lyric", value, song_type, qrc, trans, roma, singing_annotations, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
