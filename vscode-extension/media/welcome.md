# 👋 Welcome to EdgeCheck

EdgeCheck finds **edge cases and crash risks** in your Python code — *before* they reach production.

## Try it in 30 seconds
1. Create a Python file, paste:
```py
def divide(a: int, b: int):
    return a / b  # division-by-zero risk

def byte_at_100(b: bytes):
    return b[100]  # index-out-of-range risk

