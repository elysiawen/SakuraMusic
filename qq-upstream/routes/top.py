"""榜单路由：分类列表与榜单详情（对齐原 web 层 `routes/top.py`）。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/top", tags=["top"])


@router.get("/get_category")
async def get_category(request: Request) -> dict[str, object]:
    """全部排行榜分类（网关读 `data.group[].toplist[]`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.top.get_category()

    key = cache_key("top_category", credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/{top_id}/detail")
async def get_detail(
    top_id: int,
    request: Request,
    num: int = Query(10),
    page: int = Query(1),
    tag: bool = Query(True),
) -> dict[str, object]:
    """榜单详情（网关读 `data.info` 与 `data.songs`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.top.get_detail(top_id, num, page, tag=tag)

    key = cache_key("top_detail", top_id, num, page, tag, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
