"""One-request JSON stdin/stdout protocol for the optional local adapter."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quantumblur_adapter import blur, probe  # noqa: E402

MAX_REQUEST = 1024 * 1024


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError("request exceeds byte limit")
        request = json.loads(raw)
        if type(request) is not dict:
            raise ValueError("request must be an object")
        operation = request.get("operation")
        if operation == "probe":
            if set(request) != {"operation"}:
                raise ValueError("probe accepts no additional fields")
            response = probe()
        elif operation == "blur":
            response = blur(request)
        else:
            raise ValueError("unsupported local operation")
        print(json.dumps({"ok": True, **response}, allow_nan=False))
    except (ValueError, TypeError, UnicodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)[:200]}))


if __name__ == "__main__":
    main()
