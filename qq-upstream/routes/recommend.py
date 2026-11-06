"""推荐路由（对齐原 web 层 `routes/recommend.py` 的三条，外加一条电台续播专用）。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from qqmusic_api import RatelimitedError
from qqmusic_api.models.recommend import GuessRecommendResponse

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/recommend", tags=["recommend"])

# 「猜你喜欢」的底层就是电台服务。SDK 的 get_guess_recommend() 把 num 写死成 5、
# song_ids 写死成空列表，加上 web 层那 5 分钟缓存，连续播放时每次都拿回同 5 首。
# 这里按它自己的端点元数据自建请求描述符，把「要几首」和「已经听过哪些」交给调用方。
RADIO_MODULE = "music.radioProxy.MbTrackRadioSvr"
RADIO_METHOD = "get_radio_track"


def _radio_request(client, num: int, song_ids: list[int], credential) -> object:
    # _build_cgi 是 SDK 模块基类的请求构造方法（@cgi_endpoint 内部用的也是它）。
    # SDK 版本钉在 requirements.txt，这里只是把写死的入参开放出来，不复制加密/风控逻辑。
    return client.recommend._build_cgi(
        RADIO_MODULE,
        RADIO_METHOD,
        {"id": 99, "num": num, "from": 0, "scene": 0, "song_ids": song_ids},
        response_model=GuessRecommendResponse,
        credential=credential,
    )


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


@router.get("/get_radio_track")
async def radio_track(
    request: Request,
    num: int = Query(5, ge=1, le=30),
    song_ids: str = Query(""),
) -> dict[str, object]:
    """电台续播：一次取 `num` 首，`song_ids` 是已经听过的歌曲 ID（逗号分隔）。

    刻意**不进 response_cache**：电台每次都要新的一批，缓存或请求合并会让续播
    一直拿回同一批歌。风控靠调用方控制节奏（网关串行拉、每批之间留间隔、限制批次数）。

    返回形状与 `/get_guess_recommend` 一致（`data.songs`），网关不需要新的解析分支。
    """
    credential = credential_from_cookie(request.headers.get("cookie", ""))
    parsed_ids = [int(part) for part in song_ids.split(",") if part.strip().isdigit()][-30:]

    async with open_client(credential) as client:
        try:
            data = await client.execute(_radio_request(client, num, parsed_ids, credential))
        except Exception as error:
            # song_ids 只是「别再推这些」的上下文；万一服务端这一版不认，
            # 退回 SDK 原来的空列表再来一次。风控命中时绝不重试（那会雪上加霜）。
            if not parsed_ids or isinstance(error, RatelimitedError):
                raise
            data = await client.execute(_radio_request(client, num, [], credential))
    return ok(dump_model(data))
