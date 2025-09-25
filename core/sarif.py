# edgecheck: ignore-file
# edgecheck: ignore-file
import json, os
from typing import List, Dict

def to_sarif(findings: List[Dict]) -> str:
    rules = {}
    results = []
    for f in findings or []:
        rule_id = f.get("code", "EC999")
        if rule_id not in rules:
            rules[rule_id] = {
                "id": rule_id,
                "name": f.get("title", rule_id),
                "shortDescription": {"text": f.get("title", rule_id)},
                "fullDescription": {"text": f.get("hint", "")},
                "help": {"text": f.get("hint", "")},
                "properties": {"tags": ["edgecheck"]}
            }
        level = {
            "error": "error",
            "warning": "warning",
            "info": "note"
        }.get(str(f.get("severity", "warning")).lower(), "warning")
        results.append({
            "ruleId": rule_id,
            "level": level,
            "message": {"text": f.get("message","")},
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": {"uri": "file://" + os.path.abspath(f.get("file",""))},
                    "region": {
                        "startLine": f.get("line", 1),
                        "startColumn": (f.get("start_col") or 1) + 1,
                        "endColumn": (f.get("end_col") or 120) + 1
                    }
                }
            }]
        })
    sarif = {
        "version": "2.1.0",
        "$schema": "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",
        "runs": [{
            "tool": {"driver": {"name": "EdgeCheck", "rules": list(rules.values())}},
            "results": results
        }]
    }
    return json.dumps(sarif, indent=2)
