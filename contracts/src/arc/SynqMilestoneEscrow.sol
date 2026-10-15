// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Arc} from "./ISafeArc.sol";

/// @title SynqMilestoneEscrow
/// @notice Milestone escrow for one ERC-20 (Arc USDC). A payer funds a deal of N milestones for one payee in a
///         single transfer. Each milestone moves exactly once, Funded -> Released -> Withdrawn (to the payee) or
///         Funded -> Refunded (to the original payer). Release conditions:
///         - the payer releases, or the arbiter releases;
///         - the payee withdraws only a released milestone, and funds go only to the deal's payee.
///         Refund conditions:
///         - after `refundAfter`, anyone may trigger the refund of an unreleased, undisputed milestone;
///         - the arbiter, or the payee (voluntarily), may refund any unreleased milestone at any time;
///         - the refund always goes to the deal's original payer, which no one can change.
///         A party may raise a dispute when the deal names an arbiter. That freezes the payer's release and the
///         timeout refund; only the arbiter then settles each funded milestone.
/// @dev Upgrade authority: none. No proxy, no owner, no admin, no pause, no DELEGATECALL, no SELFDESTRUCT; the
///      token is immutable. Every state change precedes its token transfer and every mutating entry point is
///      nonReentrant, so a token hook or a malicious payee cannot re-enter to claim twice.
contract SynqMilestoneEscrow {
    /// @notice Statement of who can change this contract's code.
    string public constant UPGRADE_AUTHORITY = "NON_UPGRADEABLE_NO_ADMIN";
    /// @notice Maximum milestones per deal.
    uint256 public constant MAX_MILESTONES = 32;

    enum Status {
        None,
        Funded,
        Released,
        Withdrawn,
        Refunded
    }

    struct Deal {
        address payer;
        address payee;
        address arbiter;
        uint64 refundAfter;
        bool disputed;
        uint8 milestoneCount;
        bytes32 termsHash;
    }

    struct Milestone {
        uint128 amount;
        Status status;
    }

    /// @notice Escrowed asset.
    address public immutable token;
    /// @notice Number of deals opened (also the next deal's id minus one).
    uint256 public dealCount;
    /// @notice Sum of Funded and Released (not yet withdrawn) milestones; equals the escrow's liability.
    uint256 public totalLiability;

    mapping(uint256 => Deal) private _deals;
    mapping(uint256 => mapping(uint256 => Milestone)) private _milestones;
    uint256 private _lock = 1;

    event DealOpened(
        uint256 indexed dealId,
        address indexed payer,
        address indexed payee,
        address arbiter,
        bytes32 termsHash,
        uint256 total,
        uint64 refundAfter
    );
    event MilestoneReleased(uint256 indexed dealId, uint256 indexed milestone, address indexed by, uint256 amount);
    event MilestoneWithdrawn(uint256 indexed dealId, uint256 indexed milestone, address indexed payee, uint256 amount);
    event MilestoneRefunded(uint256 indexed dealId, uint256 indexed milestone, address indexed payer, uint256 amount);
    event Disputed(uint256 indexed dealId, address indexed by);

    error InvalidDeal();
    error InvalidAmount();
    error UnknownDeal(uint256 dealId);
    error UnknownMilestone(uint256 dealId, uint256 milestone);
    error WrongStatus(Status status);
    error NotAuthorized(address caller);
    error RefundNotYetAllowed(uint64 refundAfter);
    error DealDisputed();
    error NoArbiter();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param token_ Escrowed ERC-20.
    constructor(address token_) {
        if (token_.code.length == 0) revert InvalidDeal();
        token = token_;
    }

    // ------------------------------------------------------------------ views

    function deal(uint256 dealId) external view returns (Deal memory) {
        return _deals[dealId];
    }

    function milestone(uint256 dealId, uint256 index) external view returns (Milestone memory) {
        return _milestones[dealId][index];
    }

    // ------------------------------------------------------------------ lifecycle

    /// @notice Opens and funds a deal; pulls the milestone total from the caller (who becomes the payer).
    /// @param payee Recipient of released milestones.
    /// @param arbiter Optional dispute arbiter (zero: no disputes).
    /// @param refundAfter Time after which unreleased, undisputed milestones are refundable by anyone.
    /// @param termsHash Hash of the signed agreement version.
    /// @param amounts Milestone amounts in token base units.
    function open(address payee, address arbiter, uint64 refundAfter, bytes32 termsHash, uint128[] calldata amounts)
        external
        nonReentrant
        returns (uint256 dealId)
    {
        uint256 n = amounts.length;
        if (
            payee == address(0) || payee == msg.sender || payee == address(this) || arbiter == msg.sender
                || arbiter == payee || arbiter == address(this) || n == 0 || n > MAX_MILESTONES
                || refundAfter <= block.timestamp
        ) revert InvalidDeal();
        dealId = ++dealCount;
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) revert InvalidAmount();
            total += amounts[i];
            _milestones[dealId][i] = Milestone({amount: amounts[i], status: Status.Funded});
        }
        _deals[dealId] = Deal({
            payer: msg.sender,
            payee: payee,
            arbiter: arbiter,
            refundAfter: refundAfter,
            disputed: false,
            milestoneCount: uint8(n),
            termsHash: termsHash
        });
        totalLiability += total;
        uint256 before = IERC20Arc(token).balanceOf(address(this));
        _call(abi.encodeCall(IERC20Arc.transferFrom, (msg.sender, address(this), total)));
        // Fee-on-transfer or otherwise short deliveries are refused: the escrow must hold what it owes.
        if (IERC20Arc(token).balanceOf(address(this)) - before != total) revert InvalidAmount();
        emit DealOpened(dealId, msg.sender, payee, arbiter, termsHash, total, refundAfter);
    }

    /// @notice Releases a funded milestone to the payee's withdrawable balance (payer, or arbiter).
    function release(uint256 dealId, uint256 index) external nonReentrant {
        Deal storage d = _deal(dealId);
        Milestone storage m = _milestone(dealId, index);
        if (m.status != Status.Funded) revert WrongStatus(m.status);
        bool byArbiter = d.arbiter != address(0) && msg.sender == d.arbiter;
        if (!byArbiter) {
            if (msg.sender != d.payer) revert NotAuthorized(msg.sender);
            if (d.disputed) revert DealDisputed();
        }
        m.status = Status.Released;
        emit MilestoneReleased(dealId, index, msg.sender, m.amount);
    }

    /// @notice Pays a released milestone to the deal's payee (anyone may trigger; funds go only to the payee).
    function withdraw(uint256 dealId, uint256 index) external nonReentrant {
        Deal storage d = _deal(dealId);
        Milestone storage m = _milestone(dealId, index);
        if (m.status != Status.Released) revert WrongStatus(m.status);
        m.status = Status.Withdrawn;
        uint256 amount = m.amount;
        totalLiability -= amount;
        address payee = d.payee;
        _call(abi.encodeCall(IERC20Arc.transfer, (payee, amount)));
        emit MilestoneWithdrawn(dealId, index, payee, amount);
    }

    /// @notice Refunds an unreleased milestone to the deal's original payer, once.
    function refund(uint256 dealId, uint256 index) external nonReentrant {
        Deal storage d = _deal(dealId);
        Milestone storage m = _milestone(dealId, index);
        if (m.status != Status.Funded) revert WrongStatus(m.status);
        bool privileged = msg.sender == d.payee || (d.arbiter != address(0) && msg.sender == d.arbiter);
        if (!privileged) {
            if (block.timestamp < d.refundAfter) revert RefundNotYetAllowed(d.refundAfter);
            if (d.disputed) revert DealDisputed();
        }
        m.status = Status.Refunded;
        uint256 amount = m.amount;
        totalLiability -= amount;
        address payer = d.payer;
        _call(abi.encodeCall(IERC20Arc.transfer, (payer, amount)));
        emit MilestoneRefunded(dealId, index, payer, amount);
    }

    /// @notice Freezes payer release and timeout refunds; the arbiter settles. Payer or payee, deal with arbiter.
    function dispute(uint256 dealId) external {
        Deal storage d = _deal(dealId);
        if (d.arbiter == address(0)) revert NoArbiter();
        if (msg.sender != d.payer && msg.sender != d.payee) revert NotAuthorized(msg.sender);
        d.disputed = true;
        emit Disputed(dealId, msg.sender);
    }

    // ------------------------------------------------------------------ internal

    function _deal(uint256 dealId) private view returns (Deal storage d) {
        d = _deals[dealId];
        if (d.payer == address(0)) revert UnknownDeal(dealId);
    }

    function _milestone(uint256 dealId, uint256 index) private view returns (Milestone storage m) {
        if (index >= _deals[dealId].milestoneCount) revert UnknownMilestone(dealId, index);
        m = _milestones[dealId][index];
    }

    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
