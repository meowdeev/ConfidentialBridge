/**
 * ConfidentialBridge tests (hardhat + cofhe-hardhat-plugin mocks).
 *
 * Run with: `pnpm --filter @confidential-bridge/contracts test`
 * (which forces `--network hardhat` — mocks don't deploy on base-sepolia).
 *
 * The two bridges model a peer relationship: bridgeA stands in for the
 * source-chain deployment and bridgeB for the destination. Because the
 * test is single-chain they share the same cUSDC, but each bridge has its
 * own cUSDC balance, which is all the source/destination distinction needs.
 */
import { expect } from 'chai'
import hre, { ethers } from 'hardhat'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import type { ConfidentialBridge, ConfidentialERC20, MockUSDC } from '../typechain-types'

// cofhe-hardhat-plugin@0.3.1 deploys MockZkVerifier at 0x...0100, but
// cofhejs@0.3.1 probes 0xCF01 to decide `isTestnet` — the mismatch makes
// `cofhejs.initialize` fall through to mainnet key-fetch and fail. So we
// bypass cofhejs here and build `InEuint64` structs by calling the mock
// zkv directly. The plugin doesn't set `verifierSigner`, so signature
// verification inside MockTaskManager.verifyInput is skipped (see line 616
// of MockTaskManager.sol: `if (verifierSigner != address(0)) ...`).
const MOCK_ZK_VERIFIER = '0x0000000000000000000000000000000000000100'
const UTYPE_UINT64 = 5
const ZKV_ABI = [
	'function zkVerifyCalcCtHash(uint256 value, uint8 utype, address user, uint8 securityZone, uint256 chainId) view returns (uint256)',
	'function insertCtHash(uint256 ctHash, uint256 value)',
]

type InEuint64Struct = {
	ctHash: bigint
	securityZone: number
	utype: number
	signature: string
}

async function makeInEuint64(
	signer: HardhatEthersSigner,
	plain: bigint
): Promise<InEuint64Struct> {
	const chainId = (await signer.provider!.getNetwork()).chainId
	const zkv = new ethers.Contract(MOCK_ZK_VERIFIER, ZKV_ABI, signer)
	const ctHash: bigint = await zkv.zkVerifyCalcCtHash(
		plain,
		UTYPE_UINT64,
		signer.address,
		0,
		chainId
	)
	await (await zkv.insertCtHash(ctHash, plain)).wait()
	return { ctHash, securityZone: 0, utype: UTYPE_UINT64, signature: '0x' }
}

const ONE_USDC = 1_000_000n // 6 decimals
const PEER_CHAIN_ARB = 421614n
const PEER_CHAIN_ETH = 11155111n

describe('ConfidentialBridge', function () {
	let deployer: HardhatEthersSigner
	let operator: HardhatEthersSigner
	let alice: HardhatEthersSigner
	let bob: HardhatEthersSigner

	let usdc: MockUSDC
	let cUSDC: ConfidentialERC20
	let bridgeA: ConfidentialBridge // source
	let bridgeB: ConfidentialBridge // destination

	beforeEach(async () => {
		const signers = await ethers.getSigners()
		;[deployer, operator, alice, bob] = signers

		const USDC = await ethers.getContractFactory('MockUSDC')
		usdc = (await USDC.deploy()) as unknown as MockUSDC
		await usdc.waitForDeployment()

		const C = await ethers.getContractFactory('ConfidentialERC20')
		cUSDC = (await C.deploy(
			await usdc.getAddress(),
			operator.address,
			'Confidential USDC',
			'cUSDC'
		)) as unknown as ConfidentialERC20
		await cUSDC.waitForDeployment()

		const Bridge = await ethers.getContractFactory('ConfidentialBridge')
		bridgeA = (await Bridge.deploy(
			await cUSDC.getAddress(),
			operator.address,
			PEER_CHAIN_ARB
		)) as unknown as ConfidentialBridge
		await bridgeA.waitForDeployment()
		bridgeB = (await Bridge.deploy(
			await cUSDC.getAddress(),
			operator.address,
			PEER_CHAIN_ETH
		)) as unknown as ConfidentialBridge
		await bridgeB.waitForDeployment()

		// deployer received 1M USDC in MockUSDC's constructor — fund operator + alice.
		await usdc.connect(deployer).transfer(operator.address, 10_000n * ONE_USDC)
		await usdc.connect(deployer).transfer(alice.address, 1_000n * ONE_USDC)
	})

	async function seedBridge(bridge: ConfidentialBridge, amount: bigint) {
		await usdc.connect(operator).approve(await bridge.getAddress(), amount)
		await bridge.connect(operator).seedLiquidity(amount)
	}

	async function aliceWrap(amount: bigint) {
		await usdc.connect(alice).approve(await cUSDC.getAddress(), amount)
		await cUSDC.connect(alice).wrap(amount)
	}

	async function aliceApproves(spender: string, plainAmount: bigint) {
		const enc = await makeInEuint64(alice, plainAmount)
		await cUSDC.connect(alice).approve(spender, enc)
	}

	function parseBridgeOut(
		bridge: ConfidentialBridge,
		receipt: Awaited<ReturnType<Awaited<ReturnType<typeof bridgeA.bridgeOut>>['wait']>>
	): { outboundId: bigint; handle: bigint } {
		const log = receipt!.logs
			.map(l => {
				try {
					return bridge.interface.parseLog({ topics: [...l.topics], data: l.data })
				} catch {
					return null
				}
			})
			.find(p => p?.name === 'BridgeOut')
		if (!log) throw new Error('BridgeOut log not found')
		return { outboundId: log.args.outboundId, handle: log.args.encAmountHandle }
	}

	// v2 reserves are encrypted — unseal via mock plaintext storage to assert.
	async function readReserve(bridge: ConfidentialBridge): Promise<bigint> {
		const handle: bigint = await bridge.encReserve()
		return hre.cofhe.mocks.getPlaintext(handle)
	}

	describe('constructor', () => {
		it('rejects operator=0', async () => {
			const Bridge = await ethers.getContractFactory('ConfidentialBridge')
			await expect(
				Bridge.deploy(await cUSDC.getAddress(), ethers.ZeroAddress, PEER_CHAIN_ARB)
			).to.be.revertedWith('operator=0')
		})

		it('pins cToken, operator, peerChainId', async () => {
			expect(await bridgeA.cToken()).to.equal(await cUSDC.getAddress())
			expect(await bridgeA.operator()).to.equal(operator.address)
			expect(await bridgeA.peerChainId()).to.equal(PEER_CHAIN_ARB)
		})
	})

	describe('seedLiquidity', () => {
		it('pulls underlying, wraps, grows encReserve', async () => {
			await usdc.connect(operator).approve(await bridgeA.getAddress(), 100n * ONE_USDC)
			await expect(bridgeA.connect(operator).seedLiquidity(100n * ONE_USDC))
				.to.emit(bridgeA, 'ReserveSeeded')
				.withArgs(100n * ONE_USDC)
			expect(await readReserve(bridgeA)).to.equal(100n * ONE_USDC)

			// bridge now holds 100 cUSDC — check via FHE handle plaintext
			const balHandle = await cUSDC.balanceOf(await bridgeA.getAddress())
			await hre.cofhe.mocks.expectPlaintext(balHandle, 100n * ONE_USDC)
		})

		it('rejects non-operator', async () => {
			await usdc.connect(alice).approve(await bridgeA.getAddress(), ONE_USDC)
			await expect(
				bridgeA.connect(alice).seedLiquidity(ONE_USDC)
			).to.be.revertedWith('not operator')
		})
	})

	describe('bridgeOut', () => {
		it('rejects recipient=0', async () => {
			await expect(
				bridgeA.connect(alice).bridgeOut(ethers.ZeroAddress)
			).to.be.revertedWith('recipient=0')
		})

		it('pulls full approved allowance and records outbound', async () => {
			const AMT = 10n * ONE_USDC
			await aliceWrap(AMT)
			await aliceApproves(await bridgeA.getAddress(), AMT)

			const tx = await bridgeA.connect(alice).bridgeOut(bob.address)
			const receipt = await tx.wait()
			const { outboundId, handle } = parseBridgeOut(bridgeA, receipt)

			expect(outboundId).to.equal(0n)
			const ob = await bridgeA.outbound(0)
			expect(ob.sender).to.equal(alice.address)
			expect(ob.destRecipient).to.equal(bob.address)
			expect(ob.operatorAcked).to.equal(false)

			// handle plaintext == AMT
			await hre.cofhe.mocks.expectPlaintext(handle, AMT)
		})

		it('clamps to approved allowance when user under-approved', async () => {
			await aliceWrap(10n * ONE_USDC)
			await aliceApproves(await bridgeA.getAddress(), 3n * ONE_USDC)

			const tx = await bridgeA.connect(alice).bridgeOut(bob.address)
			const receipt = await tx.wait()
			const { handle } = parseBridgeOut(bridgeA, receipt)

			// only 3 crossed, not the full 10 alice holds
			await hre.cofhe.mocks.expectPlaintext(handle, 3n * ONE_USDC)
		})

		it('zero-clamps when allowance > balance (not min — underlying uses all-or-nothing)', async () => {
			// Underlying ConfidentialERC20._clampToBalance is `ok ? amount : 0`,
			// not `min(amount, bal)` — so approving more than you hold
			// silently bridges 0 rather than your balance. Surprising, but
			// documented semantics from the reference ERC-7984 impl.
			await aliceWrap(2n * ONE_USDC)
			await aliceApproves(await bridgeA.getAddress(), 10n * ONE_USDC)

			const tx = await bridgeA.connect(alice).bridgeOut(bob.address)
			const receipt = await tx.wait()
			const { handle } = parseBridgeOut(bridgeA, receipt)

			await hre.cofhe.mocks.expectPlaintext(handle, 0n)

			// balance untouched
			const aliceBal = await cUSDC.balanceOf(alice.address)
			await hre.cofhe.mocks.expectPlaintext(aliceBal, 2n * ONE_USDC)
		})

		it('assigns monotonic outbound ids', async () => {
			await aliceWrap(10n * ONE_USDC)

			await aliceApproves(await bridgeA.getAddress(), 1n * ONE_USDC)
			await bridgeA.connect(alice).bridgeOut(bob.address)

			await aliceApproves(await bridgeA.getAddress(), 1n * ONE_USDC)
			await bridgeA.connect(alice).bridgeOut(bob.address)

			expect(await bridgeA.nextOutboundId()).to.equal(2n)
		})
	})

	describe('ackOutbound', () => {
		beforeEach(async () => {
			await aliceWrap(10n * ONE_USDC)
			await aliceApproves(await bridgeA.getAddress(), 5n * ONE_USDC)
			await bridgeA.connect(alice).bridgeOut(bob.address)
		})

		it('rejects non-operator', async () => {
			await expect(
				bridgeA.connect(alice).ackOutbound(0)
			).to.be.revertedWith('not operator')
		})

		it('rejects unknown outbound', async () => {
			await expect(
				bridgeA.connect(operator).ackOutbound(42)
			).to.be.revertedWith('unknown outbound')
		})

		it('rejects double-ack', async () => {
			await bridgeA.connect(operator).ackOutbound(0)
			await expect(
				bridgeA.connect(operator).ackOutbound(0)
			).to.be.revertedWith('already acked')
		})

		it('grows encReserve by the stored encAmount (no plaintext in call/event)', async () => {
			await expect(bridgeA.connect(operator).ackOutbound(0))
				.to.emit(bridgeA, 'BridgeOutAcked')
				.withArgs(0)
			expect(await readReserve(bridgeA)).to.equal(5n * ONE_USDC)
			const ob = await bridgeA.outbound(0)
			expect(ob.operatorAcked).to.equal(true)
		})
	})

	describe('bridgeIn', () => {
		it('rejects non-operator', async () => {
			await seedBridge(bridgeB, 100n * ONE_USDC)
			const enc = await makeInEuint64(alice, ONE_USDC)
			await expect(
				bridgeB.connect(alice).bridgeIn(0, bob.address, enc)
			).to.be.revertedWith('not operator')
		})

		it('rejects recipient=0', async () => {
			await seedBridge(bridgeB, 100n * ONE_USDC)
			const enc = await makeInEuint64(operator, ONE_USDC)
			await expect(
				bridgeB.connect(operator).bridgeIn(0, ethers.ZeroAddress, enc)
			).to.be.revertedWith('recipient=0')
		})

		it('silent-clamps when reserve insufficient; replay still trips; nothing transfers', async () => {
			await seedBridge(bridgeB, 5n * ONE_USDC)
			const enc = await makeInEuint64(operator, 10n * ONE_USDC)
			// No revert — silent clamp (ERC-7984 semantics; can't reveal reserve value via a require).
			await bridgeB.connect(operator).bridgeIn(0, bob.address, enc)
			// Replay flag is set (operator consumed the slot; their problem to avoid this off-chain).
			expect(await bridgeB.inboundSettled(0)).to.equal(true)
			// Reserve untouched (clamped to 0, nothing subtracted).
			expect(await readReserve(bridgeB)).to.equal(5n * ONE_USDC)
			// Recipient got nothing.
			const bobBal = await cUSDC.balanceOf(bob.address)
			if (bobBal !== 0n) {
				await hre.cofhe.mocks.expectPlaintext(bobBal, 0n)
			}
		})

		it('replay-guarded by peerOutboundId', async () => {
			await seedBridge(bridgeB, 100n * ONE_USDC)
			const enc1 = await makeInEuint64(operator, ONE_USDC)
			await bridgeB.connect(operator).bridgeIn(42, bob.address, enc1)
			const enc2 = await makeInEuint64(operator, ONE_USDC)
			await expect(
				bridgeB.connect(operator).bridgeIn(42, bob.address, enc2)
			).to.be.revertedWith('already settled')
		})

		it('credits recipient, shrinks encReserve, emits BridgeIn with encrypted handle (no plaintext)', async () => {
			const AMT = 10n * ONE_USDC
			await seedBridge(bridgeB, 100n * ONE_USDC)

			const enc = await makeInEuint64(operator, AMT)
			const tx = await bridgeB.connect(operator).bridgeIn(7, bob.address, enc)
			const receipt = await tx.wait()

			const evLog = receipt!.logs
				.map((l: any) => {
					try {
						return bridgeB.interface.parseLog({ topics: [...l.topics], data: l.data })
					} catch {
						return null
					}
				})
				.find((p: any) => p?.name === 'BridgeIn')
			if (!evLog) throw new Error('BridgeIn log not found')
			expect(evLog.args.peerOutboundId).to.equal(7n)
			expect(evLog.args.recipient).to.equal(bob.address)
			// Handle is opaque; only its plaintext behind the FHE ACL matches AMT.
			const emittedHandle: bigint = evLog.args.encAmountHandle
			await hre.cofhe.mocks.expectPlaintext(emittedHandle, AMT)

			expect(await readReserve(bridgeB)).to.equal(90n * ONE_USDC)
			expect(await bridgeB.inboundSettled(7)).to.equal(true)

			const bobBal = await cUSDC.balanceOf(bob.address)
			await hre.cofhe.mocks.expectPlaintext(bobBal, AMT)
		})

		it('handles amount=0 as a no-op transfer but still sets replay flag', async () => {
			await seedBridge(bridgeB, ONE_USDC)
			const enc = await makeInEuint64(operator, 0n)
			await bridgeB.connect(operator).bridgeIn(3, bob.address, enc)
			expect(await bridgeB.inboundSettled(3)).to.equal(true)
			expect(await readReserve(bridgeB)).to.equal(ONE_USDC) // unchanged
		})
	})

	describe('drainReserve', () => {
		it('rejects non-operator', async () => {
			await seedBridge(bridgeA, 10n * ONE_USDC)
			await expect(
				bridgeA.connect(alice).drainReserve(alice.address, ONE_USDC)
			).to.be.revertedWith('not operator')
		})

		it('rejects to=0', async () => {
			await seedBridge(bridgeA, 10n * ONE_USDC)
			await expect(
				bridgeA.connect(operator).drainReserve(ethers.ZeroAddress, ONE_USDC)
			).to.be.revertedWith('to=0')
		})

		it('silent-clamps on over-drain (no revert; counter preserved)', async () => {
			await seedBridge(bridgeA, 5n * ONE_USDC)
			// No revert — we can't reveal reserve-short via `require` without leaking it.
			await bridgeA.connect(operator).drainReserve(operator.address, 10n * ONE_USDC)
			// Reserve and bridge cToken balance untouched.
			expect(await readReserve(bridgeA)).to.equal(5n * ONE_USDC)
			const opBal = await cUSDC.balanceOf(operator.address)
			if (opBal !== 0n) {
				await hre.cofhe.mocks.expectPlaintext(opBal, 0n)
			}
		})

		it('shrinks encReserve and moves cToken to `to`', async () => {
			await seedBridge(bridgeA, 10n * ONE_USDC)
			await expect(
				bridgeA.connect(operator).drainReserve(operator.address, 4n * ONE_USDC)
			)
				.to.emit(bridgeA, 'ReserveDrained')
				.withArgs(operator.address, 4n * ONE_USDC)

			expect(await readReserve(bridgeA)).to.equal(6n * ONE_USDC)
			const opBal = await cUSDC.balanceOf(operator.address)
			await hre.cofhe.mocks.expectPlaintext(opBal, 4n * ONE_USDC)
		})
	})

	describe('end-to-end (A → B round-trip)', () => {
		it('user bridges cUSDC from A, operator relays, recipient receives on B', async () => {
			const AMT = 25n * ONE_USDC

			// B is pre-funded so it can pay out
			await seedBridge(bridgeB, 100n * ONE_USDC)

			// Alice wraps, approves A, bridges out
			await aliceWrap(AMT)
			await aliceApproves(await bridgeA.getAddress(), AMT)
			const tx = await bridgeA.connect(alice).bridgeOut(bob.address)
			const receipt = await tx.wait()
			const { outboundId, handle } = parseBridgeOut(bridgeA, receipt)

			// Bridge A now holds AMT of cUSDC (alice's balance drained by that much)
			const aliceBal = await cUSDC.balanceOf(alice.address)
			await hre.cofhe.mocks.expectPlaintext(aliceBal, 0n)

			// Operator reads the plaintext off-chain (here: via mock)
			const plain = await hre.cofhe.mocks.getPlaintext(handle)
			expect(plain).to.equal(AMT)

			// Operator pins on A (grows A's reserve for future B→A flows)
			// v2: no plaintext crosses — the stored handle is folded into encReserve.
			await bridgeA.connect(operator).ackOutbound(outboundId)
			expect(await readReserve(bridgeA)).to.equal(AMT)

			// Operator delivers on B (shrinks B's encReserve by the same amount,
			// but passes it as a freshly-encrypted InEuint64 — no plaintext on-chain).
			const enc = await makeInEuint64(operator, plain)
			await bridgeB.connect(operator).bridgeIn(outboundId, bob.address, enc)

			// Bob is credited on B side
			const bobBal = await cUSDC.balanceOf(bob.address)
			await hre.cofhe.mocks.expectPlaintext(bobBal, AMT)

			// Reserve bookkeeping: A up by AMT, B down by AMT from its seed
			expect(await readReserve(bridgeA)).to.equal(AMT)
			expect(await readReserve(bridgeB)).to.equal(100n * ONE_USDC - AMT)
		})

		it('recipient unwraps cUSDC → USDC on destination (full user-facing loop)', async () => {
			const AMT = 25n * ONE_USDC

			// Full bridge flow (same as above, compacted) to set bob up with AMT cUSDC.
			await seedBridge(bridgeB, 100n * ONE_USDC)
			await aliceWrap(AMT)
			await aliceApproves(await bridgeA.getAddress(), AMT)
			const bridgeOutTx = await bridgeA.connect(alice).bridgeOut(bob.address)
			const bridgeOutReceipt = await bridgeOutTx.wait()
			const { outboundId, handle } = parseBridgeOut(bridgeA, bridgeOutReceipt)
			const plain = await hre.cofhe.mocks.getPlaintext(handle)
			await bridgeA.connect(operator).ackOutbound(outboundId)
			const encIn = await makeInEuint64(operator, plain)
			await bridgeB.connect(operator).bridgeIn(outboundId, bob.address, encIn)

			// Sanity: bob holds AMT cUSDC, 0 USDC.
			await hre.cofhe.mocks.expectPlaintext(await cUSDC.balanceOf(bob.address), AMT)
			const bobUsdcBefore = await usdc.balanceOf(bob.address)
			expect(bobUsdcBefore).to.equal(0n)

			// Bob requests unwrap of AMT cUSDC. Signature is bound to bob as msg.sender.
			const encUnwrap = await makeInEuint64(bob, AMT)
			const reqTx = await cUSDC.connect(bob).requestUnwrap(encUnwrap)
			const reqReceipt = await reqTx.wait()
			const unwrapLog = reqReceipt!.logs
				.map(l => {
					try {
						return cUSDC.interface.parseLog({ topics: [...l.topics], data: l.data })
					} catch {
						return null
					}
				})
				.find(p => p?.name === 'UnwrapRequested')
			if (!unwrapLog) throw new Error('UnwrapRequested log not found')
			const unwrapId: bigint = unwrapLog.args.unwrapId
			const debitHandle: bigint = unwrapLog.args.encAmountHandle

			// In prod: operator unseals `debitHandle` off-chain via cofhejs.unseal.
			// Here: peek at the mock storage.
			const debitPlain = await hre.cofhe.mocks.getPlaintext(debitHandle)
			expect(debitPlain).to.equal(AMT)

			// Operator doubles as `unwrapper` — calls claimUnwrap with the plaintext.
			await cUSDC.connect(operator).claimUnwrap(unwrapId, debitPlain)

			// Bob now has AMT USDC; cUSDC balance is zero.
			const bobUsdcAfter = await usdc.balanceOf(bob.address)
			expect(bobUsdcAfter - bobUsdcBefore).to.equal(AMT)
			await hre.cofhe.mocks.expectPlaintext(await cUSDC.balanceOf(bob.address), 0n)
		})
	})
})
