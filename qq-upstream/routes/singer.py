"""歌手路由：信息 / 歌曲 / 专辑（对齐原 web 层 `routes/singer.py` 的三条）。

注意 0.7.3 里「专辑」那条的方法名是 `get_album_list`（单数 album），
不是 `get_albums_list` —— 照着旧版本抄很容易写错。
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/singer", tags=["singer"])


@router.get("/{mid}/info")
async def get_info(mid: str, request: Request) -> dict[str, object]:
    """歌手基础信息（网关读 `data.base_info` 与 `data.singer`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.singer.get_info(mid)

    key = cache_key("singer_info", mid, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/{mid}/songs")
async def get_songs(
    mid: str,
    request: Request,
    num: int = Query(10),
    page: int = Query(1),
) -> dict[str, object]:
    """歌手热门歌曲（网关读 `data.song_list` 与 `data.total_num`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.singer.get_songs_list(mid, num, page)

    key = cache_key("singer_songs", mid, num, page, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/{mid}/albums")
async def get_albums(
    mid: str,
    request: Request,
    num: int = Query(10),
    page: int = Query(1),
) -> dict[str, object]:
    """歌手专辑（网关读 `data.album_list` 与 `data.total`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.singer.get_album_list(mid, num, page)

    key = cache_key("singer_albums", mid, num, page, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
