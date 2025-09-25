def divide(a: int, b: int):
    if b == 0:
        raise ValueError("denominator cannot be zero")
    return a / b

def bad_bytes(b: bytes):
    if not b or len(b) <= 100:
        raise ValueError("buffer too small for index 100")
    return b[100]

