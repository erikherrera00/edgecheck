import json
from typing import List, Dict, Any

def _json_safe(x: Any):
    """
    Recursively convert objects so that json.dumps won't fail.
    - bytes -> repr(...) (e.g., "b'\\x00'")
    - set/tuple -> list
    - fallback: str(x) for unknown types
    """
    if isinstance(x, (str, int, float, bool)) or x is None:
        return x
    if isinstance(x, bytes):
        return repr(x)
    if isinstance(x, (list, tuple, set)):
        return [_json_safe(i) for i in x]
    if isinstance(x, dict):
        return {str(k): _json_safe(v) for k, v in x.items()}
    # fallback for unexpected types (e.g., exceptions)
    return str(x)

def _findings_json_safe(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return _json_safe(findings)  # leverage the recursive converter

def pretty(findings: List[Dict]):
    if not findings:
        print("✅ No crashes found.")
        return
    print("⚠️  Crashes detected:")
    for f in findings:
        loc = f"{f['file']}:{f['line']} in {f['function']}"
        print(f" - {loc}")
        print(f"   {f['kind']}: {f['message']}")
        print(f"   Repro args={f['repro'].get('args')} kwargs={f['repro'].get('kwargs',{})}")

def as_json(findings: List[Dict]):
    safe = _findings_json_safe(findings)
    print(json.dumps({"version": "0.1.0", "findings": safe}, indent=2))

