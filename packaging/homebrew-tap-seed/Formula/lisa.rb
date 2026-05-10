# Homebrew formula for Lisa.
#
# This file is the master template. The actual formula that users install
# lives in a separate tap repository: github.com/oratis/homebrew-tap
# at Formula/lisa.rb. Per release, copy this file there and update:
#   - `version`
#   - `url`  (matching the tag)
#   - `sha256`  (sha256 of the tagged .tar.gz)
#
# See docs/PUBLISH.md for the full release ritual.
class Lisa < Formula
  desc "AI agent with a real self — sovereign, evolving, OSS"
  homepage "https://github.com/oratis/LISA"
  # Bump per release:
  url "https://github.com/oratis/LISA/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"
  head "https://github.com/oratis/LISA.git", branch: "main"

  depends_on "node"
  # `git` is in the base macOS toolchain on every supported version, but list
  # explicitly because the soul history feature requires it.
  uses_from_macos "git"

  def install
    # Install npm deps, build TypeScript, prep assets for the bundled CLI.
    system "npm", "install", *std_npm_args(prepend_node_path: true)
    system "npm", "run", "build"

    # Install everything via libexec so we don't pollute the prefix.
    libexec.install Dir["*"]

    # Wire `lisa` into the bin path with a shim that runs the bundled CLI.
    (bin/"lisa").write <<~SHIM
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/cli.js" "$@"
    SHIM
    chmod 0755, bin/"lisa"

    # Shell completions (zsh + bash). Fish completion can be opted-in by
    # symlinking ~/.config/fish/completions/lisa.fish manually — Homebrew
    # doesn't have a standard fish-completion install path on every platform.
    bash_completion.install "completions/lisa.bash" => "lisa"
    zsh_completion.install "completions/_lisa"
    (prefix/"share/fish/vendor_completions.d").install "completions/lisa.fish"
  end

  def caveats
    <<~CAVEATS
      Lisa runs on your own machine — sovereign by design. Set up an LLM key:

        mkdir -p ~/.lisa
        echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lisa/config.env

      Or use any other supported provider (DeepSeek, Gemini, Ollama, …):
        https://github.com/oratis/LISA/blob/main/docs/PROVIDERS.md

      First launch:
        lisa             # interactive REPL
        lisa serve --web # browser UI on http://localhost:5757

      First-run birth ritual takes ~30 seconds (one-time).

      Diagnostics if something doesn't work:
        lisa doctor
    CAVEATS
  end

  test do
    # Smoke: --help shouldn't crash.
    assert_match "Lisa", shell_output("#{bin}/lisa --help")
  end
end
