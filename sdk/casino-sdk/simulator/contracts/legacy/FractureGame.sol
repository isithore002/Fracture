// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from './ICasinoGameV2.sol';

/**
 * @title FractureGame
 * @notice Predict which law of reality is about to break. One wager, one VRF
 *         draw, one transformation.
 *
 *         Five outcomes partition 100 buckets:
 *           GRAVITY 45 | TIME 25 | SCALE 15 | ORBIT 10 | VOID 5
 *
 *         RTP is fixed by construction, not tuned. For an outcome holding `w`
 *         of the 100 buckets, probability is w/100 and the payout multiplier is
 *         RTP / p = (95/100) / (w/100) = 95/w. Therefore:
 *
 *             payout = wager * 95 / w
 *
 *         and the expected return of predicting *any* outcome is
 *
 *             p * multiplier = (w/100) * (95/w) = 95/100 = 95%
 *
 *         exactly, for every w, with no per-outcome constant to drift. Integer
 *         division floors, so realised RTP is at most 95% and never above it.
 *
 *         Every ICasinoGameV2 entry point routes through `payoutFor`, so the
 *         reserve committed at session start and the payout paid at settlement
 *         are the same number to the wei (see CONTRACT_CONSTRAINTS.md "Reserve
 *         and payout must agree to the wei").
 */
contract FractureGame is ICasinoGameV2 {
  uint256 private constant WAD = 1e18;

  /// @dev RTP numerator over BUCKETS: 95/100 = 95%.
  uint256 private constant RTP_NUM = 95;
  uint256 private constant BUCKETS = 100;

  /// @dev floor(256 / 100) * 100 — bytes at or above this are rejected so that
  ///      every accepted byte maps to one of the 100 buckets with equal weight.
  uint8 private constant ROLL_REJECT = 200;

  uint8 public constant OUTCOME_GRAVITY = 0;
  uint8 public constant OUTCOME_TIME = 1;
  uint8 public constant OUTCOME_SCALE = 2;
  uint8 public constant OUTCOME_ORBIT = 3;
  uint8 public constant OUTCOME_VOID = 4;

  error FractureGame__InvalidPrediction();
  error FractureGame__BadGameData();
  error FractureGame__NoPlayerActions();

  struct FractureState {
    uint8 prediction;
    uint8 outcome;
    uint8 bucket;
    bool resolved;
    bool won;
    bytes32 randomness;
  }

  // -------------------------------------------------------------------------
  // Paytable — single source of truth
  // -------------------------------------------------------------------------

  /// @notice Bucket count out of 100 for an outcome. These sum to exactly 100.
  function weightOf(uint8 outcome) public pure returns (uint256) {
    if (outcome == OUTCOME_GRAVITY) return 45;
    if (outcome == OUTCOME_TIME) return 25;
    if (outcome == OUTCOME_SCALE) return 15;
    if (outcome == OUTCOME_ORBIT) return 10;
    if (outcome == OUTCOME_VOID) return 5;
    revert FractureGame__InvalidPrediction();
  }

  /// @notice Win probability in WAD (1e18 = 100%).
  function probabilityWadOf(uint8 outcome) public pure returns (uint256) {
    return (WAD * weightOf(outcome)) / BUCKETS;
  }

  /// @notice THE payout function. Every other entry point calls this one.
  /// @dev payout = wager * RTP / p = wager * (95/100) / (w/100) = wager * 95 / w
  function payoutFor(uint256 wager, uint8 outcome) public pure returns (uint256) {
    return (wager * RTP_NUM) / weightOf(outcome);
  }

  /// @notice Profit the vault must reserve to cover a winning prediction.
  function reservedProfitFor(uint256 wager, uint8 outcome) public pure returns (uint256) {
    uint256 payout = payoutFor(wager, outcome);
    return payout > wager ? payout - wager : 0;
  }

  /// @notice Maps an accepted bucket (0..99) to the outcome that owns it.
  /// @dev Range widths are exactly the weights above: 45 / 25 / 15 / 10 / 5.
  function bucketToOutcome(uint8 bucket) public pure returns (uint8) {
    if (bucket < 45) return OUTCOME_GRAVITY;
    if (bucket < 70) return OUTCOME_TIME;
    if (bucket < 85) return OUTCOME_SCALE;
    if (bucket < 95) return OUTCOME_ORBIT;
    return OUTCOME_VOID;
  }

  // -------------------------------------------------------------------------
  // Randomness — unbiased bucket via rejection sampling
  // -------------------------------------------------------------------------

  /// @dev 256 is not a multiple of 100, so a raw `byte % 100` would over-weight
  ///      buckets 0..55. Reject bytes >= 200 and only then take `% 100`, per
  ///      RANDOMNESS_DICE.md ("limit = floor(M/n)*n, reject >= limit").
  ///      Rejection rate is 56/256; exhausting a 32-byte word is ~2e-21, and the
  ///      seed rehashes rather than reverting so a paid bet can never fail here.
  function bucketFromRandomness(bytes32 randomness) public pure returns (uint8) {
    bytes32 seed = randomness;
    uint256 index = 0;
    while (true) {
      if (index == 32) {
        seed = keccak256(abi.encodePacked(seed));
        index = 0;
      }
      uint8 sample = uint8(seed[index]);
      index += 1;
      if (sample < ROLL_REJECT) return sample % uint8(BUCKETS);
    }
    revert FractureGame__InvalidPrediction();
  }

  // -------------------------------------------------------------------------
  // ICasinoGameV2
  // -------------------------------------------------------------------------

  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    uint8 prediction = _decodePrediction(gameData);
    maxEscrowStake = wager;
    maxReservedProfit = reservedProfitFor(wager, prediction);
  }

  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    returns (
      uint256 maxPayout,
      uint256 probabilityWad,
      uint256 expectedPayout,
      uint256 subJackpotVarianceScaled
    )
  {
    uint8 prediction = _decodePrediction(gameData);
    maxPayout = payoutFor(wager, prediction);
    probabilityWad = probabilityWadOf(prediction);
    // p * payout == wager * RTP for every outcome, by construction.
    expectedPayout = (wager * RTP_NUM) / BUCKETS;
    subJackpotVarianceScaled = 0;
  }

  function onSessionStart(
    SessionContext calldata ctx
  ) external pure returns (StepResult memory stepResult) {
    uint8 prediction = _decodePrediction(ctx.gameData);

    FractureState memory state = FractureState({
      prediction: prediction,
      outcome: 0,
      bucket: 0,
      resolved: false,
      won: false,
      randomness: bytes32(0)
    });

    stepResult.newGameState = abi.encode(state);
    stepResult.escrowDelta = 0;
    // Reserve exactly what a win on this prediction pays, minus the stake the
    // facet already escrowed. Same function as the settlement payout.
    stepResult.reservedProfitDelta = int256(reservedProfitFor(ctx.wagerBase, prediction));
    stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    stepResult.requestRandomnessNow = true;
    stepResult.payout = 0;
  }

  /// @notice Fracture is an instant game: the prediction is committed in
  ///         `gameData` at open and the VRF draw settles it. There is no
  ///         mid-session move, so this must never be reached.
  function onPlayerAction(
    SessionContext calldata,
    bytes calldata
  ) external pure returns (StepResult memory) {
    revert FractureGame__NoPlayerActions();
  }

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external pure returns (StepResult memory stepResult) {
    FractureState memory state = abi.decode(ctx.gameState, (FractureState));

    uint8 bucket = bucketFromRandomness(randomness);
    uint8 outcome = bucketToOutcome(bucket);
    bool won = outcome == state.prediction;

    state.bucket = bucket;
    state.outcome = outcome;
    state.resolved = true;
    state.won = won;
    state.randomness = randomness;

    stepResult.newGameState = abi.encode(state);
    stepResult.escrowDelta = 0;
    // Must be 0 on the settling step: _finalizeSession releases the reserve
    // itself, and a negative delta here would lower the payout cap below the
    // win and revert with InvalidPayout.
    stepResult.reservedProfitDelta = 0;
    stepResult.nextPhase = SessionPhase.SETTLED;
    stepResult.requestRandomnessNow = false;
    stepResult.payout = won ? payoutFor(ctx.wagerBase, state.prediction) : 0;
  }

  /// @notice Fracture has no anytime cash-out: mid-round value depends entirely
  ///         on the unresolved VRF draw, so quoting anything here would be an
  ///         adverse-selection exploit against the vault.
  function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
    return 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  function _decodePrediction(bytes calldata gameData) private pure returns (uint8 prediction) {
    if (gameData.length != 32) revert FractureGame__BadGameData();
    prediction = abi.decode(gameData, (uint8));
    weightOf(prediction); // reverts on an out-of-range prediction
  }
}
