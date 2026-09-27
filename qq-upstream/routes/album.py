"""专辑路由：详情与曲目（对齐原 web 层 `routes/album.py`）。

网关把歌手从**详情的顶层 `singers`** 里取（专辑对象本身不含歌手），
这是原 web 层就有的坑，我们照原样输出即可。
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from cache import cache_key, response_cache
from envelope import ok
from session import as_id, credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/album", tags=["album"])


@router.get("/{value}/detail")
async def get_detail(value: str, request: Request) -> dict[str, object]:
    """专辑详情。`value` 是专辑 id 或 mid。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.album.get_detail(as_id(value))

    key = cache_key("album_detail", value, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/{value}/songs")
async def get_songs(
    value: str,
    request: Request,
    num: int = Query(10),
    page: int = Query(1),
) -> dict[str, object]:
    """专辑曲目（网关读 `data.song_list` 与 `data.total_num`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.album.get_song(as_id(value), num, page)

    key = cache_key("album_songs", value, num, page, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
