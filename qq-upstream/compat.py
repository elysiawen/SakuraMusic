"""对第三方依赖打的小补丁。

只放「不改就会坏、且上游短期不会修」的那几条，每条都写清楚为什么。
`qq-upstream/` 的既定做法是「薄壳 + 钉住的发布版 SDK，坏的地方在自己这层兜住」，
所以补丁放在这里，而不是去改 `site-packages` 或 fork SDK。

调用点：`app.py` 在模块导入时立刻调用（uvicorn 以 `app:create_app` 加载本服务），
早于任何请求；重复调用无副作用。
"""

from __future__ import annotations

import sys
from types import MappingProxyType
from typing import Any

# ---------------------------------------------------------------------------
# 空值 Cookie 会让 SDK 的响应快照抛 KeyError
#
# `qqmusic_api/core/response.py`（0.8.2 起的新内核）这样快照响应 Cookie：
#
#     cookies: dict[str, str] = {}
#     for name in response.cookies.keys():
#         cookies[name] = response.cookies[name]
#
# 而 `RequestsCookieJar.__getitem__` → `_find_no_duplicates`，末尾判存在用的是**真值判断**：
#
#     if toReturn:
#         return toReturn
#     raise KeyError(f"name={name!r}, domain={domain!r}, path={path!r}")
#
# `toReturn` 是 `cookie.value`（字符串），于是**值为空字符串的 Cookie 被判成「不存在」**，
# 抛 KeyError。`keys()` 与 `_find_no_duplicates` 遍历的是同一个 jar，`keys()` 既然给出了这个名字，
# 就说明它确实在，唯一可能就是值是空的。requests / niquests 一直如此，**不是回归、pin 版本也没用**
# （niquests main 分支现在仍是这一句）。
#
# 触发点：`ssl.ptlogin2.qq.com/ptqrlogin` 会回 `Set-Cookie: ETK=`（空值），
# 而手机 QQ 扫码的轮询（`login._check_qq_qr`，`raw=True`）每次都要响应体，
# 走到 `executor._deliver` → `snapshot_payload()` 就炸 ——
# 单个轮询 500，网关拿到 502，前端显示「服务器内部错误」，扫码永远走不到「已扫描」。
#
# 修法：仍然先走原实现（正常响应零行为变化），**只在它抛 KeyError 时**用 jar 自己的
# `get_dict()` 重建快照 —— 那个方法就是 `dictionary[cookie.name] = cookie.value`，
# 空值照样进字典。不去动 jar 的 `__getitem__` / `.get()` 语义，别的地方按原样拿到默认值。
# ---------------------------------------------------------------------------


def _snapshot_without_jar_lookup(response: Any) -> Any:
    """用「整表导出」代替「逐个查名」重建载荷快照（见文件头）。"""
    from qqmusic_api.core import response as response_module

    jar = response.cookies
    dump = getattr(jar, "get_dict", None)
    cookies = dump() if callable(dump) else {cookie.name: cookie.value for cookie in jar}

    # 字段逐个显式填：SDK 若改了 RawPayload 的定义，这里会因为缺参立刻报错，
    # 而不是静默产出一个字段缺失的快照。
    return response_module.RawPayload(
        status_code=response.status_code,
        url=response.url,
        headers=MappingProxyType(response.headers),
        cookies=cookies,
        content=response.content or b"",
        text=response.text or "",
    )


def apply_snapshot_payload_patch() -> None:
    """让 SDK 的响应快照容忍空值 Cookie（幂等）。"""
    from qqmusic_api.core import response as response_module

    original = response_module.snapshot_payload
    if getattr(original, "_sakura_empty_cookie_safe", False):
        return

    def snapshot_payload(response: Any) -> Any:
        try:
            return original(response)
        except KeyError:
            return _snapshot_without_jar_lookup(response)

    snapshot_payload.__doc__ = original.__doc__
    # 标记打在函数上，重复调用能认出「已经打过」。
    snapshot_payload._sakura_empty_cookie_safe = True  # type: ignore[attr-defined]

    response_module.snapshot_payload = snapshot_payload

    # `core/executor.py` 是 `from .response import ... snapshot_payload` 直接绑定的名字，
    # 只改 `response` 模块不够 —— 凡是已经加载、且还持有旧引用的 qqmusic_api 子模块都要换过来。
    # 用「引用相等」判断，避免误改同名但无关的属性。
    rebound: list[str] = []
    for module in list(sys.modules.values()):
        name = getattr(module, "__name__", "")
        if not name.startswith("qqmusic_api"):
            continue
        if getattr(module, "snapshot_payload", None) is original:
            module.snapshot_payload = snapshot_payload
            rebound.append(name)

    # 这里只做记录：`rebound` 为空不是问题 —— `executor` 若尚未 import，
    # 它稍后 `from .response import snapshot_payload` 拿到的就是修正版。
    detail = f"并重绑了直接引用它的模块：{', '.join(rebound)}" if rebound else "（后续 import 的模块会拿到修正版）"
    print(f"[qq-upstream] 已修正空值 Cookie 的响应快照（ETK= 之类的空值不再抛 KeyError），{detail}", flush=True)
