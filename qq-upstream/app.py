"""自建 QQ 音乐上游服务。

为什么不用 QQMusicApi 仓库自带的 FastAPI web 层
-----------------------------------------------
本地那份 checkout 停在 dev 分支（`v0.7.3-36-gba95861`，含一次 breaking 的 web 重构与重写的
请求内核），并且是以「可编辑安装」进 venv 的 —— 也就是说它和 PyPI 上的 0.7.3 并不是同一个东西。
这里改成直接依赖发布版 SDK，自己提供网关需要的那层 HTTP，路径与响应形状保持一致，
于是 `gateway/src/upstream/qq.ts` 一行都不用改（它只认 `code === 0` 与那些字段名）。

启动：`python run.py`（见 run.py 的单 worker 说明）。
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager

import qqmusic_api
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from qqmusic_api import BaseApiException
from starlette.exceptions import HTTPException as StarletteHTTPException

# 绝对导入：uvicorn 以顶层模块（`app:create_app`）加载本文件，
# 包内的相对导入会因为没有父包而失败；服务目录由 run.py 放进 sys.path。
from envelope import fail, status_for
from mobile import mobile_sessions
from routes import album, login, mobile, recommend, search, singer, song, songlist, top, user
from session import qr_sessions


@asynccontextmanager
async def lifespan(_: FastAPI):
    """关闭时把后台的扫码长连接一并收掉，别让 uvicorn 卡在等它们超时上。"""
    yield
    await mobile_sessions.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="Sakura QQ Upstream", version="0.1.0", lifespan=lifespan)

    # ------------------------------ 异常 → 信封 ------------------------------
    # 与原 web 层同一套语义：HTTP 状态码承载「哪一类失败」，body 只给 {code:-1,msg}。
    @app.exception_handler(BaseApiException)
    async def _api_error(_: Request, exc: BaseApiException) -> JSONResponse:
        status = status_for(exc)
        return JSONResponse(status_code=status, content=fail(str(exc), status))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content=fail("请求参数校验失败", 422))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return JSONResponse(status_code=exc.status_code, content=fail(detail, exc.status_code))

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        # 未预期的异常必须留下痕迹：否则网关只会看到一句「服务器内部错误」。
        print(f"[qq-upstream] 未捕获异常 {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return JSONResponse(status_code=500, content=fail("服务器内部错误", 500))

    # -------------------------------- 路由 --------------------------------
    app.include_router(album.router)
    app.include_router(login.router)
    app.include_router(mobile.router)
    app.include_router(recommend.router)
    app.include_router(search.router)
    app.include_router(singer.router)
    app.include_router(song.router)
    app.include_router(songlist.router)
    app.include_router(top.router)
    app.include_router(user.router)

    @app.get("/health")
    async def health() -> dict[str, object]:
        """健康检查。

        特意把**实际加载的 SDK 版本与路径**报出来：我们刚被「以为用的是同一个上游、
        其实一个是发布版一个是 dev 分支」坑过，这个字段能让这种问题一眼可见。
        """
        return {
            "ok": True,
            "sdk": {
                "version": getattr(qqmusic_api, "__version__", "unknown"),
                "path": qqmusic_api.__file__,
            },
            "qrSessions": qr_sessions.size(),
            "mobileSessions": mobile_sessions.size(),
        }

    print(
        f"[qq-upstream] qqmusic_api {getattr(qqmusic_api, '__version__', 'unknown')} ({qqmusic_api.__file__})",
        flush=True,
    )
    return app
