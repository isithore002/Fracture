// Host-side implementation of `getRandomnessVerification` for the simulator —
// the piece the game's "provably fair" dialog calls (feature-detected) to get
// a cryptographic verdict on each VRF fulfillment. Mirrors what the production
// host does (apps/web/src/lib/randomness-verification.ts): the router keeps no
// request state, so the artifacts come from the fulfillment transaction — the
// `RandomnessFulfilled` log, the request echoed in the calldata — plus the
// node's registered key and the stored fulfillment commitment, all re-checked
// locally per docs/RANDOMNESS_VERIFICATION.md.
//
// The ECVRF verify below replicates @kenshi.io/node-ecvrf's
// ECVRF-SECP256K1-SHA256-TAI implementation (suite byte 0xfe, try-and-increment
// hash-to-curve with a fixed 0x02 candidate prefix, 16-byte truncated challenge)
// using @noble/curves + @noble/hashes, because node-ecvrf depends on Node's
// `crypto` module and cannot run in the simulator's browser context.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type {
  RandomnessRequestEchoV1,
  RandomnessRequestVerificationV1,
  RandomnessVerificationV1,
  VrfVerificationChecksV1,
} from '@chain/casino-sdk';

type Point = InstanceType<typeof secp256k1.ProjectivePoint>;
type VrfProof = readonly [bigint, bigint, bigint, bigint];

const SUITE = 0xfe; // ECVRF-SECP256K1-SHA256-TAI

const hostRouterAbi = [
  {
    inputs: [],
    name: 'router',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// The router stores only `keccak256(proofCommitment ‖ fulfilledAt)` per request;
// the request itself is hashed into the request id and echoed in the fulfillment
// calldata, and the proof + enclave signature are published in this event.
const routerAbi = parseAbi([
  'struct RandomnessRequest { address requester; uint64 sequence; address fulfiller; uint64 assignedAt; uint128 payment; uint128 gasPrice; bytes clientData; }',
  'struct RandomnessFulfillment { RandomnessRequest request; uint256[4] proof; bytes enclaveSignature; }',
  'function fulfillRandomness(RandomnessRequest request, uint256[4] proof, bytes enclaveSignature)',
  'function fulfillRandomnessBatch(RandomnessFulfillment[] fulfillments)',
  'function getFulfillmentCommitment(bytes32 requestId) view returns (bytes32)',
  'function getAddressToPublicKey(address node) view returns (uint256[2])',
  'event RandomnessFulfilled(bytes32 indexed requestId, bytes32 randomness, uint256[4] proof, bytes enclaveSignature)',
]);

type RandomnessRequestEcho = {
  requester: Address;
  sequence: bigint;
  fulfiller: Address;
  assignedAt: bigint;
  payment: bigint;
  gasPrice: bigint;
  clientData: Hex;
};

function toBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number((v >> BigInt((31 - i) * 8)) & 0xffn);
  }
  return out;
}

function toHex32(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, '0')}` as Hex;
}

function concatBytes(...parts: (number | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') flat.push(p);
    else flat.push(...p);
  }
  return Uint8Array.from(flat);
}

/** Compressed SEC1 encoding — node-ecvrf's point_to_string. */
function pointToString(p: Point): Uint8Array {
  return p.toRawBytes(true);
}

/** node-ecvrf's hash_to_curve_try_and_increment: fixed 0x02 candidate prefix. */
function hashToCurveTAI(publicKey: Point, alpha: Uint8Array): Point | null {
  const pkString = pointToString(publicKey);
  for (let ctr = 0; ctr < 256; ctr++) {
    const digest = sha256(concatBytes(SUITE, 0x01, pkString, alpha, ctr, 0x00));
    try {
      const candidate = secp256k1.ProjectivePoint.fromHex(concatBytes(0x02, digest));
      candidate.assertValidity();
      return candidate;
    } catch {
      // Not a curve point for this ctr — increment and retry.
    }
  }
  return null;
}

/** node-ecvrf's hash_points: 16-byte truncated challenge. */
function hashPoints(...points: Point[]): bigint {
  const digest = sha256(concatBytes(SUITE, 0x02, ...points.map(pointToString), 0x00));
  let c = 0n;
  for (let i = 0; i < 16; i++) c = (c << 8n) | BigInt(digest[i]);
  return c;
}

/** ECVRF beta (the random output) from Gamma — node-ecvrf's proof_to_hash. */
function proofToHash(gamma: Point): Uint8Array {
  return sha256(concatBytes(SUITE, 0x03, pointToString(gamma), 0x00));
}

type FastVerifyComponents = {
  uPoint: readonly [bigint, bigint];
  vComponents: readonly [bigint, bigint, bigint, bigint];
};

type EcvrfVerdict = {
  vrfProofValid: boolean;
  vrfBetaMatchesRandomness: boolean;
  /** The `ECVRFVerifier.fastVerify` hints, derived from public inputs; null for a malformed proof. */
  fastVerifyComponents: FastVerifyComponents | null;
};

function verifyEcvrf(input: {
  nodePublicKey: readonly [bigint, bigint];
  proof: VrfProof;
  alpha: Uint8Array;
  randomness: bigint;
}): EcvrfVerdict {
  const invalid: EcvrfVerdict = {
    vrfProofValid: false,
    vrfBetaMatchesRandomness: false,
    fastVerifyComponents: null,
  };
  try {
    const Y = secp256k1.ProjectivePoint.fromAffine({
      x: input.nodePublicKey[0],
      y: input.nodePublicKey[1],
    });
    Y.assertValidity();
    const gamma = secp256k1.ProjectivePoint.fromAffine({
      x: input.proof[0],
      y: input.proof[1],
    });
    gamma.assertValidity();
    const c = input.proof[2];
    const s = input.proof[3];
    if (s >= secp256k1.CURVE.n) return invalid;

    // Degenerate scalars can't occur in a well-formed proof; reject instead of
    // special-casing point-at-infinity arithmetic. NOTE: use multiply(), NOT
    // multiplyUnsafe() — @noble/curves 1.9.1's multiplyUnsafe returns wrong
    // results for some scalars on points with cached precomputes (BASE).
    if (c === 0n || s === 0n) return invalid;

    const H = hashToCurveTAI(Y, input.alpha);
    if (!H) return invalid;

    // U = s·B − c·Y ; V = s·H − c·Γ
    const U = secp256k1.ProjectivePoint.BASE.multiply(s).add(Y.multiply(c).negate());
    const sH = H.multiply(s);
    const cGamma = gamma.multiply(c);
    const V = sH.add(cGamma.negate());

    const cPrime = hashPoints(H, gamma, U, V);
    const vrfProofValid = cPrime === c;

    const beta = proofToHash(gamma);
    let betaValue = 0n;
    for (const b of beta) betaValue = (betaValue << 8n) | BigInt(b);
    const vrfBetaMatchesRandomness = betaValue === input.randomness;

    const uAff = U.toAffine();
    const sHAff = sH.toAffine();
    const cGammaAff = cGamma.toAffine();
    return {
      vrfProofValid,
      vrfBetaMatchesRandomness,
      fastVerifyComponents: {
        uPoint: [uAff.x, uAff.y],
        vComponents: [sHAff.x, sHAff.y, cGammaAff.x, cGammaAff.y],
      },
    };
  } catch {
    return invalid;
  }
}

/** Mirrors `RandomnessLib.computeRequestId` in the router. */
function computeRandomnessRequestId(
  chainId: number,
  router: Address,
  request: RandomnessRequestEcho,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'bytes32' },
      ],
      [
        BigInt(chainId),
        router,
        request.requester,
        request.sequence,
        request.fulfiller,
        request.assignedAt,
        request.payment,
        request.gasPrice,
        keccak256(request.clientData),
      ],
    ),
  );
}

/** Mirrors `keccak256(abi.encode(proof))` in `RouterLib._fulfillRandomness`. */
function computeProofCommitment(proof: VrfProof): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256[4]' }], [[...proof]]));
}

/** Mirrors `RouterLib.publicKeyToAddress`: nodes register under the address of their enclave key. */
function publicKeyToAddress(publicKey: readonly [bigint, bigint]): Address {
  return getAddress(
    `0x${keccak256(encodePacked(['uint256', 'uint256'], [publicKey[0], publicKey[1]])).slice(-40)}`,
  );
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function findFulfillmentLog(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  router: Address,
  requestId: Hex,
): { randomness: Hex; proof: VrfProof; enclaveSignature: Hex } | undefined {
  for (const log of logs) {
    if (!sameAddress(log.address, router) || log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: routerAbi,
        eventName: 'RandomnessFulfilled',
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (sameAddress(decoded.args.requestId, requestId)) {
        return {
          randomness: decoded.args.randomness,
          proof: decoded.args.proof,
          enclaveSignature: decoded.args.enclaveSignature,
        };
      }
    } catch {
      // Other router or host logs in the same transaction.
    }
  }
  return undefined;
}

/**
 * The request the node echoed when fulfilling, taken from the transaction's
 * calldata (single or batched fulfillment) and accepted only when it hashes
 * to the request id — that binding is what makes its `fulfiller` trustworthy.
 */
function findEchoedRequest(
  input: Hex,
  requestId: Hex,
  chainId: number,
  router: Address,
): RandomnessRequestEcho | undefined {
  let candidates: RandomnessRequestEcho[];
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data: input });
    if (decoded.functionName === 'fulfillRandomness') {
      candidates = [decoded.args[0]];
    } else if (decoded.functionName === 'fulfillRandomnessBatch') {
      candidates = decoded.args[0].map(fulfillment => fulfillment.request);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return candidates.find(candidate =>
    sameAddress(computeRandomnessRequestId(chainId, router, candidate), requestId),
  );
}

function echoToV1(echo: RandomnessRequestEcho): RandomnessRequestEchoV1 {
  return {
    requester: echo.requester,
    sequence: echo.sequence.toString(),
    fulfiller: echo.fulfiller,
    assignedAt: echo.assignedAt.toString(),
    payment: echo.payment.toString(),
    gasPrice: echo.gasPrice.toString(),
    clientData: echo.clientData,
  };
}

type SessionRequest = {
  nonce: string;
  requestId: string;
  randomness?: string;
  fulfilled: boolean;
  transactionHash?: string;
};

async function verifyRequest(
  publicClient: PublicClient,
  chainId: number,
  router: Address,
  base: RandomnessRequestVerificationV1,
): Promise<RandomnessRequestVerificationV1> {
  const requestId = base.requestId;
  let transactionHash = base.transactionHash;
  if (!transactionHash) {
    // Marked fulfilled without a hash (row projected before the field
    // existed): the router's log carries it.
    const logs = await publicClient.getLogs({
      address: router,
      event: routerAbi.find(item => item.type === 'event' && item.name === 'RandomnessFulfilled')!,
      args: { requestId },
      fromBlock: 0n,
    });
    transactionHash = logs.at(-1)?.transactionHash ?? undefined;
  }
  if (!transactionHash) return base;

  const [receipt, transaction] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: transactionHash }),
    publicClient.getTransaction({ hash: transactionHash }),
  ]);
  const log = findFulfillmentLog(receipt.logs, router, requestId);
  if (!log) return base;
  const { randomness, proof, enclaveSignature } = log;
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const fulfilledAt = block.timestamp;
  const echo = findEchoedRequest(transaction.input, requestId, chainId, router);

  const proofCommitment = computeProofCommitment(proof);
  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: { name: 'VerifyNetworkVRF', version: '1', chainId, verifyingContract: router },
      types: {
        Fulfillment: [
          { name: 'requestId', type: 'bytes32' },
          { name: 'proofCommitment', type: 'bytes32' },
        ],
      },
      primaryType: 'Fulfillment',
      message: { requestId, proofCommitment },
      signature: enclaveSignature,
    });
  } catch {
    signer = null;
  }

  // The router registers every node under the address of its enclave key, so
  // the key is looked up by the assigned fulfiller — or, without a decodable
  // echo, by the signer — and checked to actually be that address.
  const keyOwner = echo?.fulfiller ?? signer;
  const [registeredKey, storedCommitment] = await Promise.all([
    keyOwner
      ? publicClient.readContract({
          address: router,
          abi: routerAbi,
          functionName: 'getAddressToPublicKey',
          args: [keyOwner],
        })
      : Promise.resolve(undefined),
    publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: 'getFulfillmentCommitment',
      args: [requestId],
    }),
  ]);
  const nodePublicKey =
    keyOwner && registeredKey && publicKeyToAddress(registeredKey) === getAddress(keyOwner)
      ? registeredKey
      : undefined;
  const ecvrf = nodePublicKey
    ? verifyEcvrf({
        nodePublicKey,
        proof,
        alpha: toBytes32(BigInt(requestId)),
        randomness: BigInt(randomness),
      })
    : undefined;

  const checks: VrfVerificationChecksV1 = {
    vrfProofValid: ecvrf?.vrfProofValid ?? false,
    vrfBetaMatchesRandomness: ecvrf?.vrfBetaMatchesRandomness ?? false,
    fastVerifyComponentsMatch: ecvrf?.fastVerifyComponents !== null && ecvrf !== undefined,
    enclaveSignatureValid: signer !== null,
    signerMatchesFulfiller:
      echo !== undefined && signer !== null && signer === getAddress(echo.fulfiller),
    fulfillmentCommitted:
      storedCommitment ===
      keccak256(encodePacked(['bytes32', 'uint256'], [proofCommitment, fulfilledAt])),
  };
  const hints = ecvrf?.fastVerifyComponents ?? null;
  return {
    ...base,
    randomness,
    transactionHash,
    artifacts: {
      randomness,
      proof: [toHex32(proof[0]), toHex32(proof[1]), toHex32(proof[2]), toHex32(proof[3])],
      enclaveSignature,
      alpha: requestId,
      ...(hints
        ? {
            uPoint: [toHex32(hints.uPoint[0]), toHex32(hints.uPoint[1])],
            vComponents: [
              toHex32(hints.vComponents[0]),
              toHex32(hints.vComponents[1]),
              toHex32(hints.vComponents[2]),
              toHex32(hints.vComponents[3]),
            ],
          }
        : {}),
    },
    request: echo ? echoToV1(echo) : undefined,
    fulfilledAt: Number(fulfilledAt),
    fulfiller: echo?.fulfiller,
    nodePublicKey: nodePublicKey
      ? [toHex32(nodePublicKey[0]), toHex32(nodePublicKey[1])]
      : undefined,
    checks,
    valid: Object.values(checks).every(Boolean),
  };
}

/**
 * Verify every VRF request of a session against on-chain router state.
 * Throws when the chain (or the router address) is unreachable — the game
 * renders that as "could not verify, retry", per the SDK doc. A single
 * request whose reads fail comes back with `checks` absent instead.
 */
export async function verifySessionRandomness(input: {
  publicClient: PublicClient;
  chainId: number;
  /** LocalCasinoHost address — its `router()` getter locates the artifacts. */
  proxy: Address;
  requests: SessionRequest[];
}): Promise<RandomnessVerificationV1> {
  const { publicClient, chainId, proxy, requests } = input;

  const router = (await publicClient.readContract({
    address: proxy,
    abi: hostRouterAbi,
    functionName: 'router',
  })) as Address;
  if (!router || router === zeroAddress) {
    return { supported: false, chainId, requests: [] };
  }

  const verified: RandomnessRequestVerificationV1[] = [];
  for (const req of requests) {
    const base: RandomnessRequestVerificationV1 = {
      nonce: req.nonce,
      requestId: req.requestId as Hex,
      randomness: req.randomness as Hex | undefined,
      fulfilled: req.fulfilled,
      transactionHash: req.transactionHash as Hex | undefined,
    };
    if (!req.fulfilled) {
      verified.push(base);
      continue;
    }
    try {
      verified.push(await verifyRequest(publicClient, chainId, router, base));
    } catch {
      // Reads failed for this request only — fulfilled + no checks renders as
      // "could not verify" with a retry, NOT as invalid.
      verified.push(base);
    }
  }

  return { supported: true, chainId, routerAddress: router, requests: verified };
}
