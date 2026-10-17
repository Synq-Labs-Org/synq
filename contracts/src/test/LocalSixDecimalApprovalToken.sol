// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Local sandbox fixture: 6-decimal USDC-like token with approve/transferFrom, so the
/// milestone escrow can pull funds in tests. No relationship to USDC or any deployed asset.
contract LocalSixDecimalApprovalToken {
    string public constant name = "Synq Local Six Decimal Approval Token";
    string public constant symbol = "LOCAL_TEST6A";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _move(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address from, address recipient, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _move(from, recipient, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "recipient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
