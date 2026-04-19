import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { getDeployment, saveDeployment } from './utils'

/**
 * One-shot deployment for a single chain in a two-chain bridge setup.
 *
 * Deploys (or reuses, in this priority order):
 *   1. MockUSDC      — pass --usdc <addr> to skip and use an existing token
 *   2. cUSDC         — pass --c-token <addr> to skip
 *   3. Bridge        — always fresh (cheap, configurable peer)
 *
 * All addresses get saved to deployments/<network>.json.
 *
 * Run once per chain. Example for Eth-Sepolia ↔ Arb-Sepolia:
 *
 *   pnpm hardhat deploy-stack --peer-chain-id 421614 --network eth-sepolia
 *   pnpm hardhat deploy-stack --peer-chain-id 11155111 --network arb-sepolia
 */
task('deploy-stack', 'Deploy MockUSDC + ConfidentialERC20 + ConfidentialBridge on this chain')
	.addParam('peerChainId', 'Chain ID of the peer bridge', undefined, types.int)
	.addOptionalParam('usdc', 'Existing underlying USDC address (skips MockUSDC deploy)')
	.addOptionalParam('cToken', 'Existing cUSDC address (skips ConfidentialERC20 deploy)')
	.addOptionalParam('operator', 'Operator address (defaults to signers[1] or signers[0])')
	.setAction(
		async (
			args: { peerChainId: number; usdc?: string; cToken?: string; operator?: string },
			hre: HardhatRuntimeEnvironment
		) => {
			const { ethers, network } = hre
			const [deployer, second] = await ethers.getSigners()
			const operator = args.operator ?? (second ? second.address : deployer.address)

			console.log(`╔═══ deploy-stack ═══╗`)
			console.log(`network      : ${network.name} (chainId ${network.config.chainId})`)
			console.log(`deployer     : ${deployer.address}`)
			console.log(`operator     : ${operator}`)
			console.log(`peer chainId : ${args.peerChainId}`)
			console.log()

			// ── 1. USDC ──────────────────────────────────────────
			let usdcAddress = args.usdc ?? getDeployment(network.name, 'MockUSDC')
			if (usdcAddress) {
				console.log(`① Using existing USDC at ${usdcAddress}`)
			} else {
				console.log('① Deploying MockUSDC...')
				const USDC = await ethers.getContractFactory('MockUSDC')
				const usdc = await USDC.connect(deployer).deploy()
				await usdc.waitForDeployment()
				usdcAddress = await usdc.getAddress()
				saveDeployment(network.name, 'MockUSDC', usdcAddress)
				console.log(`   MockUSDC: ${usdcAddress}`)
			}
			console.log()

			// ── 2. ConfidentialERC20 (cUSDC) ─────────────────────
			let cTokenAddress = args.cToken ?? getDeployment(network.name, 'ConfidentialERC20')
			if (cTokenAddress && !args.cToken) {
				console.log(`② Using existing cUSDC at ${cTokenAddress}`)
			} else if (args.cToken) {
				cTokenAddress = args.cToken
				console.log(`② Using cUSDC (provided) at ${cTokenAddress}`)
			} else {
				console.log('② Deploying ConfidentialERC20 (cUSDC)...')
				const C = await ethers.getContractFactory('ConfidentialERC20')
				const cToken = await C.connect(deployer).deploy(
					usdcAddress,
					operator, // unwrapper role
					'Confidential USDC',
					'cUSDC'
				)
				await cToken.waitForDeployment()
				cTokenAddress = await cToken.getAddress()
				saveDeployment(network.name, 'ConfidentialERC20', cTokenAddress)
				console.log(`   cUSDC: ${cTokenAddress}`)
			}
			console.log()

			// ── 3. ConfidentialBridge ────────────────────────────
			console.log('③ Deploying ConfidentialBridge...')
			const Bridge = await ethers.getContractFactory('ConfidentialBridge')
			const bridge = await Bridge.connect(deployer).deploy(
				cTokenAddress,
				operator,
				args.peerChainId
			)
			await bridge.waitForDeployment()
			const bridgeAddress = await bridge.getAddress()
			saveDeployment(network.name, 'ConfidentialBridge', bridgeAddress)
			console.log(`   ConfidentialBridge: ${bridgeAddress}`)
			console.log()

			console.log('── Add to your .env (per-chain) ──')
			const envSuffix = network.name.toUpperCase().replace(/-/g, '_')
			console.log(`USDC_${envSuffix}=${usdcAddress}`)
			console.log(`CUSDC_${envSuffix}=${cTokenAddress}`)
			console.log(`BRIDGE_${envSuffix}=${bridgeAddress}`)
		}
	)
