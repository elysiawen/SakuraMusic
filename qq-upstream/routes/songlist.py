"""歌单路由（对齐原 web 层 `routes/songlist.py` 的详情那条）。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/songlist", tags=["songlist"])


@router.get("/{songlist_id}/detail")
async def get_detail(
    songlist_id: int,
    request: Request,
    dirid: int = Query(0),
    num: int = Query(10),
    page: int = Query(1),
    onlysong: bool = Query(False),
    tag: bool = Query(True),
    userinfo: bool = Query(True),
) -> dict[str, object]:
    """歌单详情（网关读 `data.info` / `data.songs` / `data.total`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.songlist.get_detail(
                songlist_id,
                dirid,
                num,
                page,
                onlysong=onlysong,
                tag=tag,
                userinfo=userinfo,
            )

    key = cache_key("songlist_detail", songlist_id, dirid, num, page, onlysong, tag, userinfo, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
