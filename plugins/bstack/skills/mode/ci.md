# CI

For writing or changing workflows. Every check that guards the default branch runs on every pull request. Moving, skipping or removing one to save minutes is a weakened check: tier 2, and the user's call. Within that, spend no minute that buys nothing: on private repos minutes are [billed](https://docs.github.com/en/billing/concepts/product-billing/github-actions), and when the allowance is spent without a payment method, CI stops and nothing merges.

- Trigger on `pull_request` and on pushes to the default branch. A push trigger on every branch runs each PR push twice.
- A `concurrency` group per ref with `cancel-in-progress`.
- `timeout-minutes` on every job, a few times its usual runtime. The default is 6 hours.
- Each job rounds up to a whole minute and repeats its setup: short steps that share a setup go in one job.
- Windows and macOS minutes cost more than Linux: a leg per platform the product runs on, no more.
- Cache dependency installs.
- No path filters on gating workflows: a filtered PR gets no check, or a required one stuck pending, and the merge guard blocks a PR where no check ran.
- Release builds, images and publishing run where they are used, unless building them is the check.
- Schedule only what a pull request cannot catch, as rarely as still catches it.
- CI never commits to a branch: the commit starts another run.
