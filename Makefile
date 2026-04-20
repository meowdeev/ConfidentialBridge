# ConfidentialBridge — full pipeline from install to live two-chain bridge.
#
#   make            # show available targets
#   make all        # install → env → compile → test → deploy → e2e
#   make operator   # run the relay daemon (long-running)
#
# `make all` walks the full path. The only manual step is editing .env after
# the env target creates it from the example.

ENV_FILE          := packages/contracts/.env
ENV_EXAMPLE       := packages/contracts/.env.example
DEPLOY_ETH        := packages/contracts/deployments/eth-sepolia.json
DEPLOY_ARB        := packages/contracts/deployments/arb-sepolia.json
ETH_PEER_CHAIN_ID := 421614     # arb-sepolia
ARB_PEER_CHAIN_ID := 11155111   # eth-sepolia

# Bake colours into headings so progress is easy to scan.
BOLD  := \033[1m
GREEN := \033[32m
RED   := \033[31m
RESET := \033[0m

.DEFAULT_GOAL := help

.PHONY: help all install env env-check compile test \
        deploy deploy-eth deploy-arb \
        e2e e2e-single operator clean

help:  ## Show this help
	@printf "$(BOLD)ConfidentialBridge — Make targets$(RESET)\n\n"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-14s$(RESET) %s\n", $$1, $$2}'
	@printf "\nTypical first run:  $(BOLD)make all$(RESET)\n"

## ── 1. Install ──────────────────────────────────────────────

install:  ## Install pnpm dependencies
	@printf "$(BOLD)→ Installing dependencies$(RESET)\n"
	pnpm install
	@printf "$(GREEN)✓ install complete$(RESET)\n\n"

## ── 2. Env file (manual edit required after first creation) ──

env:  ## Create .env from .env.example if missing (you must then edit it)
	@if [ ! -f $(ENV_FILE) ]; then \
		cp $(ENV_EXAMPLE) $(ENV_FILE); \
		printf "$(BOLD)→ Created $(ENV_FILE) from example.$(RESET)\n"; \
		printf "$(RED)  Edit it now and set:$(RESET)\n"; \
		printf "    PRIVATE_KEY              (buyer wallet, needs ETH on both chains)\n"; \
		printf "    OBSERVER_PRIVATE_KEY     (operator wallet, needs ETH on both chains)\n"; \
		printf "    SEPOLIA_RPC_URL          (Eth-Sepolia RPC; default works for dev)\n"; \
		printf "    ARBITRUM_SEPOLIA_RPC_URL (Arb-Sepolia RPC; default works for dev)\n\n"; \
		printf "  Then re-run $(BOLD)make all$(RESET).\n"; \
		exit 1; \
	else \
		printf "$(GREEN)✓ $(ENV_FILE) already exists$(RESET)\n"; \
	fi

env-check: env  ## Verify required env vars are set (non-empty)
	@set -a; . ./$(ENV_FILE); set +a; \
	missing=""; \
	for k in PRIVATE_KEY OBSERVER_PRIVATE_KEY; do \
		v=$$(eval echo \$$$$k); \
		if [ -z "$$v" ]; then missing="$$missing $$k"; fi; \
	done; \
	if [ -n "$$missing" ]; then \
		printf "$(RED)✗ Missing in $(ENV_FILE):$$missing$(RESET)\n"; \
		exit 1; \
	fi; \
	printf "$(GREEN)✓ env-check passed$(RESET)\n\n"

## ── 3. Compile + test (offline, no chain interaction) ───────

compile:  ## Compile contracts (also generates typechain types)
	@printf "$(BOLD)→ Compiling contracts$(RESET)\n"
	pnpm compile
	@printf "$(GREEN)✓ compile complete$(RESET)\n\n"

test:  ## Run mocha test suite (24 tests vs cofhe-hardhat-plugin mocks)
	@printf "$(BOLD)→ Running tests$(RESET)\n"
	pnpm test
	@printf "$(GREEN)✓ tests passed$(RESET)\n\n"

## ── 4. Deploy stack on each chain ───────────────────────────

deploy-eth: env-check  ## Deploy MockUSDC + cUSDC + bridge on Eth-Sepolia
	@printf "$(BOLD)→ Deploying stack on eth-sepolia (peer = arb-sepolia)$(RESET)\n"
	cd packages/contracts && pnpm exec hardhat deploy-stack \
		--peer-chain-id $(ETH_PEER_CHAIN_ID) --network eth-sepolia
	@printf "$(GREEN)✓ eth-sepolia deployed$(RESET)\n\n"

deploy-arb: env-check  ## Deploy MockUSDC + cUSDC + bridge on Arb-Sepolia
	@printf "$(BOLD)→ Deploying stack on arb-sepolia (peer = eth-sepolia)$(RESET)\n"
	cd packages/contracts && pnpm exec hardhat deploy-stack \
		--peer-chain-id $(ARB_PEER_CHAIN_ID) --network arb-sepolia
	@printf "$(GREEN)✓ arb-sepolia deployed$(RESET)\n\n"

deploy: deploy-eth deploy-arb  ## Deploy stack on both chains

## ── 5. End-to-end (live testnet, real value moving) ─────────

e2e: env-check  ## Run two-chain e2e (Eth-Sepolia → Arb-Sepolia by default)
	@if [ ! -f $(DEPLOY_ETH) ] || [ ! -f $(DEPLOY_ARB) ]; then \
		printf "$(RED)✗ Missing deployments. Run $(BOLD)make deploy$(RESET)$(RED) first.$(RESET)\n"; \
		exit 1; \
	fi
	@printf "$(BOLD)→ Two-chain bridge: eth-sepolia → arb-sepolia$(RESET)\n"
	pnpm e2e:bridge-twochain
	@printf "$(GREEN)✓ e2e complete$(RESET)\n"

e2e-single: env-check  ## Single-chain e2e on Base Sepolia (smoke test, no peer)
	@printf "$(BOLD)→ Single-chain e2e on base-sepolia$(RESET)\n"
	pnpm e2e:bridge

operator: env-check  ## Run the operator daemon (long-running, both directions)
	@if [ ! -f $(DEPLOY_ETH) ] || [ ! -f $(DEPLOY_ARB) ]; then \
		printf "$(RED)✗ Missing deployments. Run $(BOLD)make deploy$(RESET)$(RED) first.$(RESET)\n"; \
		exit 1; \
	fi
	@printf "$(BOLD)→ Starting operator daemon (Ctrl-C to stop)$(RESET)\n"
	pnpm operator

## ── 6. Cleanup ───────────────────────────────────────────────

clean:  ## Remove hardhat artifacts/cache/typechain output
	pnpm --filter @confidential-bridge/contracts clean

## ── all: the full path ──────────────────────────────────────

all: install env-check compile test deploy e2e  ## install → env → compile → test → deploy → e2e
	@printf "\n$(GREEN)$(BOLD)══════════════════════════════════════════$(RESET)\n"
	@printf "$(GREEN)$(BOLD)  ConfidentialBridge — end-to-end live   $(RESET)\n"
	@printf "$(GREEN)$(BOLD)══════════════════════════════════════════$(RESET)\n\n"
	@printf "Next steps:\n"
	@printf "  $(BOLD)make operator$(RESET)   start the relay daemon (long-running, both directions)\n"
	@printf "  $(BOLD)make e2e$(RESET)        run another single bridge transfer\n"
