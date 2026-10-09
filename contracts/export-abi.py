import json
from pathlib import Path

root = Path(__file__).resolve().parent
for name in ("SandboxAccount", "MandateRegistry", "ExecutionModule", "LocalTestToken"):
    artifact = json.loads((root / "out" / f"{name}.sol" / f"{name}.json").read_text())
    (root / "abi" / f"{name}.json").write_text(json.dumps(artifact["abi"], indent=2) + "\n")
