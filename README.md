# ConfidentialBridge

A trusted-operator v1 bridge for confidential ERC-20 tokens, built on Fhenix CoFHE. Encrypted balances on the source chain, encrypted balances on the destination — the operator sees plaintext only at the crossing point, the same trust shape as the underlying `ConfidentialERC20.unwrapper`.

Symmetric per-chain: deploy one instance on each side pointing at its peer. `bridgeOut` pulls the user's encrypted allowance into a per-chain reserve and grants the operator decrypt ACL on the debit handle. `bridgeIn` accepts a plaintext from the operator and credits the recipient from pre-seeded reserves on the destination side. A plaintext reserve counter (`plainReserve`) gates `bridgeIn` so an empty reserve fails loudly instead of silently transferring zero.

V2 swaps the trusted operator for a verified messaging layer (CCTP / LayerZero / Hyperlane), adds timeout-based source refunds, and batches deliveries for public-amount privacy. None of those require contract changes to the encrypted-state machinery here.

## Layout

```
packages/contracts/
  contracts/
    ConfidentialBridge.sol      # the bridge
    ConfidentialERC20.sol       # 7984-style confidential wrapper (the cToken)
    MockUSDC.sol                # 6-decimal test USDC
  test/
    ConfidentialBridge.test.ts  # 24 mocha tests vs cofhe-hardhat-plugin mocks
  scripts/
    e2e-bridge.ts               # single-chain Base Sepolia e2e (two bridges)
    e2e-bridge-twochain.ts      # two-chain Eth-Sepolia ↔ Arb-Sepolia e2e
    operator.ts                 # long-running relay daemon (both directions)
    lib/                        # shared cofhejs + deployments helpers
  tasks/
    deploy-usdc.ts              # MockUSDC only
    deploy-bridge.ts            # ConfidentialBridge only
    deploy-stack.ts             # MockUSDC + cUSDC + bridge in one shot
```

## Quickstart

```bash
pnpm install
pnpm compile
pnpm test                       # 24 tests, runs against hardhat mocks
```

## Live testnet flow (single-chain on Base Sepolia)

```bash
# 1. set .env
#    PRIVATE_KEY=<buyer>
#    OBSERVER_PRIVATE_KEY=<operator>
#    USDC_ADDRESS=0xE29D70400026d77a790a8E483168B94D6E36424F   # MockUSDC

pnpm e2e:bridge
```

Deploys fresh contracts on Base Sepolia, runs a full bridgeOut → operator-unseal → ackOutbound → bridgeIn → verify cycle. Two bridges on the same chain stand in for source/destination — proves the contract logic without a peer.

## Two-chain deployment (Eth Sepolia ↔ Arb Sepolia)

### 1. Set RPC + keys in `.env`

```bash
PRIVATE_KEY=<buyer>
OBSERVER_PRIVATE_KEY=<operator>
SEPOLIA_RPC_URL=...
ARBITRUM_SEPOLIA_RPC_URL=...
```

### 2. Deploy the stack on each chain (one shot per chain)

```bash
pnpm hardhat deploy-stack --peer-chain-id 421614  --network eth-sepolia
pnpm hardhat deploy-stack --peer-chain-id 11155111 --network arb-sepolia
```

This deploys MockUSDC + ConfidentialERC20 + ConfidentialBridge per chain and writes the addresses to `packages/contracts/deployments/<network>.json`. Re-running reuses the prior MockUSDC/cUSDC and only redeploys the bridge.

### 3. Run the two-chain e2e (proves the relay works)

```bash
pnpm e2e:bridge-twochain                              # eth → arb (default)
BRIDGE_FROM=arb-sepolia BRIDGE_TO=eth-sepolia \
  pnpm e2e:bridge-twochain                            # arb → eth
```

The script handles wrapping, seeding, approving, bridging out, unsealing, acking, and delivering across both chains — the full operator flow inlined for one outbound.

### 4. Run the operator daemon (long-running, both directions)

```bash
pnpm operator
```

Polls both bridges for `BridgeOut` events (12s interval by default) and relays each to the peer. Backfills 5000 blocks on startup so a freshly-started operator catches up. In-memory dedup is best-effort — the on-chain `inboundSettled` flag is the authority, so restarts are safe.

Tunable env: `OPERATOR_POLL_MS`, `OPERATOR_LOOKBACK_BLOCKS`, `BRIDGE_LEFT`, `BRIDGE_RIGHT`.

## Operator trust model

The operator EOA is the message layer. They're trusted to:

- Unseal `BridgeOut` debit handles honestly (they have decrypt ACL via `FHE.allow(moved, operator)`)
- Submit the same plaintext to the peer's `bridgeIn`
- Maintain the destination reserve (`seedLiquidity`, `drainReserve` for rebalancing)

Same trust shape as `ConfidentialERC20.unwrapper` — there's already a trusted unsealer in the stack. V2 replaces this role with messaging-layer verification.

## Safety notes

- **`bridgeIn` is reserve-gated.** `plainReserve` tracks the destination's plaintext-known reserve (grows on `seedLiquidity` + `ackOutbound`, shrinks on `bridgeIn`/`drainReserve`). A delivery that exceeds the reserve reverts loudly — without this gate, the underlying cToken's clamp-on-insufficient semantics would silently credit zero while flipping the replay flag.
- **`bridgeOut` uses `transferFromAllowance`, not `transferFrom`.** The user pre-approves the bridge with an encrypted allowance; the bridge consumes it. This avoids the zkv-signature-binding issue where an `InEuint64` signed for the user's `msg.sender` would re-verify under the bridge's `msg.sender` inside `cToken.transferFrom` and fail.
- **`bridgeIn` plaintext is trivially-encrypted on chain.** The amount is already known to the operator; trivial encryption + transient ACL on cToken is the cheapest path to a credit.

Powered by [Fhenix CoFHE](https://fhenix.io).
