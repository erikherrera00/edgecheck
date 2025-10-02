def divide(a: int, b: int):
    if b == 0:
        raise ValueError("denominator cannot be zero")
    return a / b  # risk: ZeroDivisionError
if not isinstance(b, (bytes, bytearray)):
    raise TypeError("b must be bytes-like")
if len(b) <= 100:
    raise ValueError("buffer too small for index 100")

def bad_bytes(b: bytes):
    return b[100]  # risk: IndexError

def slice_head(s: str, n: int):
    return s[:n]