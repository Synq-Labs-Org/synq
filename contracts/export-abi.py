import json
from pathlib import Path

root = Path(__file__).resolve().parent
contracts = (
    "SynqGroupFactory",
    "MandateRegistry",
    "ExecutionModule",
    "SynqSafeModuleSetup",
    "LocalTestToken",
    "SafeL2",
    "SafeProxyFactory",
    "RiskAttestationRegistry",
    "SynqArcVaultFactory",
    "SynqArcVaultPolicy",
    "SynqMilestoneEscrow",
    "SynqArcFallbackHandler",
)
for name in contracts:
    artifact = json.loads((root / "out" / f"{name}.sol" / f"{name}.json").read_text())
    (root / "abi" / f"{name}.json").write_text(json.dumps(artifact["abi"], indent=2) + "\n")
