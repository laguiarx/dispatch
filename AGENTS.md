<!-- fallow:setup-hooks:start -->

## Local gates

Before any `git commit` or `git push`, run `bun run test` to confirm the test suite still passes.

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking.

<!-- fallow:setup-hooks:end -->
