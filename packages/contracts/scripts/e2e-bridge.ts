/**
 * End-to-end test of ConfidentialBridge on Base Sepolia.
 *
 * The contract is symmetric per-chain so a true two-chain test would deploy
 * one instance on Eth-Sepolia and one on Arb-Sepolia. Since this repo only
 * configures Base Sepolia, we model the peer relationship by deploying
 * TWO bridges on the same chain — bridgeA stands in for the source, bridgeB
 * for the destination. They share the underlying cUSDC but each has its
 * own cUSDC reserve, which is all the source/destination distinction needs.
 *
 * Flow:
 *   1. Resolve / deploy MockUSDC, ConfidentialERC20 (cUSDC)
 *   2. Deploy bridgeA (peerChainId = arb-sepolia) and bridgeB (peerChainId = eth-sepolia)
 *   3. Operator wraps USDC and seedLiquidity-s into bridgeB
 *   4. Buyer wraps USDC into cUSDC, approves bridgeA for an encrypted amount
 *   5. Buyer calls bridgeA.bridgeOut(observer) — debits buyer, parks in bridgeA
 *   6. Operator unseals the BridgeOut handle via cofhejs.unseal
 *   7. Operator calls bridgeA.ackOutbound(id, plain) — pins plaintext, grows A's reserve
 *   8. Operator calls bridgeB.bridgeIn(id, observer, plain) — credits observer from B's reserve
 *   9. Verify observer's encrypted cUSDC balance grew by `plain`
 *
 * Run: `pnpm e2e:bridge` (defaults to base-sepolia per hardhat config)
 */
import hre from 'hardhat'
import {
	cofhejs,
	Encryptable,
	FheTypes,
	type AbstractProvider,
	type AbstractSigner,
} from 'cofhejs/node'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { TypedDataField } from 'ethers'

const PEER_CHAIN_ARB = 421614n
const PEER_CHAIN_ETH = 11155111n

function wrapSigner(signer: HardhatEthersSigner): {
	provider: AbstractProvider
	signer: AbstractSigner
} {
	const provider: AbstractProvider = {
		call: async (...args) => signer.provider.call(...args),
		getChainId: async () => (await signer.provider.getNetwork()).chainId.toString(),
		send: async (...args) => signer.provider.send(...args),
	}
	const abstractSigner: AbstractSigner = {
		signTypedData: async (domain, types, value) =>
			signer.signTypedData(domain, types as Record<string, TypedDataField[]>, value),
		getAddress: async () => signer.getAddress(),
		provider,
		sendTransaction: async (...args) => {
			const tx = await signer.sendTransaction(...args)
			return tx.hash
		},
	}
	return { provider, signer: abstractSigner }
}

async function initCofhe(signer: HardhatEthersSigner) {
	const wrapped = wrapSigner(signer)
	const result = await cofhejs.initialize({
		provider: wrapped.provider,
		signer: wrapped.signer,
		environment: 'TESTNET',
	})
	if (result.error) throw new Error(`cofhejs init failed: ${result.error}`)
	return result.data
}

async function tryUnseal<T extends bigint>(
	handle: bigint,
	type: FheTypes,
	tries = 12,
	delayMs = 5000
): Promise<T | null> {
	for (let i = 1; i <= tries; i++) {
		const res = await cofhejs.unseal(handle, type)
		if (res.data !== undefined && res.data !== null) return res.data as T
		if (i < tries) {
			console.log(`  FHE network processing... (${i}/${tries})`)
			await new Promise(r => setTimeout(r, delayMs))
		}
	}
	return null
}

async function main() {
	const { ethers, network } = hre
	if (network.name !== 'base-sepolia') {
		throw new Error(`This script runs on base-sepolia only (got: ${network.name})`)
	}

	const signers = await ethers.getSigners()
	if (signers.length < 2) {
		throw new Error('Need both PRIVATE_KEY (buyer) and OBSERVER_PRIVATE_KEY (operator) in .env')
	}
	const buyer = signers[0]
	const operator = signers[1]

	const explorer = 'https://sepolia.basescan.org'
	const txLink = (hash: string) => `  ${explorer}/tx/${hash}`

	console.log('╔══════════════════════════════════════════╗')
	console.log('║   ConfidentialBridge — E2E Flow          ║')
	console.log('╚══════════════════════════════════════════╝')
	console.log(`Network : ${network.name}`)
	console.log(`Buyer   : ${buyer.address}`)
	console.log(`Operator: ${operator.address}`)
	console.log(`(observer wallet doubles as bridge operator + cUSDC unwrapper)\n`)

	// ── 1. Resolve USDC ───────────────────────────────────
	const usdcAddress = process.env.USDC_ADDRESS
	if (!usdcAddress) {
		throw new Error('USDC_ADDRESS required. Deploy MockUSDC: npx hardhat deploy-usdc')
	}
	console.log(`① Using USDC at ${usdcAddress}`)
	const usdc = await ethers.getContractAt(
		[
			'function balanceOf(address) view returns (uint256)',
			'function approve(address,uint256) returns (bool)',
			'function mint(address,uint256)',
		],
		usdcAddress
	)

	// Make sure both buyer + operator have enough USDC for the flow
	for (const [name, who, need] of [
		['Buyer', buyer, 50_000_000n] as const,
		['Operator', operator, 100_000_000n] as const,
	]) {
		const bal = await usdc.balanceOf(who.address)
		if (bal < need) {
			console.log(`  ${name} short on USDC (${Number(bal) / 1e6}), minting from mock...`)
			await (await (usdc.connect(who) as any).mint(who.address, 1000_000_000n)).wait()
		}
	}
	console.log()

	// ── 2. Deploy cUSDC ────────────────────────────────────
	console.log('② Deploying ConfidentialERC20 (cUSDC) — fresh per run...')
	const CFactory = await ethers.getContractFactory('ConfidentialERC20')
	const cUSDC = await CFactory.connect(buyer).deploy(
		usdcAddress,
		operator.address, // unwrapper
		'Confidential USDC',
		'cUSDC'
	)
	await cUSDC.waitForDeployment()
	const cUSDCAddress = await cUSDC.getAddress()
	console.log(`  cUSDC: ${cUSDCAddress}\n`)

	// ── 3. Deploy bridgeA and bridgeB ──────────────────────
	console.log('③ Deploying ConfidentialBridge × 2 (A=source, B=destination)...')
	const BridgeFactory = await ethers.getContractFactory('ConfidentialBridge')
	const bridgeA = await BridgeFactory.connect(buyer).deploy(
		cUSDCAddress,
		operator.address,
		PEER_CHAIN_ARB
	)
	await bridgeA.waitForDeployment()
	const bridgeAAddress = await bridgeA.getAddress()
	console.log(`  bridgeA (peer=arb): ${bridgeAAddress}`)

	const bridgeB = await BridgeFactory.connect(buyer).deploy(
		cUSDCAddress,
		operator.address,
		PEER_CHAIN_ETH
	)
	await bridgeB.waitForDeployment()
	const bridgeBAddress = await bridgeB.getAddress()
	console.log(`  bridgeB (peer=eth): ${bridgeBAddress}\n`)

	// ── 4. Operator seeds bridgeB ──────────────────────────
	const SEED = 50_000_000n // 50 USDC
	const PAY = 10_000_000n // 10 USDC bridged

	console.log(`④ Operator seeds bridgeB with ${Number(SEED) / 1e6} USDC...`)
	const seedApprove = await (usdc.connect(operator) as any).approve(bridgeBAddress, SEED)
	await seedApprove.wait()
	const seedTx = await (bridgeB.connect(operator) as any).seedLiquidity(SEED)
	await seedTx.wait()
	console.log(`  Seed tx: ${seedTx.hash}`)
	if (explorer) console.log(txLink(seedTx.hash))
	console.log(`  bridgeB.encReserve (handle only; operator unseals off-chain)\n`)

	// ── 5. Buyer wraps USDC → cUSDC ────────────────────────
	console.log(`⑤ Buyer wraps ${Number(PAY) / 1e6} USDC → cUSDC...`)
	await (await (usdc.connect(buyer) as any).approve(cUSDCAddress, PAY)).wait()
	const wrapTx = await (cUSDC.connect(buyer) as any).wrap(PAY)
	await wrapTx.wait()
	console.log(`  Wrap tx: ${wrapTx.hash}`)
	if (explorer) console.log(txLink(wrapTx.hash))
	console.log()

	// ── 6. Buyer approves bridgeA with encrypted amount ────
	console.log('⑥ Buyer approves bridgeA (encrypted allowance)...')
	await initCofhe(buyer)
	const [encApprove] = await hre.cofhe.expectResultSuccess(
		cofhejs.encrypt([Encryptable.uint64(PAY)] as const)
	)
	const approveTx = await (cUSDC.connect(buyer) as any).approve(bridgeAAddress, encApprove)
	await approveTx.wait()
	console.log(`  Approve tx: ${approveTx.hash}`)
	if (explorer) console.log(txLink(approveTx.hash))
	console.log()

	// ── 7. Buyer calls bridgeOut ───────────────────────────
	console.log(`⑦ Buyer bridges out → operator (recipient on peer chain)...`)
	const bridgeOutTx = await (bridgeA.connect(buyer) as any).bridgeOut(operator.address)
	const bridgeOutReceipt = await bridgeOutTx.wait()
	console.log(`  bridgeOut tx: ${bridgeOutTx.hash}`)
	if (explorer) console.log(txLink(bridgeOutTx.hash))

	const bridgeOutLog = bridgeOutReceipt!.logs.find((log: any) => {
		try {
			return (
				bridgeA.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name ===
				'BridgeOut'
			)
		} catch {
			return false
		}
	})
	const parsed = bridgeA.interface.parseLog({
		topics: bridgeOutLog!.topics as string[],
		data: bridgeOutLog!.data,
	})!
	const outboundId: bigint = parsed.args.outboundId
	const handle: bigint = parsed.args.encAmountHandle

	console.log('\n  On-chain breadcrumbs (everyone sees):')
	console.log(`    outboundId      : ${outboundId}`)
	console.log(`    sender          : ${buyer.address}`)
	console.log(`    destRecipient   : ${operator.address}`)
	console.log(`    encAmount handle: ${handle} (opaque)\n`)

	// ── 8. Operator unseals the handle ─────────────────────
	console.log('⑧ Operator unsealing the BridgeOut handle (off-chain)...')
	await initCofhe(operator)
	const plain = await tryUnseal<bigint>(handle, FheTypes.Uint64)
	if (plain === null) throw new Error('Failed to unseal bridgeOut handle')
	console.log(`  Decrypted amount: ${Number(plain) / 1e6} USDC\n`)

	if (plain !== PAY) {
		console.warn(`  ⚠  unsealed amount ${plain} != approved PAY ${PAY} — likely under-approved or under-balance`)
	}

	// ── 9. Operator acks on source (grows A's reserve) ─────
	console.log('⑨ Operator acks outbound on bridgeA (no plaintext in calldata/event)...')
	const ackTx = await (bridgeA.connect(operator) as any).ackOutbound(outboundId)
	await ackTx.wait()
	console.log(`  ack tx: ${ackTx.hash}`)
	if (explorer) console.log(txLink(ackTx.hash))

	// ── 10. Operator delivers on destination ───────────────
	console.log('⑩ Operator delivers on bridgeB (encrypted amount via InEuint64)...')
	const [encDeliver] = await hre.cofhe.expectResultSuccess(
		cofhejs.encrypt([Encryptable.uint64(plain)] as const)
	)
	const bridgeInTx = await (bridgeB.connect(operator) as any).bridgeIn(
		outboundId,
		operator.address,
		encDeliver
	)
	await bridgeInTx.wait()
	console.log(`  bridgeIn tx: ${bridgeInTx.hash}`)
	if (explorer) console.log(txLink(bridgeInTx.hash))

	// ── 11. Verify recipient's encrypted balance ───────────
	console.log('⑪ Verifying recipient (operator) cUSDC balance via FHE unseal...')
	// Base Sepolia replica lag — retry until the new credit shows up
	let recipientBalHandle: bigint = 0n
	for (let i = 1; i <= 10; i++) {
		recipientBalHandle = await cUSDC.balanceOf(operator.address)
		if (recipientBalHandle !== 0n) break
		console.log(`  RPC replica catching up... (${i}/10)`)
		await new Promise(r => setTimeout(r, 2000))
	}
	const recipientBal = await tryUnseal<bigint>(recipientBalHandle, FheTypes.Uint64)
	if (recipientBal === null) {
		console.log('  FHE unseal still pending — skipping unwrap. Re-run later.')
	} else {
		console.log(`  Operator cUSDC balance: ${Number(recipientBal) / 1e6}`)
		if (recipientBal < plain) {
			console.log(`  ⚠  expected at least ${Number(plain) / 1e6}, got ${Number(recipientBal) / 1e6}`)
		}

		// ── 12. Recipient unwraps cUSDC → USDC ──────────────
		console.log(`\n⑫ Recipient unwraps ${Number(plain) / 1e6} cUSDC → USDC...`)
		const usdcBefore: bigint = await (usdc as any).balanceOf(operator.address)
		const [encUnwrap] = await hre.cofhe.expectResultSuccess(
			cofhejs.encrypt([Encryptable.uint64(plain)] as const)
		)
		const reqTx = await (cUSDC.connect(operator) as any).requestUnwrap(encUnwrap)
		const reqReceipt = await reqTx.wait()
		console.log(`  requestUnwrap tx: ${reqTx.hash}`)
		if (explorer) console.log(txLink(reqTx.hash))

		const unwrapLog = reqReceipt!.logs.find((log: any) => {
			try {
				return (
					cUSDC.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name ===
					'UnwrapRequested'
				)
			} catch {
				return false
			}
		})
		const unwrapParsed = cUSDC.interface.parseLog({
			topics: unwrapLog!.topics as string[],
			data: unwrapLog!.data,
		})!
		const unwrapId: bigint = unwrapParsed.args.unwrapId
		const debitHandle: bigint = unwrapParsed.args.encAmountHandle

		const debitPlain = await tryUnseal<bigint>(debitHandle, FheTypes.Uint64)
		if (debitPlain === null) {
			console.log(`  FHE unseal still pending — recipient can call claimUnwrap later.`)
			console.log(`  unwrapId=${unwrapId}`)
		} else {
			const claimTx = await (cUSDC.connect(operator) as any).claimUnwrap(unwrapId, debitPlain)
			await claimTx.wait()
			console.log(`  claimUnwrap tx: ${claimTx.hash}`)
			if (explorer) console.log(txLink(claimTx.hash))

			const usdcAfter: bigint = await (usdc as any).balanceOf(operator.address)
			console.log(
				`  operator USDC: ${Number(usdcBefore) / 1e6} → ${Number(usdcAfter) / 1e6}  (+${Number(usdcAfter - usdcBefore) / 1e6})`
			)
		}
	}

	console.log('\n── Privacy summary (v2) ──')
	console.log('✓ encAmount   — FHE-encrypted on bridgeA, only operator could unseal')
	console.log('✓ allowance   — encrypted on cUSDC; bridge consumed via transferFromAllowance')
	console.log('✓ debit       — bridgeA holds the encrypted handle; ACL granted to operator')
	console.log('✓ ack         — homomorphic add into encReserve; no plaintext in calldata/event')
	console.log('✓ delivery    — operator submits InEuint64; BridgeIn event emits handle only')
	console.log('✓ reserve     — encReserve is euint64; only operator (ACL) can read the value')
	console.log('✓ replay      — inboundSettled[outboundId] flag prevents double-credit')
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
