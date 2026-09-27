"""公开数据的短缓存、请求合并与风控冷却。

为什么必须有这一层
------------------
老上游的 web 层自带缓存与请求合并（dev 分支里还加了「上游失败标记熔断」）——
那不是性能优化，而是**对抗风控**：同一批参数被反复请求时它只真正打一次上游。
自建服务若无这层，网关的并行调用（首页一次并发 5 个接口）会把上游打成
`429 触发风控, 需登录或者安全验证`（实测可复现）。

两条安全底线
------------
* **缓存键里带凭据指纹**：登录态会影响结果（搜索结果、我的歌单……），
  绝不能把 A 的响应喂给 B。
* **只缓存成功**；命中风控时进短冷却（这段时间同样的请求直接沿用失败结论），
  避免一次 429 引发连环撞墙。
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from qqmusic_api import Credential
from qqmusic_api import RatelimitedError

# 公开数据的缓存时长。与原 web 层给公开路由的 300s 对齐。
DEFAULT_TTL_SECONDS = 300.0
# 命中风控后的冷却时长：期内相同请求直接复用失败结论。
COOLDOWN_SECONDS = 5.0


class _Entry:
    """一次成功结果，或一次需要短期复用的失败。"""

    __slots__ = ("value", "error", "expires_at")

    def __init__(self, value: Any, error: BaseException | None, expires_at: float) -> None:
        self.value = value
        self.error = error
        self.expires_at = expires_at


def credential_fingerprint(credential: Credential | None) -> str:
    """凭据指纹：只用于区分「谁的缓存」，不落明文。

    musicid 本身可读（就是 QQ 号），musickey 走哈希 —— 缓存键可能被打印进日志。
    """
    if credential is None:
        return "anon"
    key_hash = hashlib.sha256((credential.musickey or "").encode("utf-8")).hexdigest()[:12]
    return f"{credential.musicid}:{key_hash}"


def cache_key(*parts: Any, credential: Credential | None = None) -> str:
    """由「接口名 + 全部入参 + 凭据指纹」生成稳定键。"""
    raw = "|".join(str(part) for part in parts) + "|" + credential_fingerprint(credential)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class ResponseCache:
    """TTL 缓存 + 在途请求合并。"""

    def __init__(self, ttl: float = DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._entries: dict[str, _Entry] = {}
        self._inflight: dict[str, asyncio.Task[Any]] = {}

    async def run(
        self,
        key: str,
        factory: Callable[[], Awaitable[Any]],
        ttl: float | None = None,
    ) -> Any:
        """取缓存；未命中则合并同键请求，只放一个真正打上游。"""
        now = time.monotonic()
        entry = self._entries.get(key)
        if entry is not None:
            if entry.expires_at > now:
                if entry.error is not None:
                    raise entry.error
                return entry.value
            del self._entries[key]

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(factory())
            self._inflight[key] = task
            task.add_done_callback(lambda finished: self._forget(key, finished))

        # shield：调用方（浏览器）断开不能把这次共享的上游请求一起掐掉，
        # 否则同一刻在等的其它请求都会跟着失败。
        return await asyncio.shield(task)

    def _forget(self, key: str, task: asyncio.Task[Any]) -> None:
        if self._inflight.get(key) is task:
            del self._inflight[key]

        if task.cancelled():
            return
        error = task.exception()
        if error is None:
            self._entries[key] = _Entry(task.result(), None, time.monotonic() + self._ttl)
            return
        # 读掉异常，避免 asyncio 打「Task exception was never retrieved」；
        # 等待方仍然会正常收到这个异常。
        if isinstance(error, RatelimitedError):
            self._entries[key] = _Entry(None, error, time.monotonic() + COOLDOWN_SECONDS)


response_cache = ResponseCache()
