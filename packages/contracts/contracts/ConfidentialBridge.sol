// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./ConfidentialERC20.sol";

/// @title ConfidentialBridge (v2, trusted operator, encrypted reserve)
/// @notice Symmetric bridge for a `ConfidentialERC20` between two CoFHE-live
///         chains. One instance per chain, pointing at its peer. A single
///         trusted `operator` EOA serves as the message layer: it watches
///         `BridgeOut` events on the source, unseals the debit handle
///         off-chain via `cofhejs.unseal`, then submits the plaintext
///         re-encrypted under cofhejs as an `InEuint64` to the peer's
///         `bridgeIn`.
///
///         v2 privacy model: the *amount* stays encrypted on both chains.
///         The operator sees plaintext off-chain at the crossing point, but
///         no event or state read ever exposes the bridged amount to
///         third-party observers. The only plaintext-in-calldata ops are
///         `seedLiquidity` and `drainReserve` — rebalancing admin actions
///         that are inherently public because their underlying-token legs
///         are observable anyway.
///
/// @dev v1 emitted `plainAmount` in `BridgeOutAcked` / `BridgeIn` and kept a
///      public `uint64 plainReserve`, which defeated the confidentiality
///      goal. v2 replaces both: `encReserve` is an `euint64` (ACL'd to the
///      operator), acks homomorphically fold the stored outbound handle
///      into it, and bridgeIn takes an `InEuint64` and silent-clamps
///      against the encrypted reserve — matching ERC-7984 semantics.
contract ConfidentialBridge {
    using SafeERC20 for IERC20;

    ConfidentialERC20 public immutable cToken;
    address public immutable operator;
    /// @dev Informational only (the operator enforces peer identity
    ///      off-chain). Kept so the contract self-documents its topology.
    uint256 public immutable peerChainId;

    struct Outbound {
        address sender;
        address destRecipient;
        euint64 encAmount;
        bool operatorAcked;
    }

    mapping(uint256 => Outbound) public outbound;
    uint256 public nextOutboundId;

    /// @dev Replay guard for inbound deliveries, keyed by peer's outbound id.
    mapping(uint256 => bool) public inboundSettled;

    /// @notice Encrypted reserve. Grows on `seedLiquidity` and on every
    ///         `ackOutbound` (folding the stored outbound's encrypted
    ///         amount in homomorphically). Shrinks on `bridgeIn` (silent-
    ///         clamped against itself) and `drainReserve`.
    ///
    ///         Only the operator has decrypt ACL, so only they can see the
    ///         absolute value. Deltas from seed/drain leak through plaintext
    ///         calldata but that's inherent to those admin ops.
    euint64 public encReserve;

    event BridgeOut(
        uint256 indexed outboundId,
        address indexed sender,
        address indexed destRecipient,
        uint256 encAmountHandle
    );
    /// @dev No `plainAmount` — that was the v1 leak. Off-chain listeners
    ///      key off `outboundId` and cross-reference `outbound[id].encAmount`
    ///      if they need the handle.
    event BridgeOutAcked(uint256 indexed outboundId);
    event BridgeIn(
        uint256 indexed peerOutboundId,
        address indexed recipient,
        uint256 encAmountHandle
    );
    event ReserveSeeded(uint64 amount);
    event ReserveDrained(address indexed to, uint64 amount);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(
        ConfidentialERC20 _cToken,
        address _operator,
        uint256 _peerChainId
    ) {
        require(_operator != address(0), "operator=0");
        cToken = _cToken;
        operator = _operator;
        peerChainId = _peerChainId;

        encReserve = FHE.asEuint64(0);
        FHE.allowThis(encReserve);
        FHE.allow(encReserve, _operator);
    }

    // ───── outbound (source side) ────────────────────────────────────────

    /// @notice Bridge the caller's pre-approved cToken allowance on this
    ///         chain to `destRecipient` on the peer.
    ///
    ///         Caller must have first called
    ///         `cToken.approve(bridge, encAmount)` with the exact encrypted
    ///         amount to bridge. The bridge pulls that allowance
    ///         (clamp-by-balance inside cToken) — no fresh `InEuint64`
    ///         crosses this call, which dodges the zkv-signature-binding
    ///         issue where signatures bound to the user's `msg.sender`
    ///         would re-verify under the bridge's `msg.sender` inside
    ///         `cToken.transferFrom`.
    function bridgeOut(address destRecipient) external returns (uint256 outboundId) {
        require(destRecipient != address(0), "recipient=0");

        euint64 moved = cToken.transferFromAllowance(msg.sender, address(this));
        FHE.allowThis(moved);
        FHE.allow(moved, operator);

        outboundId = nextOutboundId++;
        outbound[outboundId] = Outbound({
            sender: msg.sender,
            destRecipient: destRecipient,
            encAmount: moved,
            operatorAcked: false
        });

        emit BridgeOut(outboundId, msg.sender, destRecipient, euint64.unwrap(moved));
    }

    /// @notice Operator pins the outbound and grows the encrypted local
    ///         reserve by the stored `encAmount` — no plaintext in
    ///         calldata, no plaintext in the event. The homomorphic add
    ///         keeps reserve balance in lockstep with what actually moved
    ///         into the bridge on `bridgeOut`.
    function ackOutbound(uint256 outboundId) external onlyOperator {
        Outbound storage o = outbound[outboundId];
        require(o.sender != address(0), "unknown outbound");
        require(!o.operatorAcked, "already acked");
        o.operatorAcked = true;

        encReserve = FHE.add(encReserve, o.encAmount);
        FHE.allowThis(encReserve);
        FHE.allow(encReserve, operator);

        emit BridgeOutAcked(outboundId);
    }

    // ───── inbound (destination side) ────────────────────────────────────

    /// @notice Operator delivers a peer-side outbound by crediting
    ///         `recipient` with the encrypted `encAmount` from this
    ///         bridge's reserves. Idempotent via `inboundSettled`. Silent-
    ///         clamps against `encReserve` (ERC-7984 semantics) — if the
    ///         reserve is short, zero transfers but the replay flag still
    ///         trips. Operator is responsible for checking reserve
    ///         sufficiency off-chain (they have the ACL) before submitting.
    ///
    ///         `encAmount` must be signed by the operator for their own
    ///         `msg.sender`; cofhejs handles that when the operator runs
    ///         `cofhejs.encrypt(plain)` after unsealing the source-side
    ///         handle.
    function bridgeIn(
        uint256 peerOutboundId,
        address recipient,
        InEuint64 calldata encAmount
    ) external onlyOperator {
        require(!inboundSettled[peerOutboundId], "already settled");
        require(recipient != address(0), "recipient=0");

        inboundSettled[peerOutboundId] = true;

        euint64 requested = FHE.asEuint64(encAmount);
        ebool ok = FHE.gte(encReserve, requested);
        euint64 actual = FHE.select(ok, requested, FHE.asEuint64(0));

        encReserve = FHE.sub(encReserve, actual);
        FHE.allowThis(encReserve);
        FHE.allow(encReserve, operator);

        FHE.allowThis(actual);
        FHE.allowTransient(actual, address(cToken));
        cToken.transferEncrypted(recipient, actual);

        emit BridgeIn(peerOutboundId, recipient, euint64.unwrap(actual));
    }

    // ───── liquidity management ──────────────────────────────────────────

    /// @notice Operator pulls underlying from themselves, wraps it into
    ///         cToken held by this bridge, and credits the encrypted
    ///         reserve. Seed amount is plaintext — the underlying-ERC20
    ///         leg is already public, so there's nothing to hide here.
    function seedLiquidity(uint64 amount) external onlyOperator {
        IERC20 u = cToken.underlying();
        u.safeTransferFrom(msg.sender, address(this), amount);
        u.forceApprove(address(cToken), amount);
        cToken.wrap(amount);

        encReserve = FHE.add(encReserve, FHE.asEuint64(amount));
        FHE.allowThis(encReserve);
        FHE.allow(encReserve, operator);

        emit ReserveSeeded(amount);
    }

    /// @notice Operator drains `amount` of reserve to `to` as cToken.
    ///         Silent-clamped against `encReserve` (see `bridgeIn` for
    ///         rationale): if the reserve is short, zero moves rather
    ///         than corrupting the encrypted counter via underflow. The
    ///         receiving side can unwrap on its own — exists so the
    ///         bridge can be rebalanced across chains (e.g. via CCTP).
    function drainReserve(address to, uint64 amount) external onlyOperator {
        require(to != address(0), "to=0");

        euint64 requested = FHE.asEuint64(amount);
        ebool ok = FHE.gte(encReserve, requested);
        euint64 actual = FHE.select(ok, requested, FHE.asEuint64(0));

        encReserve = FHE.sub(encReserve, actual);
        FHE.allowThis(encReserve);
        FHE.allow(encReserve, operator);

        FHE.allowThis(actual);
        FHE.allowTransient(actual, address(cToken));
        cToken.transferEncrypted(to, actual);

        emit ReserveDrained(to, amount);
    }
}
