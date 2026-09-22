"""Sakura Music —— QQ 音乐客户端扫码登录 sidecar.

为什么需要这个独立进程
----------------------
QQ 音乐 App 扫码（`QRLoginType.MOBILE`）的状态推送走的是 MQTT 长连接
（`mu.y.qq.com:443/ws/handshake`，订阅 `management.qrcode_login/{identifier}`），
而 QQMusicApi 的 FastAPI Web 层只把 `qq` / `wx` 暴露成单次请求-响应的路由
（见 `web/src/modules/login.py` 的 `WEB_QR_LOGIN_TYPES`），无法承载这种流式状态。

本进程直接 `import qqmusic_api` 复用官方 SDK（包括其 `QRCodeLoginSession` 封装），
对上游仓库**零改动**；只额外提供一个极小的 HTTP 接口给 Sakura 网关调用：

    POST   /mobile/qrcode          创建会话并返回二维码（内部启动一条 MQTT 长连接）
    GET    /mobile/qrcode/status   读取该会话的最新事件（纯内存读取，不产生网络请求）
    DELETE /mobile/qrcode          主动释放会话
    GET    /health                 健康检查

设计要点
--------
* **一个二维码一条 MQTT 长连接**：会话在后台线程里跑独立事件循环，持续消费
  `QRCodeLoginSession.iter_events()`；网关的 2 秒轮询只读内存，既没有连接开销，
  也不会像「每次轮询开一次连接」那样漏掉瞬时的推送事件。
* **零额外依赖**：HTTP 服务用标准库 `http.server`，因此不要求 venv 里装 fastapi / uvicorn。
* 事件码与上游 Web 层保持一致：DONE=0、SCAN=1、CONF=2、TIMEOUT=3、REFUSE=4、其他=-1。

运行方式（复用 QQMusicApi 的 venv，无需额外安装）::

    pnpm start:sidecar
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from qqmusic_api import Client
from qqmusic_api.models.login import QRCodeLoginEvents, QRLoginType
from qqmusic_api.modules.login_utils import QRCodeLoginSession

# Windows 控制台默认不是 UTF-8，中文日志会变成乱码；这里显式统一为 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    with contextlib.suppress(AttributeError, ValueError):
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

HOST = os.environ.get("SAKURA_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("SAKURA_SIDECAR_PORT", "8090"))
# 单个二维码的最长等待时间（秒）。
LOGIN_TIMEOUT = float(os.environ.get("SAKURA_MOBILE_QR_TIMEOUT", "300"))
# 终态会话在内存中保留多久，供网关最后一次轮询取回凭据（秒）。
SESSION_IDLE_TTL = 180.0
# 等待二维码生成的最长时间（生成时要访问 QQ 接口，超时说明上游异常）。
QRCODE_CREATE_TIMEOUT = 30.0

_TERMINAL_EVENTS = {
    QRCodeLoginEvents.DONE,
    QRCodeLoginEvents.REFUSE,
    QRCodeLoginEvents.TIMEOUT,
}
_EVENT_CODES = {
    QRCodeLoginEvents.DONE: 0,
    QRCodeLoginEvents.SCAN: 1,
    QRCodeLoginEvents.CONF: 2,
    QRCodeLoginEvents.TIMEOUT: 3,
    QRCodeLoginEvents.REFUSE: 4,
}


@dataclass
class MobileSession:
    """单个手机端扫码会话的可共享状态（由后台线程写入、HTTP 线程读取）。"""

    identifier: str = ""
    image: bytes = b""
    mimetype: str = "image/png"
    # 初始对外呈现为「等待扫码」，避免网关在首个事件到达前拿到空状态。
    event: int = 1
    done: bool = False
    credential: dict[str, Any] | None = None
    error: str | None = None
    expires_at: float = 0.0
    ready: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    # 用于在网关主动释放会话时取消后台消费任务（跨线程需经 call_soon_threadsafe）。
    loop: asyncio.AbstractEventLoop | None = None
    task: asyncio.Task[None] | None = None

    def cancel(self) -> None:
        """请求取消后台的 MQTT 消费任务，让连接立刻释放。"""
        if self.loop is None or self.task is None:
            return
        with contextlib.suppress(RuntimeError):
            self.loop.call_soon_threadsafe(self.task.cancel)

    def snapshot(self) -> dict[str, Any]:
        """返回当前状态的快照，用于拼装 HTTP 响应。"""
        with self.lock:
            payload: dict[str, Any] = {
                "identifier": self.identifier,
                "loginType": "mobile",
                "event": self.event,
                "done": self.done,
            }
            if self.credential is not None:
                payload["credential"] = self.credential
            if self.error:
                payload["message"] = self.error
            return payload


_SESSIONS: dict[str, MobileSession] = {}
_SESSIONS_LOCK = threading.Lock()


async def _consume_login(session: MobileSession) -> None:
    """在独立事件循环中获取二维码并持续消费登录事件。"""
    session.loop = asyncio.get_running_loop()
    session.task = asyncio.current_task()
    try:
        async with Client() as client:
            flow = QRCodeLoginSession(
                client.login,
                QRLoginType.MOBILE,
                interval=1.5,
                timeout_seconds=LOGIN_TIMEOUT,
            )
            qrcode = await flow.get_qrcode()
            with session.lock:
                session.identifier = qrcode.identifier
                session.image = qrcode.data
                session.mimetype = qrcode.mimetype or "image/png"
            session.ready.set()

            async for item in flow.iter_events():
                with session.lock:
                    session.event = _EVENT_CODES.get(item.event, -1)
                    if item.credential is not None:
                        # 与上游 Web 层保持一致的别名序列化，网关侧的 Cookie 构造逻辑可直接复用。
                        session.credential = item.credential.model_dump(by_alias=True)
                    session.done = item.event in _TERMINAL_EVENTS
                    if session.done:
                        session.expires_at = time.time() + SESSION_IDLE_TTL
                if session.done:
                    break
    except Exception as exc:  # noqa: BLE001 - 任何异常都要回传给调用方而不是静默失败
        with session.lock:
            session.error = f"{type(exc).__name__}: {exc}"
            session.done = True
            session.expires_at = time.time() + SESSION_IDLE_TTL
    finally:
        session.ready.set()


def _start_session() -> MobileSession:
    """启动一个扫码会话，等待二维码就绪后返回。"""
    session = MobileSession()
    session.expires_at = time.time() + LOGIN_TIMEOUT + 60
    threading.Thread(
        target=lambda: asyncio.run(_consume_login(session)),
        name="qq-mobile-qr",
        daemon=True,
    ).start()

    if not session.ready.wait(QRCODE_CREATE_TIMEOUT):
        raise TimeoutError("等待 QQ 音乐返回二维码超时")
    with session.lock:
        if session.error and not session.identifier:
            raise RuntimeError(session.error)
        if not session.identifier:
            raise RuntimeError("QQ 音乐未返回二维码标识符")

    with _SESSIONS_LOCK:
        _SESSIONS[session.identifier] = session
    return session


def _get_session(identifier: str) -> MobileSession | None:
    """按标识符取出会话，并顺带清理已过期项。"""
    now = time.time()
    with _SESSIONS_LOCK:
        for key in [key for key, item in _SESSIONS.items() if item.expires_at < now]:
            del _SESSIONS[key]
        return _SESSIONS.get(identifier)


class Server(ThreadingHTTPServer):
    """带端口占用保护的 HTTP 服务.

    注意: `http.server` 默认 `allow_reuse_address = True`, 而 Windows 的 `SO_REUSEADDR`
    允许两个进程同时绑定同一端口(与 Linux 需要 `SO_REUSEPORT` 不同), 会导致重复启动时
    两个实例都在应答、行为不可预期. 因此 Windows 上关闭它, 让重复启动直接报「地址被占用」.
    """

    allow_reuse_address = os.name != "nt"


class Handler(BaseHTTPRequestHandler):
    """极简 JSON HTTP 处理器。"""

    server_version = "SakuraMobileLogin/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A002
        """收敛访问日志格式，便于与网关日志区分。"""
        print(f"[sidecar] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _identifier(self) -> str:
        query = parse_qs(urlparse(self.path).query)
        return (query.get("identifier") or [""])[0]

    def do_GET(self) -> None:  # noqa: N802 - 标准库要求的命名
        path = urlparse(self.path).path
        if path == "/health":
            with _SESSIONS_LOCK:
                self._send(200, {"ok": True, "sessions": len(_SESSIONS)})
            return
        if path == "/mobile/qrcode/status":
            session = _get_session(self._identifier())
            if session is None:
                self._send(404, {"error": "会话不存在或已过期，请重新获取二维码"})
                return
            self._send(200, session.snapshot())
            return
        self._send(404, {"error": f"未知路径 {path}"})

    def do_POST(self) -> None:  # noqa: N802 - 标准库要求的命名
        if urlparse(self.path).path != "/mobile/qrcode":
            self._send(404, {"error": f"未知路径 {urlparse(self.path).path}"})
            return
        try:
            session = _start_session()
        except Exception as exc:  # noqa: BLE001 - 统一转成 502 交给网关展示
            self._send(502, {"error": f"{type(exc).__name__}: {exc}"})
            return
        encoded = base64.b64encode(session.image).decode("ascii")
        self._send(
            200,
            {
                "loginType": "mobile",
                "identifier": session.identifier,
                "mimetype": session.mimetype,
                "img": f"data:{session.mimetype};base64,{encoded}",
            },
        )

    def do_DELETE(self) -> None:  # noqa: N802 - 标准库要求的命名
        if urlparse(self.path).path != "/mobile/qrcode":
            self._send(404, {"error": f"未知路径 {urlparse(self.path).path}"})
            return
        identifier = self._identifier()
        with _SESSIONS_LOCK:
            session = _SESSIONS.pop(identifier, None)
        if session is not None:
            # 立刻取消 MQTT 消费任务，避免用户关掉弹窗后连接还空耗到超时。
            session.cancel()
        self._send(200, {"ok": True, "removed": session is not None})


def main() -> None:
    """启动 sidecar HTTP 服务。"""
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as exc:
        print(f"[sidecar] 无法绑定 {HOST}:{PORT} —— {exc}", file=sys.stderr, flush=True)
        print("[sidecar] 端口已被占用，可能已经有一个 sidecar 在运行。", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc
    server.daemon_threads = True
    print(f"[sidecar] QQ 音乐客户端扫码服务已启动：http://{HOST}:{PORT}", flush=True)
    print(f"[sidecar] 单个二维码有效期 {LOGIN_TIMEOUT:.0f}s，终端会话保留 {SESSION_IDLE_TTL:.0f}s", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[sidecar] 正在关闭…", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
