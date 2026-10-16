export const SINGLE_SWAP_ABI = [
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: '_transactionId',
        type: 'bytes32',
      },
      {
        internalType: 'string',
        name: '_integrator',
        type: 'string',
      },
      {
        internalType: 'string',
        name: '_referrer',
        type: 'string',
      },
      {
        internalType: 'address payable',
        name: '_receiver',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: '_minAmountOut',
        type: 'uint256',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'callTo',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'approveTo',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'sendingAssetId',
            type: 'address',
          },
          {
            internalType: 'address',
            name: 'receivingAssetId',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'fromAmount',
            type: 'uint256',
          },
          {
            internalType: 'bytes',
            name: 'callData',
            type: 'bytes',
          },
          {
            internalType: 'bool',
            name: 'requiresDeposit',
            type: 'bool',
          },
        ],
        internalType: 'struct LibSwap.SwapData',
        name: '_swapData',
        type: 'tuple',
      },
    ],
    name: 'swapTokensSingleV3ERC20ToERC20',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;
