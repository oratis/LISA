# homebrew-tap

Homebrew tap for [Lisa](https://github.com/oratis/LISA) — an AI agent with a real self.

## Install

```sh
brew tap oratis/tap
brew install lisa
```

That's it. First launch:

```sh
mkdir -p ~/.lisa
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env

lisa             # interactive REPL
lisa serve --web # browser UI on http://localhost:5757
```

Other LLM providers (DeepSeek, Gemini, Ollama, …) — see the [provider recipes](https://github.com/oratis/LISA/blob/main/docs/PROVIDERS.md).

## Updates

```sh
brew update && brew upgrade lisa
```

## What you get

- The `lisa` binary, linked into Homebrew's prefix
- Bash + zsh tab-completion (auto-installed if those shells are set up)
- Fish completion in `vendor_completions.d` (auto-loaded if fish is installed)

## Reporting issues

For Lisa itself: [oratis/LISA/issues](https://github.com/oratis/LISA/issues).

For tap-specific problems (formula breaks, Homebrew install fails): open here.

## Maintenance

This tap is auto-maintained. The `Formula/lisa.rb` file is generated per release from the master template at [oratis/LISA/packaging/homebrew/lisa.rb](https://github.com/oratis/LISA/blob/main/packaging/homebrew/lisa.rb). Per-release flow lives in [docs/PUBLISH.md §2](https://github.com/oratis/LISA/blob/main/docs/PUBLISH.md).

## License

MIT — same as Lisa.
