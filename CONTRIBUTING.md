# Contributing

Thanks for your interest in aloud.

## How to contribute

1. Open an issue first for anything bigger than a typo fix. Describe the problem before the solution.
2. Fork the repo and make your change on a branch.
3. Run the checks before you open a pull request:

```bash
npm install
npm test
```

4. Open a pull request. Keep it small and focused. One change per pull request.

## Ground rules

- The audit logic is conservative on purpose. It never passes a screen silently. Changes that weaken that guarantee will not be merged.
- The TalkBack build is pinned to a specific commit because the speech extractors are verified against it. If you bump the pin, re-verify the extractors. See `docs/talkback.md`.
- New checks need a unit test in `test/`.
- Write docs in plain, short sentences.

## Legal

This project is in the public domain under [CC0 1.0](LICENSE). By contributing, you agree that your contributions are dedicated to the public domain under the same terms.
