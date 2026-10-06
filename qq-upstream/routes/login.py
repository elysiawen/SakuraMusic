"""登录路由。

路径、方法与形状对齐原 web 层（`QQMusicApi/web/src/routes/login.py` + `web/src/modules/login.py`），
网关 `gateway/src/upstream/qq.ts` 因此不需要任何改动。**全部是 GET** —— 那是原 web 层的声明方式。

只暴露 `qq` / `wx` 两种「无状态轮询」的二维码：客户端扫码（mobile）要维持 MQTT 长连接，
生命周期完全不同，单独放在 `routes/mobile.py`（HTTP 轮询只读它内存里的快照）。
"""

from __future__ import annotations

import base64
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from qqmusic_api import Credential
from qqmusic_api.models.login import QR, QRCodeLoginEvents, QRLoginType

# 绝对导入，理由见 app.py 顶部（uvicorn 顶层加载，服务目录在 sys.path 上）。
from envelope import NO_CREDENTIAL_MESSAGE, ok
from session import credential_from_cookie, credential_payload, open_client, qr_sessions

router = APIRouter(prefix="/login", tags=["login"])

_LOGIN_TYPES = {"qq": QRLoginType.QQ, "wx": QRLoginType.WX}

# 事件码与原 web 层一致（web/src/modules/login.py 的 QR_CODE_EVENT_CODES）。
_EVENT_CODES = {
    QRCodeLoginEvents.DONE: 0,
    QRCodeLoginEvents.SCAN: 1,
    QRCodeLoginEvents.CONF: 2,
    QRCodeLoginEvents.TIMEOUT: 3,
    QRCodeLoginEvents.REFUSE: 4,
}
_TERMINAL_EVENTS = {QRCodeLoginEvents.DONE, QRCodeLoginEvents.TIMEOUT, QRCodeLoginEvents.REFUSE}


def _login_type(value: str) -> QRLoginType:
    """校验二维码类型。非法值按原 web 层返回 422。"""
    kind = _LOGIN_TYPES.get(value)
    if kind is None:
        raise HTTPException(status_code=422, detail=f"不支持的二维码登录类型：{value}（可选：qq、wx）")
    return kind


def _cookie(request: Request) -> str:
    return request.headers.get("cookie", "")


@router.get("/qrcode/{login_type}")
async def create_qrcode(login_type: str) -> dict[str, object]:
    """创建登录二维码（QQ 扫码 / 微信扫码）。"""
    kind = _login_type(login_type)
    async with open_client(None) as client:
        qrcode = await client.login.get_qrcode(kind)

    # 记住真身：后面轮询直接用，不必像原 web 层那样重建占位对象。
    qr_sessions.put(qrcode)
    encoded = base64.b64encode(qrcode.data).decode("ascii")
    return ok(
        {
            "qr_type": kind.value,
            "identifier": qrcode.identifier,
            "mimetype": qrcode.mimetype,
            "data": encoded,
            "img": f"data:{qrcode.mimetype};base64,{encoded}",
        }
    )


def _status_payload(
    kind: QRLoginType,
    identifier: str,
    event: int,
    done: bool,
    credential: dict[str, Any] | None,
) -> dict[str, object]:
    """状态应答（形状与原 web 层一致：只有登录成功才带 `credential`）。"""
    return ok(
        {
            "event": event,
            "done": done,
            "credential": credential,
            "identifier": identifier,
            "login_type": kind.value,
        }
    )


@router.get("/qrcode/{login_type}/status")
async def qrcode_status(login_type: str, identifier: str = Query(...)) -> dict[str, object]:
    """查询扫码状态。

    这个接口对同一个二维码必须是**幂等**的：微信那条换凭据用的 `code` 是一次性的，
    拿它换第二次，QQ 会回 `code=1000`（SDK 抛 `LoginAuthExpiredError`），
    在网关那边就变成「上游返回 400：登录鉴权参数无效或已过期」。

    而微信的状态查询本身就是一次最长 35 秒的**长轮询**：客户端只要轮询有一点重叠，
    「用户一确认」就会有好几个请求同时醒来、拿同一个 `code` 去换 —— 一个成功，其余全报 400。
    所以这里做两件事：终态结论缓存下来重复回答；同一二维码同时只允许一个在途查询，
    其余请求立刻回上一次的状态（不排队，也不并发换码）。
    """
    kind = _login_type(login_type)

    settled = qr_sessions.result(identifier)
    if settled is not None:
        return settled

    if qr_sessions.busy(identifier):
        return qr_sessions.latest(identifier) or _status_payload(kind, identifier, 1, False, None)

    qr_sessions.begin(identifier)
    try:
        # 会话不在表里（服务重启、二维码已过期被清）时，仍然照原 web 层的做法用占位对象去查：
        # 上游自己会回 TIMEOUT/REFUSE，前端因此能拿到真实结论，而不是一句「会话不存在」。
        qrcode = qr_sessions.get(identifier) or QR(
            data=b"",
            qr_type=kind,
            mimetype="image/png",
            identifier=identifier,
        )

        async with open_client(None) as client:
            result = await client.login.check_qrcode(qrcode)

        event = _EVENT_CODES.get(result.event, -1)
        payload = _status_payload(
            kind,
            identifier,
            event,
            bool(result.done),
            # 只有登录成功才带凭据；其余情况给 null（形状与原 web 层一致）。
            credential_payload(result.credential) if event == 0 else None,
        )

        qr_sessions.remember_latest(identifier, payload)
        if result.event in _TERMINAL_EVENTS:
            qr_sessions.remember_result(identifier, payload)
            qr_sessions.drop(identifier)

        return payload
    finally:
        qr_sessions.end(identifier)


@router.get("/refresh_credential")
async def refresh_credential(request: Request) -> dict[str, object]:
    """用现有凭据换一份新的（网关在凭据临近过期时调用）。"""
    credential = credential_from_cookie(_cookie(request))
    if credential is None:
        raise HTTPException(status_code=401, detail=NO_CREDENTIAL_MESSAGE)

    async with open_client(credential) as client:
        refreshed = await client.login.refresh_credential(credential)
    return ok(credential_payload(refreshed))


@router.get("/check_expired")
async def check_expired(request: Request) -> JSONResponse:
    """检查凭据是否过期。

    注意这里的返回形状**不是** `data: true/false`：原 web 层把布尔结果折叠进信封
    （`web/src/routing/executor.py`：True → `{code:0,data:null}`，False → `{code:-1,msg:'操作失败'}`），
    所以网关读的是 `code`。照做的原因是「一行都不用改」，不是为了好看。
    """
    credential = credential_from_cookie(_cookie(request)) or Credential()
    async with open_client(credential) as client:
        expired = await client.login.check_expired(credential)

    if expired:
        return JSONResponse(status_code=200, content={"code": -1, "msg": "操作失败", "data": None})
    return JSONResponse(status_code=200, content=ok(None))
