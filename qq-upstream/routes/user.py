"""用户路由：主页（绑定时取昵称头像）+ 只读的「我的音乐库」。

`/{euin}/homepage` 对齐原 web 层；后三条是新增的**只读**接口，用来在 Sakura 里直接
看到该账号自己的收藏与歌单 —— 只读：不写回平台，也不与本地音乐库做任何同步，
三套数据（本地 / QQ 音乐 / 网易云）各显各的。

身份不从 URL 传，直接从请求自带的凭据里取（`musicid` / `encrypt_uin`）：
凭据本身就是账号作用域的，让调用方再传一遍 uin 只会多一处能传错的地方。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from qqmusic_api import Credential

from cache import cache_key, response_cache
from envelope import NO_CREDENTIAL_MESSAGE, ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/user", tags=["user"])

# 用户库的缓存时长。比公开数据（300s）短：用户随时会在手机客户端那边改收藏，
# 而它又不像搜索结果那样一批请求打同一个键 —— 60s 够吸收翻页与重进页面的抖动。
LIBRARY_TTL_SECONDS = 60.0


def _credential_or_401(request: Request) -> Credential:
    credential = credential_from_cookie(request.headers.get("cookie", ""))
    if credential is None:
        raise HTTPException(status_code=401, detail=NO_CREDENTIAL_MESSAGE)
    return credential


def _require_euin(credential: Credential) -> str:
    """收藏类接口要的是加密 UIN。

    网关构建 Cookie 时会一并带上它（见 `gateway/src/upstream/qq.ts` 的 `buildQqCookie`），
    缺它只可能是凭据不完整 —— 把原因说清楚，别让前端只看到一句上游校验失败。
    """
    euin = credential.encrypt_uin
    if not euin:
        raise HTTPException(status_code=401, detail="凭据缺少 encrypt_uin，请重新绑定 QQ 音乐账号")
    return euin


@router.get("/fav_song")
async def fav_song(
    request: Request,
    page: int = Query(1, ge=1),
    num: int = Query(30, ge=1, le=100),
) -> dict[str, object]:
    """我喜欢的歌曲（网关读 `data.songs` / `data.total` / `data.hasmore`）。

    上游把它当作 `dirid=201` 的「我喜欢」歌单返回，结构因此与歌单详情完全一致
    （`data.info` 里还有歌单标题与封面）。
    """
    credential = _credential_or_401(request)
    euin = _require_euin(credential)

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.user.get_fav_song(euin, page, num, credential=credential)

    key = cache_key("user_fav_song", euin, page, num, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch, LIBRARY_TTL_SECONDS)))


@router.get("/created_songlist")
async def created_songlist(request: Request) -> dict[str, object]:
    """我创建的歌单（网关读 `data.playlists` / `data.total`）。

    上游一次性返回全部（没有分页参数），`finished` 表示是否已经拉全。
    """
    credential = _credential_or_401(request)
    uin = credential.musicid
    if not uin:
        raise HTTPException(status_code=401, detail="凭据缺少 musicid，请重新绑定 QQ 音乐账号")

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.user.get_created_songlist(uin, credential=credential)

    key = cache_key("user_created_songlist", uin, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch, LIBRARY_TTL_SECONDS)))


@router.get("/fav_songlist")
async def fav_songlist(
    request: Request,
    page: int = Query(1, ge=1),
    num: int = Query(30, ge=1, le=100),
) -> dict[str, object]:
    """我收藏的歌单（网关读 `data.playlists` / `data.total` / `data.hasmore`）。"""
    credential = _credential_or_401(request)
    euin = _require_euin(credential)

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.user.get_fav_songlist(euin, page, num, credential=credential)

    key = cache_key("user_fav_songlist", euin, page, num, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch, LIBRARY_TTL_SECONDS)))


@router.get("/{euin}/homepage")
async def user_homepage(euin: str, request: Request) -> dict[str, object]:
    """用户主页。`euin` 是加密 UIN（凭据里的 `encrypt_uin`）。

    原 web 层是「Cookie 可选」：带上更稳，不带也能查，所以这里不做 401。
    昵称头像变动不频繁，同样走缓存（并在切换账号时靠凭据指纹自然分开）。
    """
    credential = credential_from_cookie(request.headers.get("cookie", ""))

    async def fetch() -> object:
        async with open_client(credential) as client:
            return await client.user.get_homepage(euin, credential=credential)

    key = cache_key("user_homepage", euin, credential=credential)
    return ok(dump_model(await response_cache.run(key, fetch)))
