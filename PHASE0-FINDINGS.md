# Phase 0 findings — placeholders replaced with verified SDK reality

Every item in the build plan's Sections 3–5 marked "TBD / confirm in Phase 0" is resolved
below. Verified against the **official** SDK (`@chain/casino-sdk` v0.2.0, release
`2026.09.15-1`), downloaded from `https://sdk.chain.wtf/sdk/casino-sdk.zip`, running
locally.

## How the SDK is actually obtained

`@chain/casino-sdk` is **not on npm** (`npm view` → 404). It is distributed two ways:

- Zip: `https://sdk.chain.wtf/sdk/casino-sdk.zip` (the `/sdk/casino-sdk.zip` link on
  `https://sdk.chain.wtf/casino` — note the path repeats `sdk`).
- shadcn registry: `npx shadcn@latest add @chain=https://chain-ui.vercel.app/r/{name}.json`
  then `npx shadcn@latest add @chain/casino-sdk`.

**Do not vendor the SDK from another jam entry's repo.** The SDK's own `.gitignore`
excludes `local-verify-network/`, so the copy committed in public entry repos is missing
the VRF node and its npm workspace will not install. The copy in `Fraeiy/tug` is also one
release behind and is missing an interface method that is now required (below).

## Corrections to the plan's contract assumptions

| Plan assumed | Reality |
|---|---|
| `pragma ^0.8.20` | `^0.8.30` |
| Contract holds state | **Stateless.** All five handlers are `view`/`pure`, reached by `staticcall`. Session state round-trips as `bytes` in `ctx.gameState` → `StepResult.newGameState`. |
| 3 methods (open / randomness / settle) | **6 methods**, all required: `quoteCaps`, `quoteRiskParams`, `onSessionStart`, `onPlayerAction`, `onRandomness`, `quoteForfeitPayout`. |
| "an open-session hook … a payout/settlement path back through the bridge" | There is no separate settlement path. `onRandomness` returns `StepResult.payout` and a terminal `nextPhase`; the facet settles. |
| VRF word type TBD | Confirmed `bytes32`, delivered to `onRandomness(SessionContext, bytes32)`. |
| Import `./ICasinoGameV2.sol` from a new `simulator/contracts/` | Correct path, but the interface **moved** in the 2026.09.15 release from `solidity/` to `simulator/contracts/`. Any path ending in `ICasinoGameV2.sol` also resolves. |
| `manifest.json` at repo root | `public/game.manifest.json`, served next to the frontend. Zod-validated; schema in `src/manifest.ts`. |
| Fork `examples/coinflip/` | The directory is `examples/coinflip-public/`. |

Two plan assumptions turned out **correct**: the VRF word is `bytes32`, and rejection
sampling is mandatory — the SDK makes it an explicit MUST in `CONTRACT_CONSTRAINTS.md`,
with the general rule `limit = floor(M/n)*n`. For our 100 buckets that is exactly the
plan's `THRESHOLD = 200`.

One plan detail was **wrong in a way that would have cost money**: the plan's fallback
takes a single re-hashed byte as a "safety net". The SDK's canonical form loops —
rehash and keep scanning. Ours loops.

### Stale doc warning

`CONTRACT_CONSTRAINTS.md` still lists an `outcome` field on `StepResult`; the interface
has no such field. It also claimed `onSessionStart` is called twice — the changelog
retracts this ("the facet has called it once since the stateless-session release"). The
doc says to treat the source as authoritative when it drifts. Outcome is carried in
`newGameState`.

## The two traps that would have broken Fracture specifically

New in the 2026.09.15 release, `CONTRACT_CONSTRAINTS.md` § "Payout cap". Both only
surface on the **largest** win, so casual testing misses them. Fracture's Void pays 19×.

1. **Reserve and payout must agree to the wei.** If `onRandomness` computes the payout
   through a different formula than the reserve committed by `onSessionStart`, rounding
   puts the payout a base unit above budget and *every top-multiplier win reverts*.
   → Mitigated: all six entry points route through one `payoutFor()`.
2. **Don't release reserved profit on the settling step.** Returning a negative
   `reservedProfitDelta` when settling lowers the cap before the payout check.
   → Mitigated: `reservedProfitDelta = 0` in `onRandomness`, with a comment saying why.

`quoteForfeitPayout` must return **0** for Fracture. The SDK is explicit that quoting a
real value when mid-round value depends on unresolved randomness is an adverse-selection
exploit against the vault. Fracture's mid-round value is *entirely* unresolved randomness.

## The RTP math got simpler, not harder

The plan's hand-written basis-point table (`21111`, `38000`, `63333`, …) is unnecessary
and slightly lossy. Because RTP and probability share the same denominator, the payout
multiplier for an outcome holding `w` of the 100 buckets collapses to:

```
multiplier = RTP / p = (95/100) / (w/100) = 95 / w
payout     = wager * 95 / w
```

One formula, five outcomes, full wei precision, and the RTP identity is a one-liner:

```
p * multiplier = (w/100) * (95/w) = 95/100 = 95%     for every w
```

There is no per-outcome constant that can drift, so there is nothing to hand-tune and
nothing to re-derive if `RTP_NUM` changes. Floor division means realised RTP is at most
95% and never above — verified, worst observed shortfall 35 wei on a 1e18 wager.

## Verified working (not assumed)

- `sdk/casino-sdk` installs clean (`npm install`, exit 0) and `npm start` brings up the
  in-memory Hardhat chain (31337), the real Verify Network VRF router + fulfilling node,
  `LocalTestToken`, `LocalCasinoHost`, and `CoinflipGame`.
- Simulator on :3300, coinflip on :3100, both HTTP 200. **Phase 0 gate met.**
- `FractureGame.sol` compiles under the harness's own solc settings (viaIR, runs=200) and
  auto-deploys via the folder watcher.
- `npm run verify:rtp` — 22 checks, all pass, enumerated against **deployed bytecode**
  (not a TS re-implementation): the 100-bucket partition is exactly 45/25/15/10/5, every
  bucket has exactly 2 accepted byte preimages (the naive `% 100` control check shows
  min 2 / max 3 — i.e. the bias is real), probability × payout is exactly 95% for all
  five outcomes, `probabilityWad` sums to exactly 1e18, and stake + reserve == payout
  to the wei.
- `node scripts/e2e-round.mjs` — full loop through the real facet and real VRF for all
  five predictions, **including a forced 19× Void win** (landed attempt 10, paid exactly
  19.0 chUSD, no `InvalidPayout`). **Phase 1 gate met, and exceeded** — the plan only
  asked for one hardcoded Gravity outcome on Sep 17.

## Submission facts confirmed from jam.chain.wtf

- Deadline **September 20, 2026, 23:59 UTC**, judging ten days, winners ~October 1.
- Widget tag, current and exact:
  `<script async src="https://jam.chain.wtf/widget.js"></script>`
  The submission check fetches your URL and **rejects the entry if the tag is absent**.
- Submission form fields: title, game URL, declared RTP (validated `93 <= rtp <= 98`),
  Discord, X, Telegram, source access, pitch.
- Eligibility, verbatim: implements the SDK exactly (contract, bridge, manifest); runs in
  the local simulator and loads near-instantly; RTP 93–98% with declared math matching the
  actual paytable; recognisably a casino game; novel concept; standalone playable demo
  outside the iframe; widget on the page; source shared.
