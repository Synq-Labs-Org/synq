# Revalidation: Kuru and Chainlink CRE on Monad (2026-10-10)
All checks were read-only. Monad mainnet RPC is https://rpc.monad.xyz (chain 143); testnet RPC is https://testnet-rpc.monad.xyz (chain 10143). Source: docs.monad.xyz network-information.

## Kuru

### Packaged trading skill
- **Source:** GitHub `Kuru-Labs/kuru-trading-skills`, commit 6075030b (2026-06-01). Not on npm. Bun/TS, viem plus zod3.
- **Semantics:** BUY is USDC→token and SELL is token→USDC, with `SETTLEMENT_SYMBOL = "USDC"`.
- **Allowlist (mainnet):**

  | Token | Address | Decimals |
  |---|---|---|
  | USDC | 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 | 6 |
  | WMON | 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A | 18 |
  | AUSD | 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a | 6 |

- **Mainnet only:** chain 143 is hardcoded.
- **Key requirements:** `prepare buy|sell --from` is key-free and returns an unsigned approve (spender 0xb3e6…13cb) followed by the swap. The CLI `quote` command demands a private key, so don't use it.

### Kuru Flow (aggregator)
- **API:** `https://ws.kuru.io`. `POST /api/generate-token {user_address}` returns a JWT (~24h, 1 rps), then `POST /api/quote` with the Bearer token.
- **Request:** `{userAddress, tokenIn, tokenOut, amount(raw), slippageTolerance bps | autoSlippage, referrer*}`. Native MON is 0x0.
- **Live response shape** (differs from the OpenAPI spec): `{type:"calculate_swap_result", status, output, minOut, transaction:{calldata (no 0x), value, to:0xb3e6778480b2E488385E8205eA05E20060B813cb}, gasPrices}`.
- **Observed:** AUSD→WMON quoted live, 1 AUSD ≈ 40.448 WMON.
- **Testnet:** quote fails ("no candidate paths"), so Flow is mainnet only.
- **Spender/target:** KuruFlowEntrypoint 0xb3e6778480b2E488385E8205eA05E20060B813cb. KuruFlowRouter 0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2 is listed but its purpose is undocumented.

### Kuru CLOB
- **SDK:** npm `@kuru-labs/kuru-sdk@0.0.95` (ethers v5). Do not use `@toxicflow-labs/ts-sdk`.
- **Mainnet addresses** (docs.kuru.io/contracts/Contract-addresses):
  - Router 0xd651346d7c789536ebf06dc72aE3C8502cd695CC
  - MarginAccount 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5
  - Forwarder 0x974E61BBa9C4704E8Bcc1923fdC3527B41323FAA
  - Markets: MON-AUSD 0x131a2e70a5b31a517a74b8c567149bc294470da9, MON-USDC 0x065C9d28E428A0db40191a54d33d5b7c71a9C394
- **Testnet addresses:**
  - Router 0x7EFbE105Ca7415dE98F96622173458ac1c054630
  - MarginAccount 0xd029C2D98ff85D8F64799017fE00a59B1159CE02
  - Forwarder 0x681bB1508E14433b148a2549ba2726454aDc9BB4
  - USDC 0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570
  - Only market is MON-USDC 0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9. There is no AUSD market on testnet.
  - The Quick Start addresses have no code; do not use them.
- **Live markets:** `GET https://exchange.kuru.io/api/v3/exchangeInfo` lists AUSD_USDC, MON_AUSD, MON_USDC, WBTC_AUSD, XAUT_USDC, WETH_USDC, cbBTC_USDC. MON_AUSD uses native MON as base; there is no WMON/AUSD market.
- **Market parameters** (on-chain `getMarketParams`): pricePrecision 1e8, sizePrecision 1e10, tickSize 100 (exchangeInfo says 1; trust on-chain), minSize 2e12, fees 0/0.
- **MON-AUSD anomaly:** on-chain `bestBidAsk` returned the sentinel (2^256-1, 0). Recheck liquidity before relying on it.
- **Interfaces:**
  - Market orders: `placeAndExecuteMarketBuy/Sell(uint96, uint96 minOut, bool isMargin, bool isFOK)`.
  - Multi-hop: Router `anyToAnySwap`.
  - WebSocket: `wss://exchange.kuru.io/ws` (e.g. `mon_ausd@depth5`).

## Chainlink CRE

### Supported networks
Source: docs.chain.link/cre/supported-networks-ts (2026-09-18).
- Monad mainnet: CLI ≥1.29, TS SDK ≥1.18. Supports simulation and production onchain writes.
- Monad testnet: CLI ≥1.30, TS SDK ≥1.19. Supports local simulation. Production on testnet is unverified (tenant-gated).

### Forwarders

| Network | Simulation (mock) | Production |
|---|---|---|
| monad-mainnet | 0x9eF6468C5f37b976E57d52054c693269479A784d | 0x76c9cf548b4179F8901cda1f8623568b58215E62 |
| monad-testnet | 0xB9F79d863261869B234c481D1f9A7af84AeAd192 | 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 |

All four have code on-chain.

### Selectors and versions
- Chain selectors: monad-mainnet 8481857512324358265; monad-testnet 2183018362218727504.
- `@chainlink/cre-sdk` latest is 1.23.0; CLI latest is 1.38.0 (1.32.0 installed).

### Simulation
- **Requires `cre login`.** Verified locally: the stale credential returns 403.
- Simulation makes real RPC and HTTP calls.
- Writes are a dry run unless `--broadcast` is passed, which sends via the mock forwarder using `CRE_ETH_PRIVATE_KEY`.

### Consumer contracts
- Implement `IReceiver.onReport(bytes metadata, bytes report)` (or ReceiverTemplate) and validate the forwarder.
- Production metadata is 64 bytes.

## Chainlink feeds (Monad mainnet; verified with latestRoundData)

| Feed | Proxy | Decimals | Heartbeat / deviation |
|---|---|---|---|
| AUSD/USD | 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13 | 8 | 3600s / 0.05% |
| USDC/USD | 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec | 8 | — |
| MON/USD | 0xBcD78f76005B7515837af6b50c7C52BCf73822fb | 8 | — |

- AUSD/USD read 0.99983 at the time of the check.
- Testnet has no AUSD feed. A hidden USDC/USD feed exists at 0x39820e7965e29DC86b94F20eD04e9c5cCf9aFf95 (8 decimals, 86400s heartbeat).
