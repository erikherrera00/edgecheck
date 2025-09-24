import pytest

def test_bad_bytes_repro():
    # Repro for: Crash - IndexError: index out of range
    from __main__ import __file__  # noqa: F401
    import importlib.util, os
    spec = importlib.util.spec_from_file_location('edgecheck_target', r"/Users/erikherrera/code/edgecheck/examples/target_math.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore
    with pytest.raises(ValueError):
        getattr(mod, 'bad_bytes')(b'')

def test_divide_repro():
    # Repro for: Crash - ZeroDivisionError: division by zero
    from __main__ import __file__  # noqa: F401
    import importlib.util, os
    spec = importlib.util.spec_from_file_location('edgecheck_target', r"/Users/erikherrera/code/edgecheck/examples/target_math.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore
    with pytest.raises(ValueError):
        getattr(mod, 'divide')(0, 0)
