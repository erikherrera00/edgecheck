# edgecheck: ignore-file
from __future__ import annotations

import ast
import importlib.util
import inspect
import time
import json
import contextlib
import io
import sys
import itertools
import multiprocessing as mp
import os
import traceback
import math
import fnmatch
import random
from typing import Any, Dict, List, Tuple, Optional, get_origin, get_args
from typing import get_origin, get_args, Any, Optional, Union
from multiprocessing import Process, Pipe
from core.codes import lookup_for_exception_name, lookup_valueerror_by_message

# --------------------------------------------------------------------
# Public decorator to ignore a specific function at analysis time
# --------------------------------------------------------------------
def _load_ignore_patterns(root: str) -> list[str]:
    p = os.path.join(root, ".edgecheckignore")
    if not os.path.isfile(p):
        return []
    with open(p, "r", encoding="utf-8") as f:
        pats = [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]
    return pats

def _is_ignored(path: str, root: str, patterns: list[str]) -> bool:
    rel = os.path.relpath(path, root)
    # support both dir/ pattern and glob patterns
    for pat in patterns:
        if pat.endswith("/"):
            # directory prefix ignore
            if rel == pat[:-1] or rel.startswith(pat):
                return True
        if fnmatch.fnmatch(rel, pat):
            return True
    return False

def edgecheck_ignore(func):
    """Decorator: mark a function to be ignored by EdgeCheck."""
    setattr(func, "__edgecheck_ignore__", True)
    return func
try:
    MPCTX = mp.get_context("fork")
except ValueError:
    MPCTX = mp.get_context()
# --------------------------------------------------------------------
# Module loading
# --------------------------------------------------------------------
def load_module_from_path(path: str):
    """Load a Python module from a file path with a stable name."""
    spec = importlib.util.spec_from_file_location("edgecheck_target", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load spec from {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod

# --------------------------------------------------------------------
# Candidate value generation
# --------------------------------------------------------------------
FALLBACK_VALUES: List[Any] = [
    0, 1, -1,
    0.0, 1.0, -1.0,
    "", "x",
    b"", b"\x00", bytes(range(101)),
    [], [0], [1],
    (), (0,), (1,),
    {}, {"k": 0},
    True, False, None,
]

def _values_for_annotation(ann: Any) -> List[Any]:
    """Return small, diverse candidate sets based on type annotations. Never raise."""
    try:
        origin = get_origin(ann)
        args = get_args(ann) if origin else ()

        # typing containers
        if origin is list:
            return [[], [0], ["x"]]
        if origin is tuple:
            return [(), (0,), ("x",)]
        if origin is dict:
            return [{}, {"k": 0}]
        if origin is set:
            return [set(), {0}]

        # Optional[T] == Union[T, NoneType]
        if origin is Optional or (origin is getattr(__import__("typing"), "Union") and type(None) in args):
            inner = [a for a in args if a is not type(None)]
            pool: List[Any] = [None]
            for a in inner or [Any]:
                pool.extend(_values_for_annotation(a)[:2])
            # dedupe
            seen, out = set(), []
            for v in pool:
                k = repr(v)
                if k in seen:
                    continue
                seen.add(k)
                out.append(v)
            return out[:5]

        # Plain classes
        if ann in (int,):
            return [0, 1, -1]
        if ann in (float,):
            return [0.0, 1.0, -1.0]
        if ann in (str,):
            return ["", "x"]
        if ann in (bytes,):
            return [b"", b"\x00", bytes(range(101))]
        if ann in (bool,):
            return [False, True]
        if ann in (list,):
            return [[], [0]]
        if ann in (tuple,):
            return [(), (0,)]
        if ann in (dict,):
            return [{}, {"k": 0}]
    except Exception:
        pass
    return FALLBACK_VALUES

# --------------------------------------------------------------------
# Subprocess runner with timeout
# --------------------------------------------------------------------
def _runner(target_path: str, fn_name: str, args, kwargs, conn):
    """
    Run a single function from target_path in a clean globals dict so no symbols
    (like 'path') leak into the module namespace.
    """
    try:
        # Read source
        with open(target_path, "r", encoding="utf-8") as f:
            src = f.read()

        # Compile and exec in a FRESH globals dict
        g = {
            "__name__": "__edgecheck_target__",
            "__file__": target_path,
            "__package__": None,
            "__builtins__": __builtins__,
        }
        code = compile(src, target_path, "exec")
        exec(code, g, g)  # module-level code runs here, isolated

        # Look up the function
        if fn_name not in g or not callable(g[fn_name]):
            conn.send((
                False,
                f"AttributeError: function {fn_name} not found in {target_path}",
                ""
            ))
            return

        # Call it
        g[fn_name](*args, **kwargs)

        # Success
        conn.send((True, "", ""))
    except Exception as e:
        tb = traceback.format_exc()
        conn.send((False, f"{e.__class__.__name__}: {e}", tb))

def _call_with_timeout(target_path, fn_name, args, kwargs, budget_ms):
    parent_conn, child_conn = Pipe(duplex=False)
    p = Process(target=_runner, args=(os.path.abspath(target_path), fn_name, args, kwargs, child_conn))
    p.start()
    child_conn.close()
    p.join(timeout=budget_ms / 1000.0)

    if p.is_alive():
        p.terminate()
        p.join(0.1)
        return False, "TimeoutError: budget exceeded", ""

    if parent_conn.poll():
        ok, msg, tb = parent_conn.recv()
    else:
        ok, msg, tb = False, "RuntimeError: no result from child", ""
    parent_conn.close()
    return ok, msg, tb



# --------------------------------------------------------------------
# AST utilities for precise ranges
# --------------------------------------------------------------------
def _function_nodes_by_name(tree: ast.AST) -> Dict[str, ast.FunctionDef]:
    return {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

def _node_span(node: ast.AST) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    """Safely extract (lineno, col, end_col) from a node; tolerate missing end_col_offset."""
    ln = getattr(node, "lineno", None)
    sc = getattr(node, "col_offset", None)
    ec = getattr(node, "end_col_offset", None)
    if ln is not None and sc is not None and ec is None:
        ec = sc + 1  # best-effort width
    return ln, sc, ec

def _risky_spans(fn_node: ast.FunctionDef) -> List[Tuple[int, int, int, str]]:
    """
    Collect spans as (lineno, start_col, end_col, kind) for constructs likely to cause crashes:
      - 'div' for division (a / b)
      - 'subscript' for indexing/slicing (b[...])
    """
    spans: List[Tuple[int, int, int, str]] = []
    for node in ast.walk(fn_node):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            ln, sc, ec = _node_span(node)
            if ln is not None and sc is not None and ec is not None:
                spans.append((ln, sc, ec, "div"))
        elif isinstance(node, ast.Subscript):
            ln, sc, ec = _node_span(node)
            if ln is not None and sc is not None and ec is not None:
                spans.append((ln, sc, ec, "subscript"))
    return spans

def _best_span_for_exc(spans: List[Tuple[int,int,int,str]], line: int, exc_name: str) -> Tuple[int, int]:
    """Pick an AST span on 'line' that best matches the exception kind."""
    kind = None
    exc = (exc_name or "").split(".")[-1]
    if exc == "ZeroDivisionError":
        kind = "div"
    elif exc == "IndexError":
        kind = "subscript"

    # Prefer a span of matching kind on the same line
    candidates = [(sc, ec) for (ln, sc, ec, k) in spans if ln == line and (kind is None or k == kind)]
    if candidates:
        return min(candidates, key=lambda t: t[0])

    # Any span on the same line
    candidates = [(sc, ec) for (ln, sc, ec, _k) in spans if ln == line]
    if candidates:
        return min(candidates, key=lambda t: t[0])

    # Fallback: underline most of the line
    return (0, 120)

def _extract_line_from_stack(stack: str, path: str, default_line: int) -> int:
    """
    Try to get the most relevant line number from a Python traceback for the given file.
    Looks for the last occurrence of 'File \"...path...\", line N'.
    """
    if not stack:
        return default_line
    needle = os.path.abspath(path)
    line_num = default_line
    for ln in stack.splitlines():
        ln = ln.strip()
        if ln.startswith('File "') and needle in ln:
            try:
                parts = [p.strip() for p in ln.split(",")]
                for p in parts:
                    if p.startswith("line "):
                        num = int(p.replace("line ", "").strip())
                        if num > 0:
                            line_num = num
            except Exception:
                pass
    return line_num

def _some_bytes_of_len(n: int) -> bytes:
    return bytes([i % 256 for i in range(n)])

def _values_for_annotation(ann) -> list:
    """Return candidate values for a type annotation."""
    origin = get_origin(ann)
    args = get_args(ann)

    # Optional[T] or Union[T, None]
    if origin is Union and type(None) in args:
        inner = [a for a in args if a is not type(None)]
        base = _values_for_annotation(inner[0]) if inner else [None]
        return [None] + base

    if ann in (int,):
        return [0, 1, -1, 2, -2, 10**9, -10**9]
    if ann in (float,):
        return [0.0, -0.0, 1.0, -1.0, 1e308, -1e308, float('inf'), float('-inf'), float('nan')]
    if ann in (bool,):
        return [False, True]
    if ann in (str,):
        long = "x" * 256
        unicodey = "ñö🦄"
        return ["", "a", "0", "-1", long, unicodey]
    if ann in (bytes, bytearray):
        return [b"", b"\x00", _some_bytes_of_len(50), _some_bytes_of_len(100), _some_bytes_of_len(101)]
    if ann in (list,):
        return [[], [0], [1,2,3]]
    if ann in (tuple,):
        return [(), (0,), (1,2)]
    if ann in (dict,):
        return [{}, {"k":"v"}, {0:1}]
    if ann is Any:
        return [None, 0, 1, "", "x", b"", _some_bytes_of_len(100)]
    # Unknown/other annotation → fall back
    return []

FALLBACKS = [
    None,
    0, 1, -1, 2, -2,
    0.0, -0.0, 1.0, -1.0, float('inf'), float('-inf'), float('nan'),
    "", "a", "0",
    b"", _some_bytes_of_len(100), _some_bytes_of_len(101),
    [], [0], (), (0,), {}, {"k": "v"}, True, False,
]
# --------------------------------------------------------------------
# Main analyzer
# --------------------------------------------------------------------
def analyze_file(
    path: str,
    budget_ms: int = 200,
    max_trials_per_fn: int = 24,
    max_findings_per_file: int = 50
) -> List[Dict[str, Any]]:
    """
    Analyze top-level functions in 'path':
      - Honor file pragma '# edgecheck: ignore-file' (first 5 lines)
      - Generate small input candidates from type hints or fallbacks
      - Execute in a subprocess with timeout
      - Map exceptions to EC codes (core.codes)
      - Provide AST-precise start/end columns when possible
      - Include parameter names (for smarter Quick Fixes)
    """
    # Read source & honor ignore pragma early
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if any(line.strip().lower() == "# edgecheck: ignore-file" for line in src.splitlines()[:5]):
        return []

    # Parse AST (for function lines & spans)
    tree = ast.parse(src, filename=path)
    line_map = {n.name: n.lineno for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    fn_nodes = _function_nodes_by_name(tree)
    fn_spans: Dict[str, List[Tuple[int,int,int,str]]] = {name: _risky_spans(fn) for name, fn in fn_nodes.items()}

    # Load module after possible early-exit
    mod = load_module_from_path(path)

    findings: List[Dict[str, Any]] = []

    # Collect only top-level functions defined in this module
    fns: List[Tuple[str, Any]] = []
    for name, obj in inspect.getmembers(mod, inspect.isfunction):
        if getattr(obj, "__module__", None) != getattr(mod, "__name__", None):
            continue
        if name.startswith("_"):  # skip private helpers
            continue
        if "<locals>" in getattr(obj, "__qualname__", ""):  # skip nested/local fns
            continue
        if getattr(obj, "__edgecheck_ignore__", False):
            continue
        fns.append((name, obj))

    for name, fn in fns:
        # Parameter names (used by Quick Fixes)
        try:
            sig = inspect.signature(fn)
            params = list(sig.parameters.values())
            param_names = [p.name for p in params]
        except Exception:
            params = []
            param_names = []

        # Per-parameter candidates
        candidates: List[List[Any]] = []
        for p in params:
            ann = p.annotation
            vals = _values_for_annotation(ann) if ann is not inspect._empty else FALLBACK_VALUES
            candidates.append(vals[:5] if vals else FALLBACK_VALUES[:5])

        tried = 0
        combos = itertools.product(*candidates) if candidates else [()]
        for combo in combos:
            if tried >= max_trials_per_fn:
                break
            if len(findings) >= max_findings_per_file:
                break
            tried += 1

            args = list(combo)
            ok, msg, stack = _call_with_timeout(path, name, args, {}, budget_ms)
            if not ok:
                # Map exception → EC code
                exc_name = "TimeoutError" if msg.startswith("TimeoutError") else (msg.split(":")[0] if ":" in msg else "Exception")
                ec = lookup_for_exception_name(exc_name)
                if exc_name == "ValueError":
                    guard_ec = lookup_valueerror_by_message(msg)
                    if guard_ec:
                        ec = guard_ec

                # Determine the most relevant source line (prefer traceback line)
                default_line = line_map.get(name, 1)
                line = _extract_line_from_stack(stack, path, default_line)

                # AST-precise columns
                spans = fn_spans.get(name, [])
                start_col, end_col = _best_span_for_exc(spans, line, exc_name)

                findings.append({
                    "file": os.path.abspath(path),
                    "function": name,
                    "param_names": param_names,
                    "line": line,
                    "start_col": start_col,
                    "end_col": end_col,
                    "kind": "Crash" if exc_name != "TimeoutError" else "Timeout",
                    "code": (ec.id if ec else "EC999"),
                    "title": (ec.title if ec else exc_name),
                    "severity": (ec.default_severity if ec else "warning"),
                    "message": msg,
                    "hint": (ec.hint if ec else "Review function arguments and add guards."),
                    "repro": {"args": args, "kwargs": {}},
                    "stack": stack,
                })
                # One repro per function for now
                break

    return findings
