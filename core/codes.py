from dataclasses import dataclass
from typing import Optional

@dataclass(frozen=True)
class EdgeCode:
    id: str
    default_severity: str  # "error" | "warning" | "info"
    title: str
    hint: str

CODEMAP = {
    "ZeroDivisionError": EdgeCode(
        id="EC001", default_severity="error",
        title="Possible division by zero",
        hint="Check the denominator (e.g., guard with `if b == 0: ...`)."
    ),
    "IndexError": EdgeCode(
        id="EC002", default_severity="error",
        title="Index out of range",
        hint="Guard for length or index bounds (e.g., `if len(b) <= N: ...`)."
    ),
    "TimeoutError": EdgeCode(
        id="EC090", default_severity="warning",
        title="Execution timed out",
        hint="Function exceeded time budget; consider tightening loops or inputs."
    ),
}

GUARD_VALUEERROR_RULES = [
    ("denominator cannot be zero", EdgeCode(
        id="EC101", default_severity="info",
        title="Guarded invalid input (zero denominator)",
        hint="This ValueError is an intentional guard. Consider documenting or returning a Result type."
    )),
    ("buffer too small for index 100", EdgeCode(
        id="EC102", default_severity="info",
        title="Guarded invalid input (buffer size)",
        hint="This ValueError is an intentional guard. Consider documenting or validating earlier."
    )),
]

def lookup_for_exception_name(name: str) -> Optional[EdgeCode]:
    return CODEMAP.get(name)

def lookup_valueerror_by_message(msg: str) -> Optional[EdgeCode]:
    m = msg.lower()
    for needle, ec in GUARD_VALUEERROR_RULES:
        if needle in m:
            return ec
    return None
