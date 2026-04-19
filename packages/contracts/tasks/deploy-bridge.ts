import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { getDeployment, saveDeployment } from './utils'

task('deploy-bridge', 'Deploy ConfidentialBridge pointing at a peer chain')
	.addParam('peerChainId', 'Chain ID of the peer bridge', undefined, types.int)
	.addOptionalParam('cToken', 'ConfidentialERC20 address (defaults to deployments record)')
	.addOptionalParam('operator', 'Operator address (defaults to OBSERVER_PRIVATE_KEY signer)')
	.setAction(
		async (
			args: { peerChainId: number; cToken?: string; operator?: string },
			hre: HardhatRuntimeEnvironment
		) => {
			const { ethers, network } = hre
			const [deployer, second] = await ethers.getSigners()

			const cTokenAddress =
				args.cToken ?? getDeployment(network.name, 'ConfidentialERC20')
			if (!cTokenAddress) {
				throw new Error(
					`No cToken address — pass --c-token or deploy ConfidentialERC20 first on ${network.name}`
				)
			}

			const operatorAddress =
				args.operator ?? (second ? second.address : deployer.address)

			console.log(`Deploying ConfidentialBridge on ${network.name}`)
			console.log(`  cToken      : ${cTokenAddress}`)
			console.log(`  operator    : ${operatorAddress}`)
			console.log(`  peerChainId : ${args.peerChainId}`)

			const Bridge = await ethers.getContractFactory('ConfidentialBridge')
			const bridge = await Bridge.connect(deployer).deploy(
				cTokenAddress,
				operatorAddress,
				args.peerChainId
			)
			await bridge.waitForDeployment()
			const addr = await bridge.getAddress()
			saveDeployment(network.name, 'ConfidentialBridge', addr)
			console.log(`  ConfidentialBridge: ${addr}`)
		}
	)
