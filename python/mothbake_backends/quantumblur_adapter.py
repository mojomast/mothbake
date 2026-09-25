"""Pinned upstream QuantumBlur grid adapter (no MicroMoth fallback)."""

import contextlib
import importlib.metadata as metadata
import importlib.util
import json
import inspect
import math
import sys

UPSTREAM = "https://github.com/qiskit-community/QuantumBlur"
COMMIT = "cecdf5faf08e847c41f5b0aeea923e15803875e8"
IDENTITY = "local:quantumblur:" + COMMIT
MAX_CELLS = 4096
MAX_QUBITS = 20
DEPENDENCIES = ("quantumblur", "qiskit", "qiskit-aer", "numpy", "scipy", "Pillow")


def _provenance(distribution):
    """Only a direct git install at the audited official SHA is accepted."""
    try:
        record = json.loads(distribution.read_text("direct_url.json") or "{}")
    except (ValueError, OSError):
        return False
    url = record.get("url", "").removesuffix(".git").rstrip("/").lower()
    git = record.get("vcs_info", {})
    return (url == UPSTREAM.lower() and git.get("vcs") == "git"
            and git.get("commit_id", "").lower() == COMMIT)


def probe():
    versions = {}
    for package in DEPENDENCIES:
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            versions[package] = None
    try:
        dist = metadata.distribution("quantumblur")
        pinned = _provenance(dist)
    except metadata.PackageNotFoundError:
        pinned = False
    available = pinned and all(versions.values()) and importlib.util.find_spec("qiskit_aer") is not None
    return {
        "available": bool(available), "backend": IDENTITY, "source": UPSTREAM,
        "commit": COMMIT, "license": "Apache-2.0", "python": sys.version.split()[0],
        "dependencies": versions, "reason": None if available else "official pinned QuantumBlur Qiskit installation and dependencies required",
    }


def blur(request):
    if set(request) != {"operation", "width", "height", "values", "xi", "locality", "axis"}:
        raise ValueError("blur requires operation, dimensions, values, xi, locality and axis")
    width, height, values, xi, locality, axis = (request[key] for key in ("width", "height", "values", "xi", "locality", "axis"))
    qubits = math.ceil(math.log2(width)) + math.ceil(math.log2(height)) if width > 0 and height > 0 else MAX_QUBITS + 1
    if (type(width) is not int or type(height) is not int or width < 2 or height < 2
            or width * height > MAX_CELLS or qubits > MAX_QUBITS):
        raise ValueError("grid dimensions exceed local cell or qubit limits")
    if (not isinstance(values, list) or len(values) != width * height
            or any(type(v) not in (float, int) or not math.isfinite(v) or v < 0 or v > 1 for v in values)
            or not any(values)):
        raise ValueError("values must be a nonzero finite grid of numbers in [0, 1]")
    if type(xi) not in (int, float) or not math.isfinite(xi) or not 0 <= xi <= 1:
        raise ValueError("xi must be finite and in [0, 1]")
    if type(locality) not in (int, float) or not math.isfinite(locality) or not 0 <= locality <= 1:
        raise ValueError("locality must be finite and in [0, 1]")
    if axis not in ("x", "y"):
        raise ValueError("axis must be x or y")
    info = probe()
    if not info["available"]:
        raise ValueError(info["reason"])
    # Import only after checking provenance. Upstream's import otherwise silently
    # selects MicroMoth when Qiskit is unavailable.
    with contextlib.redirect_stdout(sys.stderr):
        from quantumblur import quantumblur as qb
    if qb.simple_python:
        raise ValueError("QuantumBlur Qiskit backend required")
    grid = {(x, y): values[y * width + x] for y in range(height) for x in range(width)}
    params = inspect.signature(qb.blur_height).parameters
    kwargs = {"axis": axis} if "axis" in params else {}
    if "locality" in params:
        kwargs["locality"] = locality
    elif locality != 1:
        raise ValueError("installed QuantumBlur API does not support non-default locality")
    output = qb.circuit2height(qb.blur_height(grid, xi, **kwargs))
    result = [float(output[x, y]) for y in range(height) for x in range(width)]
    if not all(math.isfinite(v) and 0 <= v <= 1 for v in result):
        raise ValueError("QuantumBlur produced invalid output")
    return {"backend": IDENTITY, "provenance": info, "width": width, "height": height, "values": result}
