"""
Loads only the pure-logic slice of ../chronix.py (constants + every
`pure_*` helper, between the "SECTION 1" and "END PURE LOGIC" banner
comments) into this module's namespace, without ever importing the real
`genlayer` package.

Why: chronix.py's very first non-comment line is `from genlayer import *`,
which isn't installed here (GenVM contracts run inside GenLayer Studio's own
sandbox, not a local venv) — see contracts/README.md's Testing section.
Everything below `# END PURE LOGIC` is deliberately free of `gl.*` and
storage access so it's plain, deterministic Python; this loader just execs
that slice directly instead of maintaining a parallel copy of the same
logic (which would silently drift from the real contract) or a fake
`genlayer` stub package (which would need updating every time the gl.*
surface used below the banner changes, for logic these tests don't even
exercise).
"""

from pathlib import Path

_CONTRACT_PATH = Path(__file__).resolve().parent.parent / "chronix.py"
_START_MARKER = "# SECTION 0 — CONSTANTS"
_END_MARKER = "# END PURE LOGIC"


def _load_pure_namespace() -> dict:
    source = _CONTRACT_PATH.read_text()
    start = source.index(_START_MARKER)
    end = source.index(_END_MARKER)
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError(
            "Could not locate the pure-logic slice in chronix.py — has a "
            "banner comment been renamed? See _pure.py's module docstring."
        )
    pure_source = source[start:end]
    namespace: dict = {"__name__": "chronix_pure"}
    exec(compile(pure_source, str(_CONTRACT_PATH) + "#pure-slice", "exec"), namespace)
    return namespace


_ns = _load_pure_namespace()
globals().update({k: v for k, v in _ns.items() if not k.startswith("__")})
