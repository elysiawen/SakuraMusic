"""QQ 音乐客户端（App）扫码会话：一个二维码一条 MQTT 长连接。

为什么它从独立进程搬了回来
--------------------------
老上游的 web 层只有「单次请求-响应」式路由，承载不了流式状态，所以当初单开了一个 sidecar。
上游换成我们自己的服务后这个限制就不存在了：SDK 的 MQTT 客户端虽然底层是 paho（阻塞库），
但它自己把阻塞操作交给了线程（`anyio.to_thread`），因此在 FastAPI 的事件循环里跑不会卡住别的请求。

**移动端只有一条路可走**：`LoginApi.checking_mobile_qrcode()`（内部建 MQTT 连接、
订阅 `management.qrcode_login/<id>`）。0.7.3 的 `check_qrcode()` 里**没有 MOBILE 分支**
（只有 wx / qq），把移动端二维码交给它，等于拿二维码标识去查 ptqrlogin 的接口 ——
只会空转到超时：App 那边扫了也不会有人知道，因为移动端状态是走 MQTT 推的。
这一点与 dev 分支不同，别照抄那边的 `QRCodeLoginSession`。

会话在后台任务里持续消费这些事件，HTTP 轮询只读内存快照 ——
既没有「每次轮询查一次上游」的开销，也不会漏掉瞬时推送。

注意这与 `session.QrSessions` 一样，是**进程内存**状态：服务必须单 worker（见 run.py）。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from dataclasses import dataclass, field
from typing import Any

import anyio
from qqmusic_api import Client
from qqmusic_api.models.login import QRCodeLoginEvents, QRLoginType

from session import credential_payload

# 单个二维码的最长等待时间（秒）。旧名 SAKURA_MOBILE_QR_TIMEOUT 继续认，避免升级后行为漂移。
LOGIN_TIMEOUT = float(
    os.environ.get("QQ_MOBILE_QR_TIMEOUT") or os.environ.get("SAKURA_MOBILE_QR_TIMEOUT") or "300"
)
# 终态会话在内存里保留多久，供网关最后一次轮询取回凭据（秒）。
SESSION_IDLE_TTL = 180.0
# 等二维码生成的最长时间（生成时要访问 QQ 接口，超时说明上游异常）。
QRCODE_CREATE_TIMEOUT = 30.0

# 事件码与另外两条扫码路径一致：DONE=0、SCAN=1、CONF=2、TIMEOUT=3、REFUSE=4、其他=-1。
EVENT_CODES = {
    QRCodeLoginEvents.DONE: 0,
    QRCodeLoginEvents.SCAN: 1,
    QRCodeLoginEvents.CONF: 2,
    QRCodeLoginEvents.TIMEOUT: 3,
    QRCodeLoginEvents.REFUSE: 4,
}
TERMINAL_EVENTS = {QRCodeLoginEvents.DONE, QRCodeLoginEvents.REFUSE, QRCodeLoginEvents.TIMEOUT}
EVENT_ERROR = -1


@dataclass
class MobileSession:
    """一个手机端扫码会话的可共享状态（由后台任务写、HTTP 请求读）。"""

    identifier: str = ""
    image: bytes = b""
    mimetype: str = "image/png"
    # 初始对外就是「等待扫码」，避免网关在首个事件到达前拿到空状态。
    event: int = 1
    done: bool = False
    credential: dict[str, Any] | None = None
    error: str | None = None
    expires_at: float = 0.0
    # 二维码就绪后才放行创建接口的等待者。
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None

    def snapshot(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "login_type": "mobile",
            "identifier": self.identifier,
            "event": self.event,
            "done": self.done,
            "credential": self.credential,
        }
        if self.error:
            payload["message"] = self.error
        return payload


class MobileSessions:
    """`identifier → 会话` 的内存表。"""

    def __init__(self) -> None:
        self._items: dict[str, MobileSession] = {}

    async def create(self) -> MobileSession:
        """建会话并等二维码就绪；就绪后由调用方负责返回给用户。"""
        session = MobileSession(expires_at=time.monotonic() + LOGIN_TIMEOUT + 60)
        session.task = asyncio.create_task(_consume(session), name="qq-mobile-qr")
        try:
            await asyncio.wait_for(session.ready.wait(), timeout=QRCODE_CREATE_TIMEOUT)
        except TimeoutError as exc:
            await self.cancel(session)
            raise TimeoutError("等待 QQ 音乐返回二维码超时") from exc

        if not session.identifier:
            await self.cancel(session)
            raise RuntimeError(session.error or "QQ 音乐未返回二维码标识符")

        self._items[session.identifier] = session
        return session

    def get(self, identifier: str) -> MobileSession | None:
        self._sweep()
        return self._items.get(identifier)

    async def drop(self, identifier: str) -> MobileSession | None:
        """取出并立刻取消后台任务，让 MQTT 连接马上释放。"""
        session = self._items.pop(identifier, None)
        if session is not None:
            await self.cancel(session)
        return session

    def size(self) -> int:
        self._sweep()
        return len(self._items)

    async def shutdown(self) -> None:
        """服务关闭时掐掉所有长连接，别让 uvicorn 等它们自然超时。"""
        for session in list(self._items.values()):
            await self.cancel(session)
        self._items.clear()

    async def cancel(self, session: MobileSession) -> None:
        task = session.task
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    def _sweep(self) -> None:
        now = time.monotonic()
        for key in [key for key, item in self._items.items() if item.expires_at < now]:
            stale = self._items.pop(key)
            if stale.task is not None and not stale.task.done():
                stale.task.cancel()


async def _consume(session: MobileSession) -> None:
    """取二维码，然后一直消费登录事件，直到终态或超时。"""
    try:
        async with Client() as client:
            qrcode = await client.login.get_qrcode(QRLoginType.MOBILE)
            session.identifier = qrcode.identifier
            session.image = qrcode.data
            session.mimetype = qrcode.mimetype or "image/png"
            # 二维码先还给用户，MQTT 建连在后台继续 —— 订阅握手快慢不该拖住创建请求。
            session.ready.set()

            # deadline 用的是 anyio 的时钟（SDK 内部按 anyio.current_time() 比较），别传 time.monotonic。
            deadline = anyio.current_time() + LOGIN_TIMEOUT
            async for item in client.login.checking_mobile_qrcode(qrcode, deadline):
                session.event = EVENT_CODES.get(item.event, EVENT_ERROR)
                if item.credential is not None:
                    # 与另外两条扫码路径同一套序列化（snake_case，不带别名）。
                    session.credential = credential_payload(item.credential)
                session.done = item.event in TERMINAL_EVENTS
                if session.done:
                    session.expires_at = time.monotonic() + SESSION_IDLE_TTL
                    break
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 任何异常都要回传给调用方，而不是静默停在某一帧
        session.error = f"{type(exc).__name__}: {exc}"
        # 必须把事件一并打到 -1：网关只按 event 判定状态，
        # 否则异常会表现成「一直停在已扫描」，用户端看不到任何错误信息。
        session.event = EVENT_ERROR
        session.done = True
        session.expires_at = time.monotonic() + SESSION_IDLE_TTL
    finally:
        session.ready.set()


mobile_sessions = MobileSessions()
