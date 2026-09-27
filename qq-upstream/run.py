"""启动自建 QQ 音乐上游服务。

用法::

    python qq-upstream/run.py            # 默认 127.0.0.1:8080，与原 web 层同一个端口
    QQ_UPSTREAM_PORT=8081 python run.py  # 换端口（便于新旧并跑对比）

**必须单 worker**：扫码会话存在进程内存里（`session.QrSessions`），多 worker 会各存一份，
轮询就可能落到没有该会话的那个进程上。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 与上游的 web/run.py 同样的做法：把本目录放进 sys.path，
# 这样从任何 cwd 启动都能 `import app` / `import routes`。
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import uvicorn  # noqa: E402 - 必须在 sys.path 调整之后导入

HOST = os.environ.get("QQ_UPSTREAM_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.environ.get("QQ_UPSTREAM_PORT", "8080"))
LOG_LEVEL = os.environ.get("QQ_UPSTREAM_LOG_LEVEL", "info").strip() or "info"


if __name__ == "__main__":
    uvicorn.run(
        "app:create_app",
        factory=True,
        host=HOST,
        port=PORT,
        workers=1,
        log_level=LOG_LEVEL,
        access_log=LOG_LEVEL == "debug",
    )
