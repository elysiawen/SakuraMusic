"""搜索路由。

路径、查询参数、响应形状对齐原 web 层（`QQMusicApi/web/src/routes/search.py`）。
网关只用到 `keyword / search_type / num / page`，另外三个参数一并保留是为了契约完整。

两点说明：
* 搜索走缓存 + 请求合并（见 `cache.py`）：网关首页会并行打好几个接口，
  冷请求直冲上游很容易换来 `429 触发风控`。
* 原 web 层用的就是 `search_by_type`，未登录时它**极易被风控降级成空结果**。
  这里先保持同行为；若之后遇到空结果，可换 `general_search` 再按分类桶拆分 ——
  那是行为变更，要单独评估。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query, Request
from qqmusic_api.models.search import SearchSelector
from qqmusic_api.modules.search import SearchType

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/search", tags=["search"])

# 白名单直接从 SDK 枚举取，避免手抄一串数字后跟版本走偏。
_SEARCH_TYPES = {int(item) for item in SearchType}


def _search_type(value: int) -> int:
    if value not in _SEARCH_TYPES:
        allowed = ", ".join(str(item) for item in sorted(_SEARCH_TYPES))
        raise HTTPException(status_code=422, detail=f"不支持的搜索类型：{value}（可选：{allowed}）")
    return value


def _selectors(raw: str | None) -> list[SearchSelector] | None:
    """`selectors` 是 JSON 数组字符串（原 web 层就是这么传的），按模型校验后再用。"""
    if not raw:
        return None
    try:
        items = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="selectors 不是合法的 JSON") from exc
    if not isinstance(items, list):
        raise HTTPException(status_code=422, detail="selectors 必须是 JSON 数组")
    return [SearchSelector.model_validate(item) for item in items]


@router.get("/search_by_type")
async def search_by_type(
    request: Request,
    keyword: str = Query(...),
    search_type: int = Query(0),
    num: int = Query(10),
    page: int = Query(1),
    selectors: str | None = Query(None),
    searchid: str | None = Query(None),
    highlight: bool = Query(True),
) -> dict[str, object]:
    """按分类搜索。`search_type`：0 单曲 / 1 歌手 / 2 专辑 / 3 歌单。"""
    # 参数校验放在缓存之前：非法的请求不该进缓存。
    kind = _search_type(search_type)
    parsed_selectors = _selectors(selectors)

    # 登录态会改变搜索结果，所以凭据要进缓存键（见 cache.credential_fingerprint）。
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        # 客户端在缓存工厂内部创建：被合并的那次调用因此拥有自己的连接，
        # 不会因为发起方请求结束（浏览器断开）而半途被关掉。
        async with open_client(credential) as client:
            return await client.search.search_by_type(
                keyword,
                kind,
                num,
                page,
                parsed_selectors,
                searchid,
                highlight=highlight,
            )

    key = cache_key("search_by_type", keyword, kind, num, page, searchid or "", highlight, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
