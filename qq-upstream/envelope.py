"""响应信封与「异常 → HTTP」映射。

复刻原 web 层（`QQMusicApi/web/src/core/response.py` 与 `core/error_mapping.py`）：
* 成功：`{"code": 0, "msg": "ok", "data": <...>}`
* 失败：`{"code": -1, "msg": "<说明>"}`（**不带 `data` 键**），语义由 HTTP 状态码承载。

必须一模一样的原因见 `app.py`：网关只认 `code === 0`，形状一变就得两头改。
"""

from __future__ import annotations

from typing import Any

# 异常类名 → HTTP 状态。按 MRO 顺序匹配，子类（如 LoginAuthExpiredError）先命中自己的项。
STATUS_BY_EXCEPTION: dict[str, int] = {
    "RatelimitedError": 429,
    "CredentialInvalidError": 401,
    "CredentialExpiredError": 401,
    "CredentialRefreshError": 401,
    "LoginError": 400,
    "TimeoutNetworkError": 504,
    "NetworkError": 503,
    "HTTPError": 502,
    "ApiDataError": 502,
}

# 文案表：与原 web 层的 HTTP_ERROR_MESSAGES 对齐。
# 5xx 一律用固定文案，别把上游响应细节透出去。
STATUS_MESSAGES: dict[int, str] = {
    400: "请求错误",
    401: "未授权",
    403: "禁止访问",
    404: "资源不存在",
    422: "请求参数校验失败",
    500: "服务器内部错误",
    502: "上游服务响应异常",
    503: "上游服务暂不可用",
    504: "上游服务响应超时",
}

# 未登录（需要凭据却没有）—— 与原 web 层的措辞一致。
NO_CREDENTIAL_MESSAGE = "未提供有效的登录凭证"


def ok(data: Any = None) -> dict[str, Any]:
    """成功信封。"""
    return {"code": 0, "msg": "ok", "data": data}


def fail(message: str = "", status: int = 400) -> dict[str, Any]:
    """失败信封：只有 code 与 msg。"""
    return {"code": -1, "msg": _message(message, status)}


def _message(message: str, status: int) -> str:
    """5xx 用固定文案，其余优先用传进来的说明。"""
    if status >= 500:
        return STATUS_MESSAGES.get(status, "服务器内部错误")
    return message or STATUS_MESSAGES.get(status, "请求错误")


def status_for(exc: BaseException) -> int:
    """按继承链找 HTTP 状态；找不到时按原 web 层的兜底给 400。"""
    for cls in type(exc).__mro__:
        status = STATUS_BY_EXCEPTION.get(cls.__name__)
        if status is not None:
            return status
    return 400
