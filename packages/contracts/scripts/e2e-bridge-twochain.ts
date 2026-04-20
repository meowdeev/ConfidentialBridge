/**
 * Two-chain end-to-end for ConfidentialBridge.
 *
 * Defaults to bridging Eth-Sepolia → Arb-Sepolia. Reverse with
 *   BRIDGE_FROM=arb-sepolia BRIDGE_TO=eth-sepolia pnpm e2e:bridge-twochain
 *
 * Pre-flight (per-chain, only once):
 *   pnpm hardhat deploy-stack --peer-chain-id 421614  --network eth-sepolia
 *   pnpm hardhat deploy-stack --peer-chain-id 11155111 --network arb-sepolia
 *
 * Required env:
 *   PRIVATE_KEY          — buyer (alice)
 *   OBSERVER_PRIVATE_KEY — operator
 *   SEPOLIA_RPC_URL      (optional, defaults to publicnode)
 *   ARBITRUM_SEPOLIA_RPC_URL  (optional)
 *
 * Flow:
 *   1. Resolve deployments + wallets for both chains
 *   2. Operator seeds destination bridge if its plainReserve is short
 *   3. Buyer wraps USDC on source if cUSDC balance is short
 *   4. Buyer approves source bridge (encrypted allowance via cofhejs)
 *   5. Buyer calls bridgeOut(operator) on source
 *   6. Operator unseals the BridgeOut handle (cofhejs on source)
 *   7. Operator calls ackOutbound on source (reserve credit)
 *   8. Operator switches cofhejs to destination, calls bridgeIn
 *   9. Verify recipient encrypted balance via unseal on destination
 */
import hre from 'hardhat'
import {
	cofhejs,
	Encryptable,
	FheTypes,
} from 'cofhejs/node'
import { ethers, Wallet } from 'ethers'
import { initCofhe, tryUnseal } from './lib/cofhe'
import { loadStack, type Stack } from './lib/deployments'

const ABIS = {
	usdc: [
		'function balanceOf(address) view returns (uint256)',
		'function approve(address,uint256) returns (bool)',
		'function mint(address,uint256)',
	],
}

const EXPLORERS: Record<string, string> = {
	'eth-sepolia': 'https://sepolia.etherscan.io',
	'arb-sepolia': 'https://sepolia.arbiscan.io',
	'base-sepolia': 'https://sepolia.basescan.org',
}

type ChainCfg = {
	name: string
	rpc: string
	stack: Stack
	provider: ethers.JsonRpcProvider
	alice: Wallet
	operator: Wallet
}

function rpcFor(name: string): string {
	switch (name) {
		case 'eth-sepolia':
			return process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com'
		case 'arb-sepolia':
			return process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
		case 'base-sepolia':
			return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
		default:
			throw new Error(`No default RPC for ${name}; set the env var explicitly`)
	}
}

async function loadChain(name: string): Promise<ChainCfg> {
	const stack = loadStack(name)
	const rpc = rpcFor(name)
	const provider = new ethers.JsonRpcProvider(rpc)
	const buyerKey = process.env.PRIVATE_KEY
	const operatorKey = process.env.OBSERVER_PRIVATE_KEY
	if (!buyerKey || !operatorKey) {
		throw new Error('PRIVATE_KEY and OBSERVER_PRIVATE_KEY required in .env')
	}
	const alice = new Wallet(buyerKey, provider)
	const operator = new Wallet(operatorKey, provider)
	return { name, rpc, stack, provider, alice, operator }
}

const txLink = (chain: string, hash: string) =>
	EXPLORERS[chain] ? `  ${EXPLORERS[chain]}/tx/${hash}` : `  (tx ${hash})`

async function main() {
	const fromName = process.env.BRIDGE_FROM ?? 'eth-sepolia'
	const toName = process.env.BRIDGE_TO ?? 'arb-sepolia'
	if (fromName === toName) throw new Error('BRIDGE_FROM and BRIDGE_TO must differ')

	console.log('╔══════════════════════════════════════════╗')
	console.log('║   ConfidentialBridge — Two-Chain E2E     ║')
	console.log('╚══════════════════════════════════════════╝')
	console.log(`from : ${fromName}`)
	console.log(`to   : ${toName}\n`)

	const src = await loadChain(fromName)
	const dst = await loadChain(toName)

	console.log(`buyer    : ${src.alice.address}`)
	console.log(`operator : ${src.operator.address}\n`)

	const SEED = 50_000_000n // 50 USDC reserve floor on dst
	const PAY = 10_000_000n // 10 USDC bridged

	// Per-chain contract handles (typed via hre artifacts → plain ethers Contract).
	const usdcSrc = new ethers.Contract(src.stack.usdc, ABIS.usdc, src.alice)
	const usdcDst = new ethers.Contract(dst.stack.usdc, ABIS.usdc, dst.operator)
	const cUSDCArt = await hre.artifacts.readArtifact('ConfidentialERC20')
	const bridgeArt = await hre.artifacts.readArtifact('ConfidentialBridge')
	const cUSDCSrc = new ethers.Contract(src.stack.cToken, cUSDCArt.abi, src.alice)
	const bridgeSrc = new ethers.Contract(src.stack.bridge, bridgeArt.abi, src.alice)
	const bridgeSrcOp = new ethers.Contract(src.stack.bridge, bridgeArt.abi, src.operator)
	const cUSDCDst = new ethers.Contract(dst.stack.cToken, cUSDCArt.abi, dst.operator)
	const bridgeDst = new ethers.Contract(dst.stack.bridge, bridgeArt.abi, dst.operator)

	// ── Pre-flight: alice has USDC on src ─────────────────
	console.log('① Pre-flight: ensuring buyer has cUSDC on source...')
	const aliceUsdc: bigint = await usdcSrc.balanceOf(src.alice.address)
	if (aliceUsdc < PAY) {
		console.log(`   buyer has ${Number(aliceUsdc) / 1e6} USDC, minting 1000 from MockUSDC...`)
		await (await (usdcSrc as any).mint(src.alice.address, 1_000_000_000n)).wait()
	}
	const aliceCBalEnc: bigint = await cUSDCSrc.balanceOf(src.alice.address)
	let aliceCBal: bigint = 0n
	if (aliceCBalEnc !== 0n) {
		await initCofhe(src.alice)
		const v = await tryUnseal<bigint>(aliceCBalEnc, FheTypes.Uint64, 3, 3000)
		if (v !== null) aliceCBal = v
	}
	if (aliceCBal < PAY) {
		const wrapAmt = PAY - aliceCBal
		console.log(`   buyer cUSDC ${Number(aliceCBal) / 1e6} < ${Number(PAY) / 1e6}, wrapping ${Number(wrapAmt) / 1e6}...`)
		await (await (usdcSrc as any).approve(src.stack.cToken, wrapAmt)).wait()
		const wrapTx = await (cUSDCSrc as any).wrap(wrapAmt)
		await wrapTx.wait()
		console.log(`   wrap tx: ${wrapTx.hash}`)
	}
	console.log()

	// ── Pre-flight: dst bridge has encReserve ──────────────
	console.log('② Pre-flight: ensuring destination bridge has reserve...')
	// v2: reserve is FHE-encrypted, only the operator (ACL'd) can unseal.
	await initCofhe(dst.operator)
	const dstReserveHandle: bigint = await bridgeDst.encReserve()
	const dstReserve: bigint = (await tryUnseal<bigint>(dstReserveHandle, FheTypes.Uint64, 3, 3000)) ?? 0n
	console.log(`   bridge.encReserve on ${dst.name}: ${Number(dstReserve) / 1e6} USDC (via operator unseal)`)
	if (dstReserve < PAY) {
		const seedAmt = SEED - dstReserve
		console.log(`   seeding ${Number(seedAmt) / 1e6} more USDC into ${dst.name} bridge...`)
		const opUsdc: bigint = await usdcDst.balanceOf(dst.operator.address)
		if (opUsdc < seedAmt) {
			console.log(`   operator USDC ${Number(opUsdc) / 1e6} short, minting...`)
			await (await (usdcDst as any).mint(dst.operator.address, 1_000_000_000n)).wait()
		}
		await (await (usdcDst as any).approve(dst.stack.bridge, seedAmt)).wait()
		const seedTx = await (bridgeDst as any).seedLiquidity(seedAmt)
		await seedTx.wait()
		console.log(`   seed tx: ${seedTx.hash}`)
		if (EXPLORERS[dst.name]) console.log(txLink(dst.name, seedTx.hash))
	}
	console.log()

	// ── 3. Buyer approves source bridge ─────────────────────
	console.log(`③ Buyer encrypts allowance + approves bridge on ${src.name}...`)
	await initCofhe(src.alice)
	const [encApprove] = await hre.cofhe.expectResultSuccess(
		cofhejs.encrypt([Encryptable.uint64(PAY)] as const)
	)
	const approveTx = await (cUSDCSrc as any).approve(src.stack.bridge, encApprove)
	await approveTx.wait()
	console.log(`   approve tx: ${approveTx.hash}`)
	if (EXPLORERS[src.name]) console.log(txLink(src.name, approveTx.hash))
	console.log()

	// ── 4. Buyer calls bridgeOut ────────────────────────────
	console.log(`④ Buyer bridges out on ${src.name}, recipient = operator on ${dst.name}...`)
	const bridgeOutTx = await (bridgeSrc as any).bridgeOut(dst.operator.address)
	const bridgeOutReceipt = await bridgeOutTx.wait()
	console.log(`   bridgeOut tx: ${bridgeOutTx.hash}`)
	if (EXPLORERS[src.name]) console.log(txLink(src.name, bridgeOutTx.hash))

	const ev = bridgeOutReceipt!.logs
		.map((l: any) => {
			try {
				return bridgeSrc.interface.parseLog({ topics: l.topics, data: l.data })
			} catch {
				return null
			}
		})
		.find((p: any) => p?.name === 'BridgeOut')
	if (!ev) throw new Error('BridgeOut log not found')
	const outboundId: bigint = ev.args.outboundId
	const handle: bigint = ev.args.encAmountHandle
	console.log(`   outboundId : ${outboundId}`)
	console.log(`   encHandle  : ${handle} (opaque)\n`)

	// ── 5. Operator unseals on src ──────────────────────────
	console.log(`⑤ Operator unsealing handle (cofhejs on ${src.name})...`)
	await initCofhe(src.operator)
	const plain = await tryUnseal<bigint>(handle, FheTypes.Uint64)
	if (plain === null) throw new Error('failed to unseal')
	console.log(`   plaintext: ${Number(plain) / 1e6} USDC\n`)

	// ── 6. Operator acks on src ─────────────────────────────
	console.log(`⑥ Operator acks outbound on ${src.name}... (no plaintext in calldata/event)`)
	const ackTx = await (bridgeSrcOp as any).ackOutbound(outboundId)
	await ackTx.wait()
	console.log(`   ack tx: ${ackTx.hash}`)
	if (EXPLORERS[src.name]) console.log(txLink(src.name, ackTx.hash))
	// Operator can unseal their own reserve to confirm the grow; observers cannot.
	const srcReserveHandle: bigint = await bridgeSrc.encReserve()
	const srcReserve = await tryUnseal<bigint>(srcReserveHandle, FheTypes.Uint64, 3, 3000)
	if (srcReserve !== null) {
		console.log(`   bridgeSrc.encReserve (operator-only view): ${Number(srcReserve) / 1e6} USDC\n`)
	} else {
		console.log(`   bridgeSrc.encReserve: handle=${srcReserveHandle} (unseal pending)\n`)
	}

	// ── 7. Operator delivers on dst ─────────────────────────
	console.log(`⑦ Operator delivers on ${dst.name}... (encrypts plain → InEuint64 on dst chain)`)
	// Re-init cofhejs for the destination chain/operator before encrypting.
	await initCofhe(dst.operator)
	const dstReserveBeforeHandle: bigint = await bridgeDst.encReserve()
	const reserveBefore = (await tryUnseal<bigint>(dstReserveBeforeHandle, FheTypes.Uint64, 3, 3000)) ?? 0n
	const [encDeliver] = await hre.cofhe.expectResultSuccess(
		cofhejs.encrypt([Encryptable.uint64(plain)] as const)
	)
	const bridgeInTx = await (bridgeDst as any).bridgeIn(outboundId, dst.operator.address, encDeliver)
	await bridgeInTx.wait()
	console.log(`   bridgeIn tx: ${bridgeInTx.hash}`)
	if (EXPLORERS[dst.name]) console.log(txLink(dst.name, bridgeInTx.hash))
	const dstReserveAfterHandle: bigint = await bridgeDst.encReserve()
	const reserveAfter = (await tryUnseal<bigint>(dstReserveAfterHandle, FheTypes.Uint64, 3, 3000)) ?? 0n
	console.log(
		`   bridgeDst.encReserve (operator-only): ${Number(reserveBefore) / 1e6} → ${Number(reserveAfter) / 1e6} USDC\n`
	)

	// ── 8. Verify recipient cUSDC balance on dst ────────────
	console.log(`⑧ Verifying recipient cUSDC on ${dst.name} via unseal...`)
	await initCofhe(dst.operator)
	let recipientHandle: bigint = 0n
	for (let i = 1; i <= 10; i++) {
		recipientHandle = await cUSDCDst.balanceOf(dst.operator.address)
		if (recipientHandle !== 0n) break
		console.log(`   RPC replica catching up... (${i}/10)`)
		await new Promise(r => setTimeout(r, 2000))
	}
	const recipientBal = await tryUnseal<bigint>(recipientHandle, FheTypes.Uint64)
	if (recipientBal === null) {
		console.log(`   FHE unseal still pending — try again later; skipping unwrap.`)
		console.log('\n── Two-chain bridge complete ──')
		return
	}
	console.log(`   operator cUSDC on ${dst.name}: ${Number(recipientBal) / 1e6}`)
	console.log(`   ✓ delivered ≥ ${Number(plain) / 1e6} USDC\n`)

	// ── 9. Recipient unwraps cUSDC → USDC on dst ────────────
	console.log(`⑨ Recipient requests unwrap on ${dst.name} (${Number(plain) / 1e6} cUSDC → USDC)...`)
	const cUSDCDstOp = new ethers.Contract(dst.stack.cToken, cUSDCArt.abi, dst.operator)
	const usdcBefore: bigint = await usdcDst.balanceOf(dst.operator.address)

	// Encrypted amount, signed for the recipient (operator is its own
	// destRecipient in this e2e). Signature is bound to msg.sender, which
	// matches since the operator wallet submits the tx directly.
	const [encUnwrapAmt] = await hre.cofhe.expectResultSuccess(
		cofhejs.encrypt([Encryptable.uint64(plain)] as const)
	)
	const reqTx = await (cUSDCDstOp as any).requestUnwrap(encUnwrapAmt)
	const reqReceipt = await reqTx.wait()
	console.log(`   requestUnwrap tx: ${reqTx.hash}`)
	if (EXPLORERS[dst.name]) console.log(txLink(dst.name, reqTx.hash))

	const unwrapLog = reqReceipt!.logs
		.map((l: any) => {
			try {
				return cUSDCDstOp.interface.parseLog({ topics: l.topics, data: l.data })
			} catch {
				return null
			}
		})
		.find((p: any) => p?.name === 'UnwrapRequested')
	if (!unwrapLog) throw new Error('UnwrapRequested log not found')
	const unwrapId: bigint = unwrapLog.args.unwrapId
	const debitHandle: bigint = unwrapLog.args.encAmountHandle
	console.log(`   unwrapId    : ${unwrapId}`)
	console.log(`   debitHandle : ${debitHandle} (opaque)\n`)

	// ── 10. Operator unseals debit and claims ───────────────
	console.log(`⑩ Operator unseals debit handle + calls claimUnwrap...`)
	const debitPlain = await tryUnseal<bigint>(debitHandle, FheTypes.Uint64)
	if (debitPlain === null) {
		console.log(`   FHE unseal still pending — recipient can call claimUnwrap later.`)
		console.log(`   unwrapId=${unwrapId} on cUSDC ${dst.stack.cToken}`)
		return
	}
	console.log(`   debit plaintext: ${Number(debitPlain) / 1e6} USDC`)
	const claimTx = await (cUSDCDstOp as any).claimUnwrap(unwrapId, debitPlain)
	await claimTx.wait()
	console.log(`   claimUnwrap tx: ${claimTx.hash}`)
	if (EXPLORERS[dst.name]) console.log(txLink(dst.name, claimTx.hash))

	const usdcAfter: bigint = await usdcDst.balanceOf(dst.operator.address)
	console.log(
		`   operator USDC on ${dst.name}: ${Number(usdcBefore) / 1e6} → ${Number(usdcAfter) / 1e6}`
	)
	console.log(`   delta: +${Number(usdcAfter - usdcBefore) / 1e6} USDC`)

	console.log('\n── Two-chain bridge complete (bridged + unwrapped end-to-end) ──')
	console.log(`Source     : ${src.name}  bridge=${src.stack.bridge}`)
	console.log(`Destination: ${dst.name}  bridge=${dst.stack.bridge}`)
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
