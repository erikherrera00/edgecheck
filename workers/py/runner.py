import os, sys, traceback, inspect, itertools, ast, builtins
from typing import Any, Dict, List, Tuple, get_origin, get_args
from multiprocessing import Process, Queue
import importlib.util
import multiprocessing as mp
import builtins
import traceback
from core.codes import lookup_for_exception_name, lookup_valueerror_by_message

BASIC_EDGE_VALUES = {
    int: [0, 1, -1, 2**31-1, -2**31],
    float: [0.0, 1.0, -1.0, float('inf'), float('-inf'), float('nan')],
    str: ["", "a", " ", "0", "∞", "🙂", "x"*1024],
    bool: [True, False],
    bytes: [b"", b"\x00", b"\xff"*8],
}
FALLBACK_VALUES = [None, 0, 1, "", [], {}, True, False]

def _values_for_annotation(ann) -> List[Any]:
    if ann in BASIC_EDGE_VALUES:
        return BASIC_EDGE_VALUES[ann]
    origin = get_origin(ann)
    if origin is not None:
        args = list(get_args(ann))
        vals = []
        if type(None) in args:
            args.remove(type(None))
            vals.append(None)
        for a in args:
            vals += _values_for_annotation(a)
        return vals or FALLBACK_VALUES
    return FALLBACK_VALUES

def load_module_from_path(path: str):
    spec = importlib.util.spec_from_file_location("edgecheck_target", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore
    return mod

# Child process entrypoint: reload module from the *path*, then getattr(function_name)
def _runner(q, file_path, function_name, args, kwargs):
    try:
        mod = load_module_from_path(file_path)
        fn = getattr(mod, function_name)

        # very light "sandbox": block open/__import__ during the call
        dangerous = ["open", "__import__"]
        saved = {}
        try:
            for d in dangerous:
                if hasattr(builtins, d):
                    saved[d] = getattr(builtins, d)
                    setattr(builtins, d, None)
            fn(*args, **kwargs)  # execute target
            q.put(("ok", "", ""))
        except Exception as e:
            q.put(("err", f"{type(e).__name__}: {e}", traceback.format_exc()))
        finally:
            for k, v in saved.items():
                setattr(builtins, k, v)
    except Exception as e:
        q.put(("err", f"{type(e).__name__}: {e}", traceback.format_exc()))

def _call_with_timeout(file_path, function_name, args, kwargs, budget_ms: int):
    """
    Execute function (by name) from file_path in a subprocess (spawn) with a time budget.
    """
    ctx = mp.get_context("spawn")
    q: mp.Queue = ctx.Queue()
    p = ctx.Process(target=_runner, args=(q, file_path, function_name, args, kwargs))
    p.start()
    p.join(timeout=budget_ms / 1000.0)

    if p.is_alive():
        p.kill()
        return (False, f"TimeoutError: exceeded {budget_ms}ms", "")

    if q.empty():
        return (False, "UnknownError: no result from subprocess", "")

    status, msg, stack = q.get()
    return (status == "ok", msg, stack)

# workers/py/runner.py

def analyze_file(path: str, budget_ms: int = 200) -> List[Dict[str, Any]]:
    mod = load_module_from_path(path)
    findings: List[Dict[str, Any]] = []

    # Build a map of function name -> line number using AST
    with open(path, "r", encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=path)
    line_map = {n.name: n.lineno for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    # Collect only top-level functions defined in this module
    fns: List[Tuple[str, Any]] = []
    for name, obj in inspect.getmembers(mod, inspect.isfunction):
        if obj.__module__ != mod.__name__:
            continue
        fns.append((name, obj))

    # Try input combinations per function
    for name, fn in fns:
        sig = inspect.signature(fn)
        candidates: List[List[Any]] = []
        for p in sig.parameters.values():
            ann = p.annotation
            vals = _values_for_annotation(ann) if ann is not inspect._empty else FALLBACK_VALUES
            candidates.append(vals[:5])  # keep it small/fast

        tried = 0
        max_trials = 24
        combos = itertools.product(*candidates) if candidates else [()]

        for combo in combos:
            if tried >= max_trials:
                break
            tried += 1
            args = list(combo)

            # Run in a spawned subprocess (safe for macOS) using file path + function name
            ok, msg, stack = _call_with_timeout(path, name, args, {}, budget_ms)
            if not ok:
                # Map exception to EdgeCheck code/title/severity
                exc_name = "TimeoutError" if msg.startswith("TimeoutError") else (
                    msg.split(":")[0] if ":" in msg else "Exception"
                )

                ec = lookup_for_exception_name(exc_name)
                if exc_name == "ValueError":
                    # Recognize intentional guards by message
                    guard_ec = lookup_valueerror_by_message(msg)
                    if guard_ec:
                        ec = guard_ec

                findings.append({
                    "file": os.path.abspath(path),
                    "function": name,
                    "line": line_map.get(name, 1),
                    "start_col": 0,
                    "end_col": 120,
                    "kind": "Crash" if exc_name != "TimeoutError" else "Timeout",
                    "code": ec.id if ec else "EC999",
                    "title": ec.title if ec else exc_name,
                    "severity": (ec.default_severity if ec else "warning"),
                    "message": msg,
                    "hint": (ec.hint if ec else "Review function arguments and add guards."),
                    "repro": {"args": args, "kwargs": {}},
                    "stack": stack,
                })
                # Only keep the first repro per function for now
                break

    # IMPORTANT: return the list (never None)
    return findings

