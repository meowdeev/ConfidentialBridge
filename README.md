<p align="center">
  <img src="fhenix-logo.svg" alt="Fhenix" width="220" />
</p>

# ConfidentialBridge

A trusted-operator bridge for confidential ERC-20 tokens, built on [Fhenix CoFHE](https://fhenix.io). **Amounts stay encrypted on both chains** — every event emits opaque handles, reserve state is an `euint64` only the operator can read, and no plaintext amount appears in calldata for the hot path. The operator sees plaintext only at the crossing point (same trust shape as `ConfidentialERC20.unwrapper`).

Symmetric per-chain: deploy one instance on each side pointing at its peer. `bridgeOut` pulls the user's encrypted allowance into the bridge and grants the operator decrypt ACL on the debit handle. `ackOutbound` folds that handle homomorphically into an encrypted reserve counter — no plaintext crosses. `bridgeIn` takes an `InEuint64` (re-encrypted by the operator after unsealing on the source side), silent-clamps against the encrypted reserve, and credits the recipient with an encrypted transfer.

## Verified deployments

### Eth Sepolia (chainId 11155111)

| Contract | Address |
| --- | --- |
| MockUSDC | [`0xe927D1AE8ED42B108Cb669FF97aE4f1b2a9DFB44`](https://sepolia.etherscan.io/address/0xe927D1AE8ED42B108Cb669FF97aE4f1b2a9DFB44#code) |
| ConfidentialERC20 (cUSDC) | [`0x1CcC1d7d1548EaD47103BDA7A3cCf19C5A39f7b5`](https://sepolia.etherscan.io/address/0x1CcC1d7d1548EaD47103BDA7A3cCf19C5A39f7b5#code) |
| ConfidentialBridge | [`0xF7EE9a307f0b1C72517CE41c7654C5f4Ce8749f4`](https://sepolia.etherscan.io/address/0xF7EE9a307f0b1C72517CE41c7654C5f4Ce8749f4#code) |

### Arb Sepolia (chainId 421614)

| Contract | Address |
| --- | --- |
| MockUSDC | [`0xdBc84D2D80A49cf9FB9201e766b2525C567DBEfc`](https://sepolia.arbiscan.io/address/0xdBc84D2D80A49cf9FB9201e766b2525C567DBEfc#code) |
| ConfidentialERC20 (cUSDC) | [`0x369b18B3101e9C2a1Dc6A84f4720760eCfA7CaD1`](https://sepolia.arbiscan.io/address/0x369b18B3101e9C2a1Dc6A84f4720760eCfA7CaD1#code) |
| ConfidentialBridge | [`0x2196a8cde66049A2E26B7Af40E79F0d19182BCC1`](https://sepolia.arbiscan.io/address/0x2196a8cde66049A2E26B7Af40E79F0d19182BCC1#code) |

## What's encrypted on-chain

| Surface | What third-party observers see | What the operator sees |
| --- | --- | --- |
| `bridgeOut` event | sender, recipient, outbound id, opaque `euint64` handle | plaintext amount via `cofhejs.unseal` |
| `ackOutbound` event | outbound id only | — |
| `bridgeIn` event | recipient, peer outbound id, opaque `euint64` handle | plaintext amount via unseal |
| `encReserve` state | `euint64` handle (opaque) | plaintext reserve (ACL'd) |
| `seedLiquidity` / `drainReserve` | plaintext amount (admin op) | plaintext amount |

The only plaintext in the hot-path calldata/events is the outbound id. Admin ops (`seed`, `drain`) stay plaintext because their underlying-ERC20 legs are observable anyway.

## Bridge flow (hot path)

```
 SRC chain                                     DST chain
 ─────────                                     ─────────
 user ── cToken.approve(bridge, encAmount) ──►
 user ── bridge.bridgeOut(recipient) ────────► (emits BridgeOut)
                                                │
                                    operator.unseal(handle)
                                                │
 operator ── bridge.ackOutbound(id) ──────────►  (no plaintext)
                                                │
                                    operator.encrypt(plain)
                                                                                               │
                                               operator ── bridge.bridgeIn(id, recipient, encIn)
                                                                                               │
                                               (emits BridgeIn with encrypted handle)
                                                                                               │
                                               recipient holds encrypted cToken balance
```

## Layout

```
packages/contracts/
  contracts/
    ConfidentialBridge.sol      # the bridge (v2: encrypted reserve + amounts)
    ConfidentialERC20.sol       # 7984-style confidential wrapper (the cToken)
    MockUSDC.sol                # 6-decimal test USDC
  test/
    ConfidentialBridge.test.ts  # 25 mocha tests vs cofhe-hardhat-plugin mocks
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

The fastest path is the Makefile — one command runs install → env scaffold → compile → tests → deploys to both testnets → live two-chain bridge transfer:

```bash
make all
```

First run will create `packages/contracts/.env` from the example, print the keys you need to fill in, and exit. Edit `.env`, then re-run `make all`.

`make help` lists all targets. Common ones:

```
make install     # pnpm install
make test        # 25 tests vs hardhat mocks
make deploy      # deploy-stack on both eth-sepolia + arb-sepolia
make e2e         # one bridge transfer eth → arb
make operator    # long-running relay daemon (both directions)
```

Or call pnpm scripts directly:

```bash
pnpm install
pnpm compile
pnpm test                       # 25 tests, runs against hardhat mocks
```

## Live testnet flow (single-chain on Base Sepolia)

```bash
# 1. set .env
#    PRIVATE_KEY=<buyer>
#    OBSERVER_PRIVATE_KEY=<operator>
#    USDC_ADDRESS=<MockUSDC>

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
ETHERSCAN_API_KEY=...            # optional, for `hardhat verify`
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

The script handles wrapping, seeding, approving, bridging out, unsealing (operator), re-encrypting, and delivering across both chains — the full operator flow inlined for one outbound.

### 4. Run the operator daemon (long-running, both directions)

```bash
pnpm operator
```

Polls both bridges for `BridgeOut` events (12s interval by default) and relays each to the peer. Backfills 5000 blocks on startup so a freshly-started operator catches up. In-memory dedup is best-effort — the on-chain `inboundSettled` flag is the authority, so restarts are safe.

Tunable env: `OPERATOR_POLL_MS`, `OPERATOR_LOOKBACK_BLOCKS`, `BRIDGE_LEFT`, `BRIDGE_RIGHT`.

### 5. Verify contracts on Etherscan (optional)

```bash
ETHERSCAN_API_KEY=<key> pnpm hardhat verify --network eth-sepolia \
  <bridge-addr> <cToken-addr> <operator-addr> 421614
```

One Etherscan V2 key works across eth-sepolia, arb-sepolia, and base-sepolia.

## Operator trust model

The operator EOA is the message layer. They're trusted to:

- Unseal `BridgeOut` debit handles honestly (they have decrypt ACL via `FHE.allow(moved, operator)`)
- Re-encrypt the plaintext as an `InEuint64` bound to the operator wallet and submit it to the peer's `bridgeIn`
- Maintain the destination reserve (`seedLiquidity` to provision, `drainReserve` to rebalance)

Same trust shape as `ConfidentialERC20.unwrapper` — there's already a trusted unsealer in the stack.

## Safety notes

- **`bridgeIn` silent-clamps against the encrypted reserve.** Reverting on "reserve short" would leak the reserve value (a failed tx at amount=X proves `encReserve < X`). Instead, an over-ask credits zero and still consumes the replay slot. The operator is expected to unseal `encReserve` off-chain before submitting — their ACL covers it.
- **`drainReserve` silent-clamps too.** Plaintext amount in calldata is fine (admin op), but over-drain credits zero rather than reverting. Same reason.
- **`bridgeOut` uses `transferFromAllowance`, not `transferFrom`.** The user pre-approves the bridge with an encrypted allowance; the bridge consumes it. This avoids the zkv-signature-binding issue where an `InEuint64` signed for the user's `msg.sender` would re-verify under the bridge's `msg.sender` inside `cToken.transferFrom` and fail.
- **`bridgeIn` re-encrypts on the operator side.** The operator runs `cofhejs.encrypt(plain)` against the destination chain, signed for their wallet, then submits. The contract reconstitutes it via `FHE.asEuint64(InEuint64)` and grants transient ACL to the cToken for the transfer.

## Roadmap

V3 swaps the trusted operator for a verified messaging layer (CCTP / LayerZero / Hyperlane), adds timeout-based source refunds, and batches deliveries for flow-amount privacy on top of value-amount privacy. None of those require changes to the encrypted-state machinery here.

---

Powered by [Fhenix CoFHE](https://fhenix.io).
