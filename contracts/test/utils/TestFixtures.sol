// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExecutionModule} from "../../src/ExecutionModule.sol";

/// @notice Configurable ERC20-like token for balance-delta tests.
contract MisbehavingToken {
    mapping(address => uint256) public balanceOf;
    uint256 public fee;
    bool public returnFalseWithoutEffect;
    uint256 public extraDebit;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setModes(uint256 fee_, bool returnFalse_, uint256 extraDebit_) external {
        fee = fee_;
        returnFalseWithoutEffect = returnFalse_;
        extraDebit = extraDebit_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalseWithoutEffect) return false;
        balanceOf[msg.sender] -= amount + extraDebit;
        balanceOf[to] += amount - fee;
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @notice Native recipient that tries to re-enter ExecutionModule.execute with a stored grant.
contract ReentrantRecipient {
    ExecutionModule public module;
    ExecutionModule.ExecutionGrant internal grant;
    bytes internal data;
    bytes internal signatures;
    bool public armed;
    bool public reentryBlocked;
    bytes public reentryError;

    function arm(
        ExecutionModule module_,
        ExecutionModule.ExecutionGrant calldata grant_,
        bytes calldata data_,
        bytes calldata signatures_
    ) external {
        module = module_;
        grant = grant_;
        data = data_;
        signatures = signatures_;
        armed = true;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        try module.execute(grant, data, signatures) {}
        catch (bytes memory err) {
            reentryBlocked = true;
            reentryError = err;
            revert("reentry blocked");
        }
    }
}

/// @notice Token whose transfer calls back into the module (models ERC777-style hooks).
contract HookToken {
    mapping(address => uint256) public balanceOf;
    ExecutionModule public module;
    ExecutionModule.ExecutionGrant internal grant;
    bytes internal data;
    bytes internal signatures;
    bool public armed;
    bool public reentrySucceeded;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(
        ExecutionModule module_,
        ExecutionModule.ExecutionGrant calldata grant_,
        bytes calldata data_,
        bytes calldata signatures_
    ) external {
        module = module_;
        grant = grant_;
        data = data_;
        signatures = signatures_;
        armed = true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (armed) {
            armed = false;
            try module.execute(grant, data, signatures) {
                reentrySucceeded = true;
            } catch {}
        }
        return true;
    }
}

/// @notice Native recipient that always rejects funds.
contract RejectingRecipient {
    receive() external payable {
        revert("rejected");
    }
}
