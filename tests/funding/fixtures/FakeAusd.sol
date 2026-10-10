// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Test-only impostor: claims the AUSD symbol and exposes AUSD-style
/// pause/freeze readers so registry and guard checks can be exercised on Anvil.
contract FakeAusd {
    string public constant name = "AUSD";
    string public constant symbol = "AUSD";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isAccountFrozen;
    bool public isTransferPaused;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setTransferPaused(bool paused_) external {
        isTransferPaused = paused_;
    }

    function setFrozen(address account, bool frozen) external {
        isAccountFrozen[account] = frozen;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!isTransferPaused, "paused");
        require(!isAccountFrozen[msg.sender] && !isAccountFrozen[to], "frozen");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
