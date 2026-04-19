/**
 * Bridge operator daemon.
 *
 * Listens on both ConfidentialBridge deployments (Eth-Sepolia + Arb-Sepolia
 * by default) for `BridgeOut` events and relays them to the peer:
 *
 *   1. Unseal the encrypted debit handle via cofhejs (operator has decrypt ACL)
 *   2. Call `ackOutbound(id, plain)` on the source — credits source reserve
 *   3. Call `bridgeIn(id, recipient, plain)` on the destination — credits recipient
 *
 * Both directions run concurrently. Dedup is best-effort in-memory; the
 * destination's `inboundSettled[id]` flag is the on-chain authority and
 * makes restarts safe (re-broadcast of an already-settled id reverts).
 *
 * Pre-flight (per chain, once):
 *   pnpm hardhat deploy-stack --peer-chain-id 421614  --network eth-sepolia
 *   pnpm hardhat deploy-stack --peer-chain-id 11155111 --network arb-sepolia
 *
 * Then:
 *   pnpm operator
 *
 * Optional env:
 *   OPERATOR_LOOKBACK_BLOCKS  (default 5000) — backfill window on startup
 *   OPERATOR_POLL_MS          (default 12000) — poll interval
 *   BRIDGE_LEFT, BRIDGE_RIGHT — names (default 'eth-sepolia', 'arb-sepolia')
 */
import hre from 'hardhat'
import { cofhejs, FheTypes } from 'cofhejs/node'
import { ethers, Wallet } from 'ethers'
import { initCofhe, tryUnseal } from './lib/cofhe'
import { loadStack, type Stack } from './lib/deployments'

type ChainCtx = {
	name: string
	provider: ethers.JsonRpcProvider
	operator: Wallet
	stack: Stack
	bridgeRead: ethers.Contract // unsigned reads
	bridgeWrite: ethers.Contract // operator-signed writes
}

const POLL_MS = Number(process.env.OPERATOR_POLL_MS ?? 12000)
const LOOKBACK = Number(process.env.OPERATOR_LOOKBACK_BLOCKS ?? 5000)

function rpcFor(name: string): string {
	switch (name) {
		case 'eth-sepolia':
			return process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com'
		case 'arb-sepolia':
			return process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
		case 'base-sepolia':
			return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
		default:
			throw new Error(`No default RPC for ${name}`)
	}
}

async function loadCtx(name: string, bridgeAbi: any): Promise<ChainCtx> {
	const stack = loadStack(name)
	const provider = new ethers.JsonRpcProvider(rpcFor(name))
	const operatorKey = process.env.OBSERVER_PRIVATE_KEY
	if (!operatorKey) throw new Error('OBSERVER_PRIVATE_KEY required')
	const operator = new Wallet(operatorKey, provider)
	const bridgeRead = new ethers.Contract(stack.bridge, bridgeAbi, provider)
	const bridgeWrite = new ethers.Contract(stack.bridge, bridgeAbi, operator)
	return { name, provider, operator, stack, bridgeRead, bridgeWrite }
}

// Track in-memory which outbound ids we've already submitted on each route,
// so we don't re-spend gas on `bridgeIn` calls the contract would revert.
type RouteKey = string // `${srcName}→${dstName}`
const inflight = new Set<RouteKey>()
const seen = new Map<RouteKey, Set<string>>() // route → set of `${outboundId}`

const seenKey = (route: RouteKey, id: bigint) => `${route}:${id.toString()}`

async function relay(
	src: ChainCtx,
	dst: ChainCtx,
	outboundId: bigint,
	encHandle: bigint,
	recipient: string
) {
	const route: RouteKey = `${src.name}→${dst.name}`
	const key = seenKey(route, outboundId)
	if (seen.get(route)?.has(key)) return
	if (inflight.has(key)) return
	inflight.add(key)

	try {
		// On-chain authority for "already done": peer's inboundSettled flag.
		const already: boolean = await dst.bridgeRead.inboundSettled(outboundId)
		if (already) {
			console.log(`[${route}] outbound#${outboundId} already settled on ${dst.name} — skipping`)
			seen.get(route)!.add(key)
			return
		}

		// Unseal via cofhejs initialised for the SOURCE chain (operator has the
		// ACL there). Re-init switches the global cofhejs state — both relay
		// directions go through the same singleton, which is why `relay` is
		// awaited end-to-end inside the caller's poll loop.
		await initCofhe(src.operator)
		const plain = await tryUnseal<bigint>(encHandle, FheTypes.Uint64)
		if (plain === null) {
			console.warn(`[${route}] outbound#${outboundId} unseal pending; retrying next poll`)
			return
		}

		// Ack on source if not yet acked. Optional but keeps source reserve
		// accounting honest for return-direction `bridgeIn` calls.
		const outbound = await src.bridgeRead.outbound(outboundId)
		if (!outbound.operatorAcked) {
			const ackTx = await src.bridgeWrite.ackOutbound(outboundId, plain)
			await ackTx.wait()
			console.log(`[${route}] acked outbound#${outboundId} on ${src.name}`)
		}

		// Deliver on destination.
		const inTx = await dst.bridgeWrite.bridgeIn(outboundId, recipient, plain)
		await inTx.wait()
		console.log(
			`[${route}] delivered outbound#${outboundId} → ${recipient} (${Number(plain) / 1e6} USDC) tx=${inTx.hash}`
		)

		seen.get(route)!.add(key)
	} catch (err: any) {
		const msg = err?.shortMessage || err?.message || String(err)
		// Treat "already settled" reverts as success — race between two relay
		// loops is fine, contract guarantees idempotency.
		if (/already settled/.test(msg)) {
			console.log(`[${route}] outbound#${outboundId} settled by another path — ok`)
			seen.get(route)!.add(key)
		} else {
			console.error(`[${route}] outbound#${outboundId} relay failed: ${msg}`)
		}
	} finally {
		inflight.delete(key)
	}
}

async function pollOnce(
	src: ChainCtx,
	dst: ChainCtx,
	cursor: { last: number }
): Promise<void> {
	const route = `${src.name}→${dst.name}`
	if (!seen.has(route)) seen.set(route, new Set())

	const head = await src.provider.getBlockNumber()
	if (head <= cursor.last) return

	const from = cursor.last + 1
	const to = head
	const filter = src.bridgeRead.filters.BridgeOut()
	let events: any[] = []
	try {
		events = await src.bridgeRead.queryFilter(filter, from, to)
	} catch (err: any) {
		console.error(`[${route}] queryFilter ${from}-${to} failed: ${err?.message ?? err}`)
		return
	}

	for (const ev of events) {
		await relay(src, dst, ev.args.outboundId, ev.args.encAmountHandle, ev.args.destRecipient)
	}
	cursor.last = to
}

async function main() {
	const leftName = process.env.BRIDGE_LEFT ?? 'eth-sepolia'
	const rightName = process.env.BRIDGE_RIGHT ?? 'arb-sepolia'
	if (leftName === rightName) throw new Error('BRIDGE_LEFT == BRIDGE_RIGHT')

	const bridgeAbi = (await hre.artifacts.readArtifact('ConfidentialBridge')).abi
	const left = await loadCtx(leftName, bridgeAbi)
	const right = await loadCtx(rightName, bridgeAbi)

	console.log('╔══════════════════════════════════════════╗')
	console.log('║   ConfidentialBridge — Operator          ║')
	console.log('╚══════════════════════════════════════════╝')
	console.log(`left  : ${left.name}  bridge=${left.stack.bridge}`)
	console.log(`right : ${right.name} bridge=${right.stack.bridge}`)
	console.log(`operator (both sides): ${left.operator.address}`)
	console.log(`poll interval        : ${POLL_MS}ms`)
	console.log(`backfill window      : ${LOOKBACK} blocks`)
	console.log()

	const leftHead = await left.provider.getBlockNumber()
	const rightHead = await right.provider.getBlockNumber()
	const cursorLR = { last: Math.max(0, leftHead - LOOKBACK) }
	const cursorRL = { last: Math.max(0, rightHead - LOOKBACK) }

	const tick = async () => {
		// Strictly sequential: cofhejs is a singleton and `relay` re-inits it
		// for the source chain. Running both directions concurrently would
		// race the global state.
		try {
			await pollOnce(left, right, cursorLR)
		} catch (err) {
			console.error(`[${left.name}→${right.name}] tick error:`, err)
		}
		try {
			await pollOnce(right, left, cursorRL)
		} catch (err) {
			console.error(`[${right.name}→${left.name}] tick error:`, err)
		}
	}

	// Backfill once, then loop.
	await tick()
	console.log(`backfill complete; entering poll loop`)
	while (true) {
		await new Promise(r => setTimeout(r, POLL_MS))
		await tick()
	}
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
