// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./ConfidentialERC20.sol";

/// @title ConfidentialBridge (v1, trusted operator)
/// @notice Symmetric bridge for a `ConfidentialERC20` between two CoFHE-live
///         chains (e.g. Eth Sepolia ↔ Arb Sepolia). Deploy one instance per
///         chain, pointing at its peer. A single trusted `operator` EOA
///         serves as the message layer: it watches `BridgeOut` events on
///         the source, unseals the debit handle off-chain via
///         `cofhejs.unseal`, and submits the plaintext to the peer's
///         `bridgeIn`.
///
///         Trust model matches `ConfidentialERC20.unwrapper` — the operator
///         sees plaintext at the crossing point; everything before and
///         after stays encrypted on-chain.
///
/// @dev V2 will replace `onlyOperator` on `bridgeIn` with verification
///      against a messaging layer (CCTP / LayerZero / Hyperlane) and add
///      timeout-based refunds on the source side.
contract ConfidentialBridge {
    using SafeERC20 for IERC20;

    ConfidentialERC20 public immutable cToken;
    address public immutable operator;
    /// @dev Informational only in v1 (the operator enforces peer identity
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

    /// @notice Plaintext reserve accounting. Grows when the operator wraps
    ///         underlying via `seedLiquidity` and when they ack an outbound
    ///         (pinning the user's bridged-out plaintext so future
    ///         `bridgeIn` calls can pay it out). Shrinks on `bridgeIn` and
    ///         `drainReserve`.
    ///
    ///         `bridgeIn` is gated by this counter so an empty reserve
    ///         fails loudly instead of silently transferring 0 — the one
    ///         place the underlying cToken's clamp-on-insufficient
    ///         semantics would be user-hostile (replay flag already set).
    uint64 public plainReserve;

    event BridgeOut(
        uint256 indexed outboundId,
        address indexed sender,
        address indexed destRecipient,
        uint256 encAmountHandle
    );
    event BridgeOutAcked(uint256 indexed outboundId, uint64 plainAmount);
    event BridgeIn(
        uint256 indexed peerOutboundId,
        address indexed recipient,
        uint64 plainAmount
    );
    event ReserveSeeded(uint64 amount, uint64 newReserve);
    event ReserveDrained(address indexed to, uint64 amount, uint64 newReserve);

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

    /// @notice Operator pins the plaintext of an outbound and credits the
    ///         local `plainReserve` so this side can pay out future
    ///         `bridgeIn` deliveries from the peer (self-balancing
    ///         round-trips). The value is trusted — operator already sees
    ///         the plaintext via its decrypt ACL.
    function ackOutbound(uint256 outboundId, uint64 plainAmount)
        external
        onlyOperator
    {
        Outbound storage o = outbound[outboundId];
        require(o.sender != address(0), "unknown outbound");
        require(!o.operatorAcked, "already acked");
        o.operatorAcked = true;
        plainReserve += plainAmount;
        emit BridgeOutAcked(outboundId, plainAmount);
    }

    // ───── inbound (destination side) ────────────────────────────────────

    /// @notice Operator delivers a peer-side outbound by crediting
    ///         `recipient` with `plainAmount` cToken from this bridge's
    ///         reserves. Idempotent via `inboundSettled`. Reverts if the
    ///         plaintext reserve is insufficient — this is the loud-fail
    ///         replacement for cToken's silent-clamp behaviour.
    function bridgeIn(
        uint256 peerOutboundId,
        address recipient,
        uint64 plainAmount
    ) external onlyOperator {
        require(!inboundSettled[peerOutboundId], "already settled");
        require(recipient != address(0), "recipient=0");
        require(plainAmount <= plainReserve, "reserve empty");

        inboundSettled[peerOutboundId] = true;
        plainReserve -= plainAmount;

        if (plainAmount > 0) {
            euint64 enc = FHE.asEuint64(plainAmount);
            FHE.allowThis(enc);
            FHE.allowTransient(enc, address(cToken));
            cToken.transferEncrypted(recipient, enc);
        }

        emit BridgeIn(peerOutboundId, recipient, plainAmount);
    }

    // ───── liquidity management ──────────────────────────────────────────

    /// @notice Operator pulls underlying from themselves, wraps it into
    ///         cToken held by this bridge, and credits plaintext reserve.
    function seedLiquidity(uint64 amount) external onlyOperator {
        IERC20 u = cToken.underlying();
        u.safeTransferFrom(msg.sender, address(this), amount);
        u.forceApprove(address(cToken), amount);
        cToken.wrap(amount);
        plainReserve += amount;
        emit ReserveSeeded(amount, plainReserve);
    }

    /// @notice Operator drains `amount` of reserve out to `to` as cToken.
    ///         The recipient can unwrap on their own. Exists so the bridge
    ///         can be rebalanced across chains (e.g. via CCTP). Amount is
    ///         plaintext because the operator already sees reserve values
    ///         and rebalancing is a public admin action.
    function drainReserve(address to, uint64 amount) external onlyOperator {
        require(to != address(0), "to=0");
        require(amount <= plainReserve, "reserve empty");
        plainReserve -= amount;

        euint64 enc = FHE.asEuint64(amount);
        FHE.allowThis(enc);
        FHE.allowTransient(enc, address(cToken));
        cToken.transferEncrypted(to, enc);

        emit ReserveDrained(to, amount, plainReserve);
    }
}
