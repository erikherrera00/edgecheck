def divide(a: int, b: int):
    return a / b  # risk: ZeroDivisionError

def bad_bytes(b: bytes):
    return b[100]  # risk: IndexError

def slice_head(s: str, n: int):
    return s[:n]
