// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from './ICasinoGameV2.sol';

/**
 * @title FractureRunGame
 * @notice RUN MODE. Place your reality, survive the fracture, bank or push on.
 *
 *         A run is a ladder of up to 10 steps. Before each step the player
 *         anchors reality at one of five world positions. A VRF word then picks
 *         a contiguous arc of the five-position ring; every position inside the
 *         arc is destroyed. Survive and the multiplier climbs and the player
 *         chooses again: CASH OUT, or ONE MORE.
 *
 *         Hazard schedule (arc length H out of 5 positions):
 *           steps 1-4   H = 1   p = 4/5
 *           steps 5-8   H = 2   p = 3/5
 *           steps 9-10  H = 3   p = 2/5
 *
 *         RTP IS FIXED BY CONSTRUCTION, AT EVERY STOPPING POINT.
 *
 *         Let S_k be the probability of surviving the first k steps. Set the
 *         multiplier after k survivals to
 *
 *             M_k = RTP / S_k
 *
 *         Then the expected return of stopping after k steps is
 *
 *             S_k * M_k = RTP = 95%
 *
 *         for EVERY k. Cashing out at step 1, at step 7, or riding to the cap
 *         all return exactly 95%. There is no optimal stopping strategy, so no
 *         amount of player skill or nerve can move the house edge — the same
 *         property the original Fracture gets from `payout = wager * 95 / w`,
 *         generalised from one draw to a path.
 *
 *         Position choice cannot move it either: the arc start is uniform over
 *         the 5 positions and is drawn AFTER the position is committed, so for
 *         any fixed position exactly H of the 5 arc starts destroy it. Every
 *         position carries probability H/5. The choice is a placement, never a
 *         dodge, and the UI must never claim otherwise.
 *
 *         Exact arithmetic: S_k = P_k / 5^k where P_k is the product of the
 *         surviving-position counts, so
 *
 *             M_k = (19/20) * 5^k / P_k = 19 * 5^(k-1) / (4 * P_k)
 *
 *         which is the reduced rational in `multiplierOf`. Integer division
 *         floors, so realised RTP is at most 95% and never above it.
 *
 *         RESERVE INVARIANT (see CONTRACT_CONSTRAINTS.md "Reserve and payout
 *         must agree to the wei"): before entering WAITING_RANDOMNESS for step
 *         k, `reservedProfit == payoutFor(wager, k) - wager`. That makes every
 *         terminal payout land exactly on the host's `escrowedStake +
 *         reservedProfit` cap, and lets `reservedProfitDelta` be 0 on every
 *         settling step, which is what the InvalidPayout trap requires.
 */
contract FractureRunGame is ICasinoGameV2 {
  uint256 private constant WAD = 1e18;

  /// @dev The five world positions: HILLTOP, ORCHARD, HEARTH, FENCELINE, HOLLOW.
  uint8 public constant POSITIONS = 5;

  /// @dev A run auto-banks here. The cap is what bounds the vault's exposure:
  ///      M_10 is ~111.85x, and `quoteCaps` reserves for it up front.
  uint8 public constant MAX_STEPS = 10;

  /// @dev floor(256 / 5) * 5 — only byte 255 is rejected, leaving 51 preimages
  ///      per position. See RANDOMNESS_DICE.md ("limit = floor(M/n)*n").
  uint8 private constant DRAW_REJECT = 255;

  uint8 public constant ACTION_CASH_OUT = 0;
  uint8 public constant ACTION_CONTINUE = 1;

  error FractureRun__BadGameData();
  error FractureRun__BadPosition();
  error FractureRun__BadAction();
  error FractureRun__BadStep();
  error FractureRun__RunAlreadyOver();

  /**
   * @param step        Steps survived so far (0..MAX_STEPS).
   * @param position    The anchor committed for the step now in flight.
   * @param arcStart    Start of the arc the last resolved step destroyed.
   * @param arcLength   Length of that arc (the hazard H for that step).
   * @param law         Which law did the breaking — presentation only, drawn
   *                    from the same word so it stays verifiable.
   * @param struck      The run ended because the anchor was inside the arc.
   * @param cashedOut   The run ended by banking (explicitly, or the step-10
   *                    auto-bank).
   * @param randomness  The word that resolved the last step.
   */
  struct RunState {
    uint8 step;
    uint8 position;
    uint8 arcStart;
    uint8 arcLength;
    uint8 law;
    bool struck;
    bool cashedOut;
    bytes32 randomness;
  }

  // -------------------------------------------------------------------------
  // Paytable — single source of truth
  // -------------------------------------------------------------------------

  /// @notice Arc length (positions destroyed) at a given step. The world gets
  ///         progressively less survivable: 1 of 5, then 2 of 5, then 3 of 5.
  function hazardAt(uint8 step) public pure returns (uint8) {
    if (step == 0 || step > MAX_STEPS) revert FractureRun__BadStep();
    if (step <= 4) return 1;
    if (step <= 8) return 2;
    return 3;
  }

  /// @notice Survival probability of one step, as the fraction (5 - H) / 5.
  function stepOddsAt(uint8 step) public pure returns (uint8 survivors, uint8 outOf) {
    return (POSITIONS - hazardAt(step), POSITIONS);
  }

  /**
   * @notice The cumulative multiplier after surviving `step` steps, as an exact
   *         reduced rational `num / den`.
   * @dev    num/den == 19 * 5^(step-1) / (4 * P_step), where P_step is the
   *         product of surviving-position counts over the first `step` steps
   *         (4,4,4,4,3,3,3,3,2,2). Tabulated rather than computed so the table
   *         is directly auditable against the published paytable; every entry
   *         is re-derived from first principles by scripts/verify-run-rtp.mjs.
   */
  function multiplierOf(uint8 step) public pure returns (uint256 num, uint256 den) {
    if (step == 1) return (19, 16); //   1.187500x
    if (step == 2) return (95, 64); //   1.484375x
    if (step == 3) return (475, 256); //   1.855469x
    if (step == 4) return (2375, 1024); //   2.319336x
    if (step == 5) return (11875, 3072); //   3.865560x
    if (step == 6) return (59375, 9216); //   6.442600x
    if (step == 7) return (296875, 27648); //  10.737666x
    if (step == 8) return (1484375, 82944); //  17.896111x
    if (step == 9) return (7421875, 165888); //  44.740277x
    if (step == 10) return (37109375, 331776); // 111.850691x
    revert FractureRun__BadStep();
  }

  /// @notice THE payout function. Every other entry point calls this one.
  function payoutFor(uint256 wager, uint8 step) public pure returns (uint256) {
    (uint256 num, uint256 den) = multiplierOf(step);
    return (wager * num) / den;
  }

  /// @notice Profit the vault must reserve to cover a cash-out at `step`.
  function reservedProfitFor(uint256 wager, uint8 step) public pure returns (uint256) {
    uint256 payout = payoutFor(wager, step);
    return payout > wager ? payout - wager : 0;
  }

  /// @notice Probability of surviving all `step` steps, as `num / den`.
  /// @dev    den is 5^step; num is the product of surviving-position counts.
  function survivalOdds(uint8 step) public pure returns (uint256 num, uint256 den) {
    if (step > MAX_STEPS) revert FractureRun__BadStep();
    num = 1;
    den = 1;
    for (uint8 k = 1; k <= step; k++) {
      num *= (POSITIONS - hazardAt(k));
      den *= POSITIONS;
    }
  }

  // -------------------------------------------------------------------------
  // Randomness — unbiased arc, drawn only after the anchor is committed
  // -------------------------------------------------------------------------

  /**
   * @notice Draws the arc start and the breaking law from one VRF word.
   * @dev    256 is not a multiple of 5, so a raw `byte % 5` would over-weight
   *         position 0. Reject byte 255 and only then take `% 5`, giving all
   *         five positions exactly 51 preimages. Two independent draws walk the
   *         same word, rehashing rather than reverting if it is exhausted, so a
   *         paid step can never fail here.
   */
  function drawFromRandomness(
    bytes32 randomness
  ) public pure returns (uint8 arcStart, uint8 law) {
    bytes32 seed = randomness;
    uint256 index = 0;
    uint8[2] memory draws;
    uint256 drawn = 0;

    while (drawn < 2) {
      if (index == 32) {
        seed = keccak256(abi.encodePacked(seed));
        index = 0;
      }
      uint8 sample = uint8(seed[index]);
      index += 1;
      if (sample < DRAW_REJECT) {
        draws[drawn] = sample % POSITIONS;
        drawn += 1;
      }
    }
    return (draws[0], draws[1]);
  }

  /**
   * @notice Whether `position` lies inside the arc of `length` starting at
   *         `arcStart`, walking the ring of five positions.
   * @dev    For any fixed position, exactly `length` of the five arc starts
   *         contain it — which is what makes every position equally dangerous
   *         and every anchor choice EV-neutral.
   */
  function isStruck(uint8 position, uint8 arcStart, uint8 length) public pure returns (bool) {
    return ((position + POSITIONS - arcStart) % POSITIONS) < length;
  }

  // -------------------------------------------------------------------------
  // ICasinoGameV2
  // -------------------------------------------------------------------------

  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    _decodePosition(gameData); // reverts on a malformed anchor
    maxEscrowStake = wager;
    // The whole ladder is committed up front: the player can reach step 10 at
    // any time without another risk check, so the ceiling is the step-10 payout.
    maxReservedProfit = reservedProfitFor(wager, MAX_STEPS);
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
    _decodePosition(gameData);
    maxPayout = payoutFor(wager, MAX_STEPS);
    // The binary tail the vault actually carries: the chance of paying the top
    // multiplier is the chance of surviving the whole ladder.
    (uint256 sNum, uint256 sDen) = survivalOdds(MAX_STEPS);
    probabilityWad = (WAD * sNum) / sDen;
    // S_k * M_k == RTP at every k, so the expected payout is 95% of the wager
    // no matter how the player plays.
    expectedPayout = (wager * 95) / 100;
    subJackpotVarianceScaled = 0;
  }

  function onSessionStart(
    SessionContext calldata ctx
  ) external pure returns (StepResult memory stepResult) {
    uint8 position = _decodePosition(ctx.gameData);

    RunState memory state = RunState({
      step: 0,
      position: position,
      arcStart: 0,
      arcLength: 0,
      law: 0,
      struck: false,
      cashedOut: false,
      randomness: bytes32(0)
    });

    stepResult.newGameState = abi.encode(state);
    stepResult.escrowDelta = 0;
    // Reserve invariant: entering step 1, hold exactly what a step-1 cash-out
    // would pay. Nothing can settle above that until the ladder climbs.
    stepResult.reservedProfitDelta = int256(reservedProfitFor(ctx.wagerBase, 1));
    stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    stepResult.requestRandomnessNow = true;
    stepResult.payout = 0;
  }

  /**
   * @notice The decision point: bank what the run is worth, or anchor reality
   *         somewhere new and take another step.
   * @dev    actionData is `abi.encode(uint8 action, uint8 position)`.
   *         CONTINUE is the ONLY thing that requests randomness, so the word
   *         that resolves a step cannot exist until the anchor is committed —
   *         there is never a future outcome sitting in public chain state for
   *         the player to read ahead. That is the security property the whole
   *         design rests on.
   */
  function onPlayerAction(
    SessionContext calldata ctx,
    bytes calldata actionData
  ) external pure returns (StepResult memory stepResult) {
    RunState memory state = abi.decode(ctx.gameState, (RunState));
    if (state.struck || state.cashedOut) revert FractureRun__RunAlreadyOver();
    // A decision only exists after a survived step and before the auto-bank.
    if (state.step == 0 || state.step >= MAX_STEPS) revert FractureRun__BadStep();

    (uint8 action, uint8 position) = _decodeAction(actionData);

    if (action == ACTION_CASH_OUT) {
      state.cashedOut = true;
      stepResult.newGameState = abi.encode(state);
      stepResult.escrowDelta = 0;
      // Settling step: the host releases the reserve itself, and a negative
      // delta here would drop the payout cap below the win (InvalidPayout).
      stepResult.reservedProfitDelta = 0;
      stepResult.nextPhase = SessionPhase.SETTLED;
      stepResult.requestRandomnessNow = false;
      // Cap is escrowedStake + reservedProfit == wager + (payout_k - wager).
      stepResult.payout = payoutFor(ctx.wagerBase, state.step);
      return stepResult;
    }

    uint8 nextStep = state.step + 1;
    state.position = position;

    stepResult.newGameState = abi.encode(state);
    stepResult.escrowDelta = 0;
    // Climb the reserve to the invariant for the step now in flight. Always
    // non-negative: payouts are non-decreasing in step, so flooring cannot
    // invert them.
    stepResult.reservedProfitDelta = int256(
      payoutFor(ctx.wagerBase, nextStep) - payoutFor(ctx.wagerBase, state.step)
    );
    stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    stepResult.requestRandomnessNow = true;
    stepResult.payout = 0;
  }

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external pure returns (StepResult memory stepResult) {
    RunState memory state = abi.decode(ctx.gameState, (RunState));
    if (state.struck || state.cashedOut) revert FractureRun__RunAlreadyOver();

    uint8 step = state.step + 1;
    uint8 length = hazardAt(step);
    (uint8 arcStart, uint8 law) = drawFromRandomness(randomness);

    state.arcStart = arcStart;
    state.arcLength = length;
    state.law = law;
    state.randomness = randomness;

    stepResult.escrowDelta = 0;
    // 0 on every path out of here: the two settling paths need the cap intact,
    // and the surviving path is already holding exactly the step's cash-out
    // value by the reserve invariant.
    stepResult.reservedProfitDelta = 0;
    stepResult.requestRandomnessNow = false;

    if (isStruck(state.position, arcStart, length)) {
      state.struck = true;
      stepResult.newGameState = abi.encode(state);
      stepResult.nextPhase = SessionPhase.SETTLED;
      stepResult.payout = 0;
      return stepResult;
    }

    state.step = step;

    if (step == MAX_STEPS) {
      // The top of the ladder pays out on its own — there is no decision left
      // to make and no way to lose it back.
      state.cashedOut = true;
      stepResult.newGameState = abi.encode(state);
      stepResult.nextPhase = SessionPhase.SETTLED;
      stepResult.payout = payoutFor(ctx.wagerBase, MAX_STEPS);
      return stepResult;
    }

    stepResult.newGameState = abi.encode(state);
    stepResult.nextPhase = SessionPhase.WAITING_PLAYER_ACTION;
    stepResult.payout = 0;
  }

  /**
   * @notice Cash-out value of an abandoned run.
   * @dev    Unlike the original Fracture, this is a real number rather than 0:
   *         a session sits in WAITING_PLAYER_ACTION only after a step has
   *         already resolved, so the value is settled and no VRF draw is
   *         pending. Quoting it is not adverse selection — it is exactly what
   *         the player could have banked by pressing the key. The host takes
   *         its own forfeit cut on top.
   */
  function quoteForfeitPayout(SessionContext calldata ctx) external pure returns (uint256) {
    RunState memory state = abi.decode(ctx.gameState, (RunState));
    if (state.struck || state.cashedOut) return 0;
    if (state.step == 0 || state.step > MAX_STEPS) return 0;
    return payoutFor(ctx.wagerBase, state.step);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  function _decodePosition(bytes calldata gameData) private pure returns (uint8 position) {
    if (gameData.length != 32) revert FractureRun__BadGameData();
    position = abi.decode(gameData, (uint8));
    if (position >= POSITIONS) revert FractureRun__BadPosition();
  }

  function _decodeAction(
    bytes calldata actionData
  ) private pure returns (uint8 action, uint8 position) {
    if (actionData.length != 64) revert FractureRun__BadGameData();
    (action, position) = abi.decode(actionData, (uint8, uint8));
    if (action > ACTION_CONTINUE) revert FractureRun__BadAction();
    if (position >= POSITIONS) revert FractureRun__BadPosition();
  }
}
