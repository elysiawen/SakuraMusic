"""自建 QQ 音乐上游的公共设施：凭据解析、客户端构造、扫码会话表。

三条设计前提
------------
* **没有账号池**。Sakura 网关把每个用户的凭据加密存在自己库里
  （见 `gateway/src/services/credentials.ts`），每次请求都把 Cookie 带过来 ——
  所以这里按「请求带什么就用什么」处理，不再维护第二份共享登录态。
* **设备档案落盘**。随机设备指纹会显著提高触发上游风控（`code=2001`）的概率，
  所有客户端因此共用同一份落盘设备信息（`Client(device_path=...)`）。
* **扫码会话只活在进程内存里**。所以服务必须以单 worker 运行（见 `run.py`）。
"""

from __future__ import annotations

import contextlib
import dataclasses
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from qqmusic_api import Client, Credential, Platform
from qqmusic_api.models.login import QR

# 运行期数据（设备档案等）。`.data/` 已在仓库 .gitignore 里。
DATA_DIR = Path(__file__).resolve().parent / ".data"
DEVICE_PATH = DATA_DIR / "device.json"

# 二维码有效期。上游给的二维码约 5 分钟过期，这里按 5 分钟清理内存里的会话。
QR_TTL_SECONDS = 300.0


def _platform() -> Platform:
    """客户端平台。默认 ANDROID（与参考实现一致），可用环境变量覆盖，便于排查差异。"""
    override = os.environ.get("QQ_UPSTREAM_PLATFORM", "").strip().lower()
    if override in {"android", "desktop", "web"}:
        return Platform(override)
    return Platform.ANDROID


def parse_cookie(header: str) -> dict[str, str]:
    """Cookie 头 → 字段字典。

    值由网关用 `encodeURIComponent` 编码过（`qq.ts` 的 `buildQqCookie`），必须解回原文，
    否则 musickey 里的 `+` `/` `=` 会原样带进请求。
    """
    fields: dict[str, str] = {}
    for pair in header.split(";"):
        index = pair.find("=")
        if index < 1:
            continue
        key = pair[:index].strip()
        value = unquote(pair[index + 1 :].strip())
        if value:
            fields[key] = value
    return fields


def credential_from_cookie(header: str) -> Credential | None:
    """Cookie → Credential；缺 `musicid` 或 `musickey` 视为未登录。

    判据与原 web 层一致（`QQMusicApi/web/src/core/auth.py`：两者必须同时存在）。

    键名按模型元数据取别名，而不是硬编码一套字段名 —— 0.7.3 里 `encrypt_uin` 只认
    `encryptUin`，而 `musicid`／`musickey` 又只有朴素字段名，混着手写很容易踩空。
    """
    fields = parse_cookie(header)
    if not fields.get("musicid") or not fields.get("musickey"):
        return None

    payload: dict[str, Any] = {}
    for name, field in Credential.model_fields.items():
        value = fields.get(name)
        if value is None:
            continue
        alias = field.validation_alias or field.alias
        key = alias if isinstance(alias, str) else name
        payload[key] = value
    return Credential.model_validate(payload)


def credential_payload(credential: Credential | None) -> dict[str, Any] | None:
    """凭据序列化：**不带别名**，与原 web 层（`response_model_by_alias=False`）一致。

    另外 `musicid` 一律以**字符串**送出：微信登录用的是 19 位伪 uin（例如
    `1152921505385169135`），超过 JS `Number` 的 53 位精度 —— Node 网关 `JSON.parse` 会把它
    四舍五入成 `1152921505385169200`，再拿去鉴权就一律 `code=1000`（「登录鉴权参数无效或已过期」）。
    上游是 Python，int 本身是精确的，别让这个精度在序列化那一步丢掉。
    """
    if credential is None:
        return None
    payload = credential.model_dump(mode="json")
    payload["musicid"] = str(credential.musicid)
    return payload


def dump_model(value: Any) -> Any:
    """把 SDK 返回值转成可直接 JSON 化的结构。

    SDK 的返回基本是 pydantic 模型，`mode="json"` 顺带解决 datetime／枚举的序列化；
    **不带别名**，因此字段名与原 web 层（`response_model_by_alias=False`）逐个对得上 ——
    这正是网关那几十处 `firstStr(item.xxx)` 能继续用的前提。
    """
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    if isinstance(value, (list, tuple)):
        return [dump_model(item) for item in value]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    return value


def as_id(value: str) -> int | str:
    """上游的「歌曲／专辑」类接口接受两种形态：纯数字当 id，其余当 mid。

    判据与原 web 层一致（`/song/{value}/...`、`/album/{value}/...` 都这么做）。
    """
    return int(value) if value.isdigit() else value


def build_client(credential: Credential | None) -> Client:
    """按凭据构造客户端；调用方负责关闭（或直接用 `open_client`）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return Client(credential=credential, platform=_platform(), device_path=str(DEVICE_PATH))


@asynccontextmanager
async def open_client(credential: Credential | None) -> AsyncIterator[Client]:
    """一次请求一个客户端：用完即关，避免把某个用户的连接/凭据泄漏给下一个请求。"""
    client = build_client(credential)
    try:
        yield client
    finally:
        with contextlib.suppress(Exception):
            await client.close()


class QrSessions:
    """`identifier → QR` 的内存表。

    原 web 层是无状态的：轮询时用「只有 identifier 的占位 QR」重建对象，再交给
    `check_qrcode`（因为 QQ 类型的 identifier 就是 qrsig，够用了）。这里把真身留住，
    少一层猜测 —— 代价是必须单 worker（见 `run.py`）。
    """

    def __init__(self, ttl: float = QR_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._items: dict[str, tuple[QR, float]] = {}
        # 轮询去重用的两张表（见 result / latest 的注释）与在途标记。
        self._settled: dict[str, tuple[dict[str, Any], float]] = {}
        self._latest: dict[str, tuple[dict[str, Any], float]] = {}
        self._inflight: set[str] = set()

    def put(self, qrcode: QR) -> None:
        self._sweep()
        self._items[qrcode.identifier] = (qrcode, time.monotonic())

    def get(self, identifier: str) -> QR | None:
        self._sweep()
        item = self._items.get(identifier)
        return item[0] if item else None

    def drop(self, identifier: str) -> None:
        self._items.pop(identifier, None)

    def size(self) -> int:
        self._sweep()
        return len(self._items)

    def result(self, identifier: str) -> dict[str, Any] | None:
        """终态结论（成功时含凭据）。

        有它就直接照原样再答一次，**绝不再去换一次 code** —— 二维码的 code 是一次性的，
        换第二次 QQ 会回 `code=1000`（见 `routes/login.py` 的 `qrcode_status`）。
        """
        self._sweep()
        item = self._settled.get(identifier)
        return item[0] if item else None

    def remember_result(self, identifier: str, payload: dict[str, Any]) -> None:
        self._settled[identifier] = (payload, time.monotonic())

    def latest(self, identifier: str) -> dict[str, Any] | None:
        """上一次查到的状态（可能还是 waiting/scanned）：已有请求在途时用它兜底回答。"""
        self._sweep()
        item = self._latest.get(identifier)
        return item[0] if item else None

    def remember_latest(self, identifier: str, payload: dict[str, Any]) -> None:
        self._latest[identifier] = (payload, time.monotonic())

    def busy(self, identifier: str) -> bool:
        """这个二维码是否已有一个在途查询。"""
        return identifier in self._inflight

    def begin(self, identifier: str) -> None:
        self._inflight.add(identifier)

    def end(self, identifier: str) -> None:
        self._inflight.discard(identifier)

    def _sweep(self) -> None:
        deadline = time.monotonic() - self._ttl
        for key in [key for key, (_, at) in self._items.items() if at < deadline]:
            del self._items[key]
        for store in (self._settled, self._latest):
            for key in [key for key, (_, at) in store.items() if at < deadline]:
                del store[key]


qr_sessions = QrSessions()
