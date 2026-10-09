# Deterministic authorization boundary

Only trusted orchestration constructs `Kernel`. Constructor mandates originate from verified governance, balances from reconciled chain state, and `trustedEvidence` hashes from independent risk collection and transaction simulation. An absent balance or evidence attestation fails closed. Planner/plugin requests cannot update any of these trusted inputs. `kernel.mandates.update()` is a trusted governance interface; it is never a planner tool. Existing reservations and cumulative spending survive mandate version updates. Changing the input asset requires a distinct mandate identity.

All wire amounts are canonical uint256 decimal strings. `ActionIntentSchema` is strict, normalizes hexadecimal identity, and includes account, operator, plugin, target, selector, prepared calldata hash, asset identity, amount/output/native caps, slippage, leverage, time, nonce, and evidence bindings. `intentHash()` commits every parsed field. `economicIntentHash()` omits only evidenceHash and riskPacketHash to avoid circular risk-packet hashing. RiskPacket binds that economic hash; final approvals and simulation bind the full intent hash. Artifact hashing uses recursively sorted keys and Keccak-256.

```ts
const kernel = new Kernel({
  network,
  mandates: [verifiedMandate],
  balances: [{ account, asset, balance: chainBalance.toString() }],
  trustedEvidence: {
    riskPacketHashes: [artifactHash(independentRisk)],
    simulationHashes: [artifactHash(actualSimulation)],
  },
});
const decision = await kernel.authorize({
  intent,
  risk: independentRisk,
  simulation: actualSimulation,
  approvals,
  now,
});
if (decision.status === 'AUTHORIZED') {
  kernel.consume(decision.grant, intent, now);
}
```

`approvalTypedData(intent, unsignedApproval)` provides EIP-712 membership/intent-bound signing data. Kernel independently recovers each signer, requires an active member, rejects duplicate members/signers, and derives AUTO/REVIEW/CONSENSUS from policy. These intent approvals are distinct from the onchain execution module's grant signatures: the bounded signer must bridge only an actually issued, verified grant into that ABI.

Issuance reserves both the mandate budget and the shared account/asset treasury balance synchronously after approval verification, preventing async authorization races. Nonces are permanently locked at issuance, including expired grants. `consume(grant,intent,now)` marks authority used before broadcast. Persist `snapshot()` atomically with the execution journal before any signing/broadcast; recover using `Kernel.restore()`. Restoration validates types, duplicate entries, nonce linkage, and reservation/spending totals. Snapshots must be stored under trusted access control and integrity protection; schema validation cannot authenticate an attacker-replaced snapshot.

`releaseExpired(now)` releases only unconsumed grants. Consumed grants remain reserved until receipt-driven `reconcile(grantId,actualSpent)` validates a uint256 actual spend bounded by the grant. Reconciliation reduces the reservation and treasury balance and increments cumulative spend once. This module does not broadcast, fetch provider APIs, authenticate a production treasury snapshot, or judge chain finality. Those responsibilities remain with trusted execution/reconciliation services.

Local synthetic asset fixtures use `OTHER`, never official AUSD branding. Registry authority remains separate from schema validity: the configured mandate and balance asset must be independently resolved from the current chain registry.
