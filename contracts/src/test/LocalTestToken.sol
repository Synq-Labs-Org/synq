// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Local sandbox fixture. No relationship to AUSD or any deployed asset.
contract LocalTestToken {
    string public constant name = "Synq Local Test Token";
    string public constant symbol = "LOCAL_TEST";
    uint8 public constant decimals = 18;
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
