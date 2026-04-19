import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@nomicfoundation/hardhat-ethers'
import 'cofhe-hardhat-plugin'
import * as dotenv from 'dotenv'
import './tasks'

dotenv.config()

// Both signers go to every CoFHE network. Buyer = signers[0], operator = signers[1].
// Operator doubles as the cUSDC unwrapper and the bridge's onlyOperator EOA.
const accounts = [process.env.PRIVATE_KEY, process.env.OBSERVER_PRIVATE_KEY].filter(Boolean) as string[]

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.25',
		settings: {
			evmVersion: 'cancun',
		},
	},
	defaultNetwork: 'base-sepolia',
	networks: {
		'base-sepolia': {
			url: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
			accounts,
			chainId: 84532,
			gasMultiplier: 1.2,
			timeout: 60000,
		},
		'eth-sepolia': {
			url: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com',
			accounts,
			chainId: 11155111,
			gasMultiplier: 1.2,
			timeout: 60000,
		},
		'arb-sepolia': {
			url: process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
			accounts,
			chainId: 421614,
			gasMultiplier: 1.2,
			timeout: 60000,
		},
	},
	etherscan: {
		apiKey: process.env.BASESCAN_API_KEY || '',
	},
}

export default config
