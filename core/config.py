from dataclasses import dataclass

@dataclass
class Config:
    budget_ms: int = 200
    fmt: str = "pretty"  # or 'json'
