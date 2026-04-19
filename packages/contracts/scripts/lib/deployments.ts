import fs from 'fs'
import path from 'path'

export type Stack = {
	usdc: string
	cToken: string
	bridge: string
}

const DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', 'deployments')

export function loadStack(network: string): Stack {
	const file = path.join(DEPLOYMENTS_DIR, `${network}.json`)
	if (!fs.existsSync(file)) {
		throw new Error(
			`No deployments file at ${file}. Run \`pnpm hardhat deploy-stack --peer-chain-id <N> --network ${network}\` first.`
		)
	}
	const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
	const required = ['MockUSDC', 'ConfidentialERC20', 'ConfidentialBridge'] as const
	for (const key of required) {
		if (!raw[key]) {
			throw new Error(`${file} is missing ${key}. Re-run deploy-stack on ${network}.`)
		}
	}
	return {
		usdc: raw.MockUSDC,
		cToken: raw.ConfidentialERC20,
		bridge: raw.ConfidentialBridge,
	}
}
