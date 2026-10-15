// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafeArc, IERC20Arc} from "./ISafeArc.sol";

/// @title SynqArcVaultPolicy
/// @notice Safe v1.4.1 transaction guard and module for one Synq group vault on Arc. The Safe's owners keep custody
///         (M-of-N EIP-712 signatures and the Safe nonce). This contract adds four controls on top:
///         1. Governance timelock. Every Safe self-call (owners, threshold, modules, guard, fallback handler), every
///            DELEGATECALL (the only way to change the Safe singleton) and every operator-scope expansion must first
///            be queued by an owner-quorum transaction, then waits `delay` before an owner-quorum transaction can
///            execute it, once, inside GRACE_PERIOD.
///         2. Scoped operator. One operator address may pay allowlisted recipients in `token` only, up to a
///            per-payment and a rolling 24h cap. It has no other entry point and cannot change governance.
///         3. Guardian pause. The guardian can freeze outflows (owner-quorum outflows and operator payments) for at
///            most MAX_PAUSE, then must wait PAUSE_COOLDOWN before pausing again. It cannot move funds, change owners
///            or block timelocked governance recovery. The owner quorum can lift a pause or replace the guardian only
///            through the timelock, so a stolen quorum cannot undo a pause for min(MAX_PAUSE, delay).
///         4. Atomic transactions. Safe gas refunds (gasPrice) and non-zero safeTxGas are rejected, so a failed inner
///            call always reverts the whole Safe transaction and cannot consume a queued operation.
/// @dev Upgrade authority: none. This contract has no proxy, no admin, no DELEGATECALL and no SELFDESTRUCT; its
///      parameters `token`, `delay` and `safe` are immutable or write-once. The only way to change the vault's
///      code is a timelocked owner-quorum transaction: setGuard / enableModule / disableModule to swap this
///      policy, or a DELEGATECALL migration to change the Safe singleton. See UPGRADE_AUTHORITY.
contract SynqArcVaultPolicy {
    /// @notice Human-readable statement of who can change code, checked by tests so it cannot silently drift.
    string public constant UPGRADE_AUTHORITY =
        "NON_UPGRADEABLE_POLICY; SAFE_CODE_AND_POLICY_SWAP_ONLY_BY_OWNER_QUORUM_AFTER_TIMELOCK";
    /// @notice Minimum governance delay.
    uint256 public constant MIN_DELAY = 1 hours;
    /// @notice Maximum governance delay.
    uint256 public constant MAX_DELAY = 30 days;
    /// @notice A queued operation must execute within this window after its eta.
    uint256 public constant GRACE_PERIOD = 14 days;
    /// @notice Longest freeze a single guardian pause can impose.
    uint256 public constant MAX_PAUSE = 7 days;
    /// @notice Operator spend window.
    uint256 public constant WINDOW = 1 days;
    /// @notice After a pause ends (expiry or unpause) the guardian must wait this long before pausing again.
    uint256 public constant PAUSE_COOLDOWN = 2 days;

    uint8 internal constant OP_CALL = 0;
    uint8 internal constant OP_DELEGATECALL = 1;
    bytes4 internal constant SET_GUARD = bytes4(keccak256("setGuard(address)"));

    /// @notice Factory that deployed this policy and binds it to its Safe once.
    address public immutable factory;
    /// @notice The only asset the operator may pay (Arc USDC ERC-20 interface, 6 decimals).
    address public immutable token;
    /// @notice Governance timelock delay in seconds (immutable; changing it means a timelocked policy swap).
    uint256 public immutable delay;

    /// @notice The Safe this policy guards (write-once by `factory`).
    address public safe;
    /// @notice Address allowed to pause outflows.
    address public guardian;
    /// @notice Outflows are frozen while block.timestamp < pausedUntil.
    uint64 public pausedUntil;
    /// @notice Scoped executor (may be zero).
    address public operator;
    /// @notice Operator per-payment cap in token base units.
    uint256 public perPaymentCap;
    /// @notice Operator rolling-window cap in token base units.
    uint256 public windowCap;
    /// @notice Operator spend inside the current window.
    uint256 public windowSpent;
    /// @notice Start of the current operator window.
    uint64 public windowStart;
    /// @notice Recipients the operator may pay.
    mapping(address => bool) public isRecipient;
    /// @notice Queued operation id => earliest execution time (0 = not queued).
    mapping(bytes32 => uint256) public eta;

    uint256 private _lock = 1;

    event Bound(address indexed safe, address indexed token, uint256 delay);
    event OperationQueued(
        bytes32 indexed id, address indexed to, uint256 value, uint8 operation, bytes data, uint256 eta
    );
    event OperationCancelled(bytes32 indexed id);
    event OperationExecuted(bytes32 indexed id, address indexed to, uint8 operation);
    event GuardianChanged(address indexed previous, address indexed guardian);
    event Paused(address indexed guardian, uint64 until);
    event Unpaused(address indexed by);
    event OperatorChanged(address indexed previous, address indexed operator);
    event RecipientSet(address indexed recipient, bool allowed);
    event CapsChanged(uint256 perPaymentCap, uint256 windowCap);
    event OperatorPaid(
        bytes32 indexed ref, address indexed operator, address indexed recipient, address token, uint256 amount
    );

    error NotFactory();
    error AlreadyBound();
    error NotSafe();
    error NotGuardian();
    error NotOperator();
    error InvalidDelay();
    error InvalidAddress(address value);
    error AlreadyQueued(bytes32 id);
    error NotQueued(bytes32 id);
    error NotReady(bytes32 id, uint256 eta);
    error Expired(bytes32 id);
    error RefundsDisabled();
    error OutflowsPaused();
    error RecipientNotAllowed(address recipient);
    error CapExceeded(uint256 amount, uint256 cap);
    error ZeroAmount();
    error PaymentFailed();
    error Reentrancy();
    error PauseCooldown(uint256 availableAt);
    error InvalidReplacement(address guard);

    modifier onlySafe() {
        if (msg.sender != safe || safe == address(0)) revert NotSafe();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param token_ Payable asset (non-zero contract).
    /// @param delay_ Governance delay, MIN_DELAY..MAX_DELAY.
    /// @param guardian_ Pause guardian (may be zero: no pause).
    /// @param operator_ Scoped executor (may be zero).
    /// @param recipients_ Initial operator allowlist.
    /// @param perPaymentCap_ Initial per-payment cap.
    /// @param windowCap_ Initial 24h cap.
    constructor(
        address token_,
        uint256 delay_,
        address guardian_,
        address operator_,
        address[] memory recipients_,
        uint256 perPaymentCap_,
        uint256 windowCap_
    ) {
        if (token_.code.length == 0) revert InvalidAddress(token_);
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert InvalidDelay();
        if (operator_ != address(0) && operator_ == guardian_) revert InvalidAddress(operator_);
        factory = msg.sender;
        token = token_;
        delay = delay_;
        guardian = guardian_;
        operator = operator_;
        for (uint256 i; i < recipients_.length; ++i) {
            _checkRecipient(recipients_[i]);
            isRecipient[recipients_[i]] = true;
            emit RecipientSet(recipients_[i], true);
        }
        perPaymentCap = perPaymentCap_;
        windowCap = windowCap_;
        emit GuardianChanged(address(0), guardian_);
        emit OperatorChanged(address(0), operator_);
        emit CapsChanged(perPaymentCap_, windowCap_);
    }

    /// @notice Binds the Safe once; called by the factory in the creating transaction.
    /// @param safe_ Safe proxy that enabled this contract as module and guard during setup.
    function bind(address safe_) external {
        if (msg.sender != factory) revert NotFactory();
        if (safe != address(0)) revert AlreadyBound();
        if (safe_ == address(0) || safe_ == operator || safe_ == guardian) revert InvalidAddress(safe_);
        if (isRecipient[safe_]) revert InvalidAddress(safe_);
        safe = safe_;
        emit Bound(safe_, token, delay);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether outflows are frozen.
    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    /// @notice Id of a governed Safe operation.
    function operationId(address to, uint256 value, bytes calldata data, uint8 operation)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(to, value, keccak256(data), operation));
    }

    /// @notice Whether a Safe transaction needs the governance timelock.
    /// @dev Governed: any DELEGATECALL, any call to the Safe itself, and any call to this policy except the
    ///      instant, scope-reducing selectors (queue, cancel, revokeOperator, removeRecipient). Owner-initiated
    ///      unpause and setGuardian are governed: they run after the delay, also while paused.
    function isGoverned(address to, bytes calldata data, uint8 operation) public view returns (bool) {
        if (operation != OP_CALL) return true;
        if (to == safe) return true;
        if (to == address(this)) return !_isInstant(data);
        return false;
    }

    /// @notice ERC-165: Safe v1.4.1 Guard (0xe6d7a83a) and ERC-165 itself.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0xe6d7a83a || interfaceId == 0x01ffc9a7;
    }

    // ------------------------------------------------------------------ Safe guard

    /// @notice Safe v1.4.1 Guard hook, called by the Safe before every owner-signed transaction.
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256, /* baseGas */
        uint256 gasPrice,
        address, /* gasToken */
        address payable, /* refundReceiver */
        bytes calldata, /* signatures */
        address /* msgSender */
    ) external onlySafe {
        if (gasPrice != 0 || safeTxGas != 0) revert RefundsDisabled();
        if (isGoverned(to, data, operation)) {
            // Delegatecalls are opaque and may move funds: frozen while paused. Governance self-calls (owner
            // recovery, guard or module changes) and policy calls stay available to the quorum during a pause.
            if (operation != OP_CALL && paused()) revert OutflowsPaused();
            if (to == safe && value != 0 && paused()) revert OutflowsPaused();
            if (to == safe && data.length >= 36 && bytes4(data[:4]) == SET_GUARD) _checkReplacement(data);
            bytes32 id = operationId(to, value, data, operation);
            uint256 readyAt = eta[id];
            if (readyAt == 0) revert NotQueued(id);
            if (block.timestamp < readyAt) revert NotReady(id, readyAt);
            if (block.timestamp > readyAt + GRACE_PERIOD) revert Expired(id);
            delete eta[id];
            emit OperationExecuted(id, to, operation);
            return;
        }
        if (paused() && !(to == address(this) && value == 0)) revert OutflowsPaused();
    }

    /// @notice Safe v1.4.1 Guard post-hook (no-op; execution is atomic because safeTxGas and gasPrice are zero).
    function checkAfterExecution(bytes32, bool) external view onlySafe {}

    // ------------------------------------------------------------------ governance (called by the Safe)

    /// @notice Queues a governed operation. Instant (needs the owner quorum, no delay).
    function queue(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        onlySafe
        returns (bytes32 id)
    {
        if (operation > OP_DELEGATECALL) revert InvalidAddress(to);
        id = operationId(to, value, data, operation);
        uint256 previous = eta[id];
        // An expired operation no longer blocks its id.
        if (previous != 0 && block.timestamp <= previous + GRACE_PERIOD) revert AlreadyQueued(id);
        uint256 readyAt = block.timestamp + delay;
        eta[id] = readyAt;
        emit OperationQueued(id, to, value, operation, data, readyAt);
    }

    /// @notice Cancels a queued operation. Instant.
    function cancel(bytes32 id) external onlySafe {
        if (eta[id] == 0) revert NotQueued(id);
        delete eta[id];
        emit OperationCancelled(id);
    }

    /// @notice Replaces the guardian. Timelocked (runs while paused, so a rogue guardian is replaced after `delay`).
    function setGuardian(address guardian_) external onlySafe {
        if (guardian_ == operator && guardian_ != address(0)) revert InvalidAddress(guardian_);
        emit GuardianChanged(guardian, guardian_);
        guardian = guardian_;
    }

    /// @notice Removes the operator. Instant (scope reduction).
    function revokeOperator() external onlySafe {
        emit OperatorChanged(operator, address(0));
        operator = address(0);
    }

    /// @notice Removes a recipient from the operator allowlist. Instant (scope reduction).
    function removeRecipient(address recipient) external onlySafe {
        isRecipient[recipient] = false;
        emit RecipientSet(recipient, false);
    }

    /// @notice Sets the operator. Timelocked (scope change).
    function setOperator(address operator_) external onlySafe {
        if (operator_ == safe || operator_ == address(this) || operator_ == guardian || isRecipient[operator_]) {
            revert InvalidAddress(operator_);
        }
        if (operator_ != address(0) && ISafeArc(safe).isOwner(operator_)) revert InvalidAddress(operator_);
        emit OperatorChanged(operator, operator_);
        operator = operator_;
    }

    /// @notice Adds a recipient to the operator allowlist. Timelocked (scope expansion).
    function addRecipient(address recipient) external onlySafe {
        _checkRecipient(recipient);
        if (recipient == safe || recipient == operator) revert InvalidAddress(recipient);
        isRecipient[recipient] = true;
        emit RecipientSet(recipient, true);
    }

    /// @notice Sets operator caps. Timelocked.
    function setCaps(uint256 perPaymentCap_, uint256 windowCap_) external onlySafe {
        perPaymentCap = perPaymentCap_;
        windowCap = windowCap_;
        emit CapsChanged(perPaymentCap_, windowCap_);
    }

    // ------------------------------------------------------------------ guardian

    /// @notice Freezes outflows for MAX_PAUSE. Cannot move funds or touch governance, cannot extend a running
    ///         pause, and cannot pause again until PAUSE_COOLDOWN after the previous pause ended.
    function pause() external {
        if (msg.sender != guardian || guardian == address(0)) revert NotGuardian();
        uint256 availableAt = uint256(pausedUntil) + PAUSE_COOLDOWN;
        if (pausedUntil != 0 && block.timestamp < availableAt) revert PauseCooldown(availableAt);
        uint64 until = uint64(block.timestamp + MAX_PAUSE);
        pausedUntil = until;
        emit Paused(msg.sender, until);
    }

    /// @notice Lifts the freeze: the guardian at once, or the owner quorum through the timelock.
    function unpause() external {
        if (msg.sender != guardian && (msg.sender != safe || safe == address(0))) revert NotGuardian();
        // The cooldown runs from now.
        if (paused()) pausedUntil = uint64(block.timestamp);
        emit Unpaused(msg.sender);
    }

    // ------------------------------------------------------------------ operator

    /// @notice Pays an allowlisted recipient from the Safe within the operator caps.
    /// @param recipient Allowlisted recipient.
    /// @param amount Token base units (6 decimals for Arc USDC).
    /// @param ref Caller reference (invoice / mandate id) for reconciliation.
    function pay(address recipient, uint256 amount, bytes32 ref) external nonReentrant {
        if (msg.sender != operator || operator == address(0)) revert NotOperator();
        if (paused()) revert OutflowsPaused();
        if (!isRecipient[recipient]) revert RecipientNotAllowed(recipient);
        if (amount == 0) revert ZeroAmount();
        if (amount > perPaymentCap) revert CapExceeded(amount, perPaymentCap);
        if (block.timestamp >= uint256(windowStart) + WINDOW) {
            windowStart = uint64(block.timestamp);
            windowSpent = 0;
        }
        uint256 spent = windowSpent + amount;
        if (spent > windowCap) revert CapExceeded(spent, windowCap);
        windowSpent = spent;

        address account = safe;
        uint256 safeBefore = IERC20Arc(token).balanceOf(account);
        uint256 recipientBefore = IERC20Arc(token).balanceOf(recipient);
        bool ok = ISafeArc(account).execTransactionFromModule(
            token, 0, abi.encodeCall(IERC20Arc.transfer, (recipient, amount)), OP_CALL
        );
        if (
            !ok || safeBefore - IERC20Arc(token).balanceOf(account) != amount
                || IERC20Arc(token).balanceOf(recipient) - recipientBefore != amount
        ) revert PaymentFailed();
        emit OperatorPaid(ref, msg.sender, recipient, token, amount);
    }

    // ------------------------------------------------------------------ internal

    function _checkRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this) || recipient == token || recipient == operator) {
            revert InvalidAddress(recipient);
        }
    }

    /// @dev A replacement guard must already be bound to this Safe, or every later Safe transaction would revert.
    function _checkReplacement(bytes calldata data) private view {
        address next = abi.decode(data[4:36], (address));
        if (next == address(0)) return;
        (bool ok, bytes memory ret) = next.staticcall(abi.encodeWithSelector(this.safe.selector));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != safe) revert InvalidReplacement(next);
    }

    function _isInstant(bytes calldata data) private pure returns (bool) {
        if (data.length < 4) return false;
        bytes4 selector = bytes4(data[:4]);
        return selector == this.queue.selector || selector == this.cancel.selector
            || selector == this.revokeOperator.selector || selector == this.removeRecipient.selector;
    }
}
