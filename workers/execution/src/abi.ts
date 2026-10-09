import { parseAbi } from 'viem';
export const accountAbi = parseAbi([
  'constructor(address[3] initialOwners)',
  'function ownerNonce() view returns (uint256)',
  'function ownerTransactionHash(address target,uint256 value,bytes data,uint256 nonce) view returns (bytes32)',
  'function ownerExecute(address target,uint256 value,bytes data,bytes signatures)',
  'function setModule(address module,bool enabled)',
  'function getOwners() view returns (address[3])',
]);
export const registryAbi = parseAbi([
  'constructor(address account,bytes32 groupId)',
  'function configure(bytes32 id,uint256 version,(address target,bytes4 selector,address inputToken,uint256 maxPerCall,uint256 cumulativeCap,uint256 maxValue,uint256 validUntil) terms)',
  'function revoke(bytes32 id)',
  'function currentVersion(bytes32 id) view returns (uint256)',
  'event MandateConfigured(bytes32 indexed groupId,bytes32 indexed mandateId,uint256 indexed version,address account,address target,bytes4 selector,address inputToken,uint256 maxPerCall,uint256 cumulativeCap,uint256 maxValue,uint256 validUntil)',
  'event MandateRevoked(bytes32 indexed groupId,bytes32 indexed mandateId,uint256 indexed version,address account)',
]);
export const moduleAbi = parseAbi([
  'constructor(address account,address registry)',
  'struct ExecutionGrant {bytes32 intentHash;bytes32 mandateId;uint256 mandateVersion;address executor;address target;bytes4 selector;bytes32 calldataHash;address inputToken;uint256 maxInputAmount;uint256 value;uint256 validAfter;uint256 validUntil;uint256 nonce;bytes32 pluginId;uint256 minOutputAmount;uint256 chainId;}',
  'function execute(ExecutionGrant grant,bytes data,bytes signatures)',
  'function hashGrant(ExecutionGrant grant) view returns (bytes32)',
  'function setPaused(bool paused)',
  'function spent(bytes32 mandateId) view returns (uint256)',
  'function usedNonces(uint256 nonce) view returns (bool)',
  'event PauseChanged(bytes32 indexed groupId,address indexed account,bool paused)',
  'event GrantExecuted(bytes32 indexed groupId,bytes32 indexed intentHash,bytes32 indexed mandateId,uint256 mandateVersion,address account,address executor,bytes32 pluginId,uint256 chainId,uint256 nonce,bytes32 grantHash,address target,bytes4 selector,bytes32 calldataHash,address inputToken,address recipient,uint256 inputAmount,uint256 value,uint256 outputAmount)',
]);
export const tokenAbi = parseAbi([
  'function mint(address to,uint256 amount)',
  'function transfer(address to,uint256 amount) returns (bool)',
  'function balanceOf(address who) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
