/**
 * Shared cofhejs setup helpers for plain ethers Wallets (used by the
 * two-chain e2e + operator daemon — the existing `e2e-bridge.ts` uses
 * HardhatEthersSigners and inlines its own version).
 */
import {
	cofhejs,
	FheTypes,
	type AbstractProvider,
	type AbstractSigner,
} from 'cofhejs/node'
import { Wallet, TypedDataField, JsonRpcProvider } from 'ethers'

export function wrapWallet(wallet: Wallet): {
	provider: AbstractProvider
	signer: AbstractSigner
} {
	if (!wallet.provider) throw new Error('wallet has no provider')
	// Concrete provider exposes `send` (JSON-RPC); the base type doesn't.
	const rpc = wallet.provider as JsonRpcProvider
	const provider: AbstractProvider = {
		call: async (...args) => rpc.call(...args),
		getChainId: async () => (await rpc.getNetwork()).chainId.toString(),
		send: async (...args) => rpc.send(...args),
	}
	const signer: AbstractSigner = {
		signTypedData: async (domain, types, value) =>
			wallet.signTypedData(domain, types as Record<string, TypedDataField[]>, value),
		getAddress: async () => wallet.getAddress(),
		provider,
		sendTransaction: async (...args) => {
			const tx = await wallet.sendTransaction(...args)
			return tx.hash
		},
	}
	return { provider, signer }
}

export async function initCofhe(wallet: Wallet) {
	const { provider, signer } = wrapWallet(wallet)
	const result = await cofhejs.initialize({
		provider,
		signer,
		environment: 'TESTNET',
	})
	if (result.error) throw new Error(`cofhejs init failed: ${JSON.stringify(result.error)}`)
	return result.data
}

export async function tryUnseal<T extends bigint>(
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
