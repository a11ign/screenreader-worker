Lever A of #5654 (agent-org#1643): the per-field activation's share of the time left is a quarter, not a half (`ACTIVATION_SHARE_OF_REMAINING` in `src/capture-pure.ts`), and `src/activation-budget.test.ts` pins that value. This row closes on the recapture's reading in `docs/capture-cost.md`, not on this pull request: the command below checks the constant and its pin at this head only.

Acceptance: `grep -q "^export const ACTIVATION_SHARE_OF_REMAINING = 0.25;" src/capture-pure.ts && grep -q "assert.equal(ACTIVATION_SHARE_OF_REMAINING, 0.25);" src/activation-budget.test.ts`
