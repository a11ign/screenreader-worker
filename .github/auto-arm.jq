# The pull requests auto-arm.yml arms: open (the caller lists only open ones), non-draft, not already armed, and not
# held. A `hold:` label is a hold, whoever put it there (a11ign/agent-org's `pr-hold-state.mjs`). Reads the JSON of
# `gh pr list --json number,isDraft,labels,autoMergeRequest` and prints one number per line.
# scripts/auto-arm-filter.test.ts runs THIS file, so the workflow and the test cannot disagree about it.
.[]
| select(.isDraft == false and .autoMergeRequest == null and ([.labels[].name | startswith("hold:")] | any | not))
| .number
