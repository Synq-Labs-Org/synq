import { parseAbi } from 'viem';

const GRANT_STRUCT =
  'struct ExecutionGrant { bytes32 groupId; address account; bytes32 mandateId; uint256 mandateVersion; address executor; bytes32 pluginId; uint256 chainId; address target; bytes4 selector; bytes32 calldataHash; address token; uint256 maxInputAmount; uint256 nativeValue; uint256 minOutputAmount; address recipient; uint256 validAfter; uint256 validUntil; uint256 nonce; bytes32 intentHash; }';
const CONFIG_STRUCT =
  'struct MandateConfig { bytes32 mandateHash; address token; uint256 maxTokenPerAction; uint256 maxNativePerAction; uint256 cumulativeTokenCap; uint256 cumulativeNativeCap; uint256 validAfter; uint256 validUntil; address[] callTargets; bytes4[] callSelectors; address[] recipients; }';

export const moduleAbi = parseAbi([
  GRANT_STRUCT,
  'function execute(ExecutionGrant grant, bytes data, bytes signatures) returns (bytes32)',
  'function hashGrant(ExecutionGrant grant) view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',
  'function setExecutor(address executor, bool allowed)',
  'function pause()',
  'function unpause()',
  'function cancelNonce(uint256 nonce)',
  'function paused(address account) view returns (bool)',
  'function nonceUsed(address account, uint256 nonce) view returns (bool)',
  'function intentUsed(address account, bytes32 intentHash) view returns (bool)',
  'function isExecutor(address account, address executor) view returns (bool)',
  'event ExecutorSet(bytes32 indexed groupId, address indexed account, address indexed executor, bool allowed)',
  'event Paused(bytes32 indexed groupId, address indexed account)',
  'event Unpaused(bytes32 indexed groupId, address indexed account)',
  'event NonceCancelled(bytes32 indexed groupId, address indexed account, uint256 indexed nonce)',
  'event GrantExecuted(bytes32 indexed groupId, bytes32 indexed intentHash, bytes32 indexed mandateId, uint256 mandateVersion, address account, address executor, bytes32 pluginId, uint256 chainId, uint256 nonce, bytes32 grantHash, address target, bytes4 selector, bytes32 calldataHash, address token, address recipient, uint256 tokenAmount, uint256 nativeValue, uint256 outputAmount)',
  'error ExecutionPaused(address account)',
  'error InvalidSignatures()',
  'error GrantExpired()',
  'error NonceAlreadyUsed(uint256 nonce)',
  'error IntentAlreadyExecuted(bytes32 intentHash)',
  'error UnauthorizedExecutor(address executor)',
]);
export const registryAbi = parseAbi([
  CONFIG_STRUCT,
  'struct MandateState { uint8 status; uint256 currentVersion; uint256 minValidVersion; uint256 spentToken; uint256 spentNative; }',
  'function configureMandate(bytes32 mandateId, MandateConfig config)',
  'function supersedeMandate(bytes32 mandateId, uint256 newVersion, MandateConfig config, bool securitySensitive)',
  'function revokeMandate(bytes32 mandateId)',
  'function mandateState(address account, bytes32 mandateId) view returns (MandateState)',
  'function accountOf(bytes32 groupId) view returns (address)',
  'event GroupBound(bytes32 indexed groupId, address indexed account, address indexed module)',
  'event GroupModuleChanged(bytes32 indexed groupId, address indexed account, address previousModule, address newModule)',
  'event MandateConfigured(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account, bytes32 mandateHash, address token, uint256 maxTokenPerAction, uint256 maxNativePerAction, uint256 cumulativeTokenCap, uint256 cumulativeNativeCap, uint256 validAfter, uint256 validUntil, address[] callTargets, bytes4[] callSelectors, address[] recipients)',
  'event MandateSuperseded(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed newVersion, address account, uint256 previousVersion, bool securitySensitive, uint256 minValidVersion)',
  'event MandateRevoked(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account)',
  'event SpendRecorded(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account, address module, uint256 tokenAmount, uint256 nativeAmount, uint256 spentToken, uint256 spentNative)',
  'error MandateVersionNotValid(uint256 version)',
  'error MandateNotActive(bytes32 mandateId)',
  'error RecipientNotAllowed(address recipient)',
  'error CallNotAllowed(address target, bytes4 selector)',
  'error PerActionCapExceeded()',
  'error CumulativeCapExceeded()',
]);
export const factoryAbi = parseAbi([
  'constructor(address safeSingleton, address safeProxyFactory, address fallbackHandler)',
  'function createGroup(address[] owners, uint256 threshold, bytes32 salt) returns (bytes32 groupId, address account)',
  'function computeGroupId(address creator, bytes32 salt) view returns (bytes32)',
  'function registry() view returns (address)',
  'function module() view returns (address)',
  'event GroupCreated(bytes32 indexed groupId, address indexed account, address[] owners, uint256 threshold, address module, address registry, address indexed creator, bytes32 salt)',
]);
export const safeAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
]);
export const tokenAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address who) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
