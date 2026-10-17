// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Local sandbox fixture with USDC-like 6 decimals (Amane accounts require 6).
/// No relationship to USDC or any deployed asset.
contract LocalSixDecimalToken {
    string public constant name = "Synq Local Six Decimal Token";
    string public constant symbol = "LOCAL_TEST6";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(recipient != address(0), "recipient");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(msg.sender, recipient, amount);
        return true;
    }
}
