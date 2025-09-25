# core/codes.py
from dataclasses import dataclass
from typing import Optional

@dataclass
class Code:
    id: str
    title: str
    default_severity: str = "warning"
    hint: str = ""

# Real crashes
EC001 = Code("EC001", "Possible division by zero", "error", "Check denominator or early-return.")
EC002 = Code("EC002", "Index may be out of range", "error", "Validate buffer length/index.")

# Intentional guards (info)
EC101 = Code("EC101", "Guarded invalid input (zero denominator)", "info",
             "This ValueError is an intentional guard. Consider documenting or returning a Result type.")
EC102 = Code("EC102", "Guarded invalid input (buffer size)", "info",
             "This ValueError is an intentional guard. Consider documenting or validating earlier.")

def lookup_for_exception_name(exc_name: str) -> Optional[Code]:
    exc = (exc_name or "").split(".")[-1]
    if exc == "ZeroDivisionError":
        return EC001
    if exc == "IndexError":
        return EC002
    if exc == "ValueError":
        # generic ValueError (if message doesn’t match a known guard) -> treat as warning
        return Code("EC090", "ValueError", "warning", "Review arguments and add guards.")
    return None

def lookup_valueerror_by_message(msg: str) -> Optional[Code]:
    m = (msg or "").lower()
    if "denominator cannot be zero" in m:
        return EC101
    if "buffer too small for index" in m:
        return EC102
    return None

