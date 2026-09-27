"""QQ 音乐客户端（App）扫码登录。

路径沿用原来 sidecar 的 `/mobile/...`，但响应改成与其它接口**一致的 `{code,msg,data}` 信封**：
它以前是裸 JSON，仅因为那是个另起的进程、另有一套约定；合进来之后没有理由再留两种形状。
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException, Query

from envelope import ok
from mobile import mobile_sessions

router = APIRouter(prefix="/mobile", tags=["mobile"])


@router.post("/qrcode")
async def create_qrcode() -> dict[str, object]:
    """创建二维码；内部会为该二维码起一条 MQTT 长连接订阅扫码状态。"""
    try:
        session = await mobile_sessions.create()
    except TimeoutError as exc:
        # 生成二维码要访问 QQ 接口，超时说明上游异常 —— 按「上游不可用」报 502。
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - 统一转成 502 交给网关展示
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc

    encoded = base64.b64encode(session.image).decode("ascii")
    return ok(
        {
            "login_type": "mobile",
            "identifier": session.identifier,
            "mimetype": session.mimetype,
            "img": f"data:{session.mimetype};base64,{encoded}",
        }
    )


@router.get("/qrcode/status")
async def qrcode_status(identifier: str = Query(...)) -> dict[str, object]:
    """读取该会话的最新事件（纯内存读取，不产生网络请求）。"""
    session = mobile_sessions.get(identifier)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在或已过期，请重新获取二维码")
    return ok(session.snapshot())


@router.delete("/qrcode")
async def release_qrcode(identifier: str = Query(...)) -> dict[str, object]:
    """主动释放会话：用户关掉弹窗时调用，避免 MQTT 连接空耗到超时。"""
    session = await mobile_sessions.drop(identifier)
    return ok({"removed": session is not None})
