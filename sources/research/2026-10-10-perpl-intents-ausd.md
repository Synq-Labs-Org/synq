# Revalidation: Perpl, NEAR/Aurora Intents and AUSD (2026-10-10)
All checks were read-only against official docs, live public endpoints and `cast`.

## Perpl
Source: docs.perpl.xyz/resources/for-developers/networks-and-configuration. Live `GET /api/v1/pub/context` was checked on both networks.

### Networks

| Field | Mainnet (143) | Testnet (10143) |
|---|---|---|
| REST | https://app.perpl.xyz/api | https://testnet.perpl.xyz/api |
| WebSocket | wss://app.perpl.xyz (`/ws/v1/market-data`, `/ws/v1/trading`) | wss://testnet.perpl.xyz |
| Exchange (EIP-1967 proxy) | 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F | 0x1964C32f0bE608E7D29302AFF5E61268E72080cc |
| Collateral (6 decimals) | AUSD 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a | Agora testnet AUSD 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC |
| Minimum to open an account | 10 AUSD | 100 AUSD |
| Deploy block | 54773010 | 62953 |

- **Erratum:** the testnet collateral is Agora testnet AUSD (live context, on-chain symbol "AUSD"), not a separate "Perpl test USD". The Bible §24 and the run brief are outdated on this point. See finding P10-20261010T1500Z.
- Market ids differ per network and the docs are stale, so always load them from `/v1/pub/context`.

### API keys and authentication
- **Keys and scopes:** Ed25519 keys. `scope_mask` 1 = read, 2 = trade (implies read). Withdrawals and transfers out are never possible via an API key at any scope; they need a wallet signature on the Exchange contract.
- **REST signing:**
  - Canonical string: `chain_id \n METHOD \n request-target(/v1/... without /api, with query) \n timestamp_ms \n nonce(base64url, no padding) \n sha256hex(body)`.
  - Signature: `base64url_nopad(ed25519)`.
  - Headers: `X-API-Key`, `X-API-Timestamp`, `X-API-Nonce`, `X-API-Signature`.
  - Validity: timestamp within ±30 s; nonce single-use.
- **WebSocket sign-in:** first frame `{mt:29, chain_id, api_key, timestamp, nonce, signature}` signing `chain_id \n "trading-ws-signin" \n ts \n nonce`. Deadline 5 s on mainnet, 10 s on testnet. Close codes: 1008 (timeout/rate limit), 3401 (auth).
- **Enrollment:** `POST /v1/api-key/payload`, then `POST /v1/api-key/enroll` with a wallet EIP-712 signature and an Ed25519 proof-of-possession signature. The request **Origin must be whitelisted by Perpl**; the alternative is manual creation in the web UI at testnet.perpl.xyz/apikeys.

### Account setup and trading
- **Account:** approve, then `createAccount(amountCNS ≥ min)`, then `allowOrderForwarding(true)` from the owner wallet (there is no on-chain getter; read `fw` from the WebSocket or `/v1/trading/wallet`). Without forwarding, orders fail with `st:7`, `sr:34`.
- **Orders:**
  - Endpoints: `POST /v1/trading/orders` (`mt:30`, `d: OrderSpec[]`) or WebSocket `mt:22`.
  - Types: 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort, 5 Cancel, 6 IncreaseCollateral, 7 Change.
  - Fields: `rq` is strictly increasing (seeded from `account.lfr`); `lv` is leverage in hundredths; `lb` is the last block.
  - Status arrives on `mt:24`, with `st` from 1 to 10.
- **WebSocket streams:** heartbeat `sn` must increase by exactly 1; on a gap, reconnect. Backoff 1→60 s; ping (`mt:1`) every ~30 s.
- **Rate limits:** REST ~100/min public, ~60/min authenticated; WebSocket ~50 msg/s, ~5 connections per IP.
- **SDK:** there is no official TypeScript SDK; the official guide is raw API plus `@noble/ed25519`. The official SDK is Rust (`dex-sdk`).

## NEAR Intents (1Click) and Aurora Intents
- **1Click:**
  - Base URL https://1click.chaindefuser.com. Endpoints `/v0/tokens`, `/v0/quote`, `/v0/deposit/submit`, `/v0/status`. An optional partner JWT avoids a +0.25% fee.
  - Monad mainnet is supported for MON, USDC and USDT0. **AUSD is not supported on any chain.**
  - **No testnet** ("no plans").
- **Aurora Intents:** https://intents-api.aurora.dev with the API key in the path (Intents Studio). Endpoints `/api/tokens|quote|deposit/submit|status/{key}`. Rate limit 100 per 10 s and 2000 per hour. No testnet, and no AUSD.

## AUSD (Agora)
- **Addresses:** Monad mainnet 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; testnet 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC (faucet 0xd236…ee6C, `requestFunds(address)`). 6 decimals.
- **Implementation:** 0xc1e3C7D486d6A92fBE920232E439EeC2cEb112dA on both networks.
- **Pause and freeze:** `paused()` does not exist. Use `isTransferPaused()`, `isMintPaused()`, `isBurnFromPaused()`, `isBridgingPaused()`, `isFreezingPaused()` and `isAccountFrozen(address)`.
- **LayerZero OFT:**
  - Mainnet bridge 0x9CaB7Ede13dc56652E44D2404E969C212f22689b, endpoint 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B (EID 30390).
  - Peers: Ethereum 30101, Base 30184, Avalanche 30106, Katana 30375.
  - Testnet: Monad testnet EID 40442 (endpoint 0x3aCAAf60502791D199a5a5F0B173D78229eBFe32), but there is **no AUSD OFT on Monad testnet and no testnet peers**.
- **Agora API:** https://api.agora.finance. `POST /v0/auth/token` exchanges an API key for a 15-minute JWT. Production only; the public metrics endpoints need no auth.
