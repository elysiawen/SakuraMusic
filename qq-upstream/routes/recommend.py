"""推荐路由（对齐原 web 层 `routes/recommend.py` 的三条）。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/recommend", tags=["recommend"])


@router.get("/get_guess_recommend")
async def guess_recommend(request: Request) -> dict[str, object]:
    """猜你喜欢。个性化推荐，结果跟登录态走 —— 凭据进缓存键，不会串号。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.recommend.get_guess_recommend(credential=credential)

    key = cache_key("recommend_guess", credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/get_recommend_newsong")
async def recommend_newsong(request: Request, type: int = Query(5)) -> dict[str, object]:
    """新歌速递。`type`：1 内地 / 2 欧美 / 3 日本 / 4 韩国 / 5 最新 / 6 港台。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.recommend.get_recommend_newsong(type)

    key = cache_key("recommend_newsong", type, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))


@router.get("/get_recommend_songlist")
async def recommend_songlist(
    request: Request,
    page: int = Query(1),
    num: int = Query(25),
) -> dict[str, object]:
    """推荐歌单（网关读 `data.songlists`）。"""
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.recommend.get_recommend_songlist(page, num)

    key = cache_key("recommend_songlist", page, num, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
