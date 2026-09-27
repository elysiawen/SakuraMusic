"""用户路由（目前只有主页，用于取绑定时显示的昵称与头像）。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from cache import cache_key, response_cache
from envelope import ok
from session import credential_from_cookie, dump_model, open_client

router = APIRouter(prefix="/user", tags=["user"])


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
