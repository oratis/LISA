# Homebrew formula for Lisa.
#
# NOTE: the live tap (github.com/oratis/homebrew-tap) is the source of truth —
# this file is a template, synced there per release via the docs/PUBLISH.md flow.
#
# This file is the master template. The actual formula that users install
# lives in a separate tap repository: github.com/oratis/homebrew-tap
# at Formula/lisa.rb. Per release, copy this file there and update:
#   - `url`     (npm tarball URL pinned to the new version)
#   - `sha256`  (sha256 of that tarball — compute with curl|shasum -a 256)
#
# See docs/PUBLISH.md for the full release ritual.
class Lisa < Formula
  desc "AI agent with a real self — sovereign, evolving, OSS"
  homepage "https://github.com/oratis/LISA"
  # Use the npm tarball, NOT the GitHub source tarball — it ships pre-built
  # dist/ (compiled JS + 114 pixel-art mood portraits) so the formula doesn't
  # need to run `tsc` (which would require TypeScript devDependencies that
  # `npm install --global` skips).
  url "https://registry.npmjs.org/@oratis/lisa/-/lisa-0.9.0.tgz"
  sha256 "da8d56dcbad0d8f7a5f36b0d04f2e7ffac8ef9dee2af3fe3333b700bc69e69c4"
  license "MIT"
  head "https://github.com/oratis/LISA.git", branch: "main"

  depends_on "node"
  # `git` is in the base macOS toolchain on every supported version, but list
  # explicitly because the soul history feature requires it.
  uses_from_macos "git"

  def install
    # The npm tarball ships pre-built dist/ but no node_modules/. Install
    # runtime deps only (no devDeps needed since we don't compile here).
    system "npm", "install", "--omit=dev", "--no-audit", "--no-fund",
                             "--no-package-lock", "--ignore-scripts"

    # IMPORTANT: completions must be installed BEFORE libexec.install Dir["*"]
    # because that move-step consumes the buildpath's `completions/` dir.
    bash_completion.install "completions/lisa.bash" => "lisa"
    zsh_completion.install "completions/_lisa"
    (prefix/"share/fish/vendor_completions.d").install "completions/lisa.fish"

    # Everything else (dist/, node_modules/, package.json, README) → libexec.
    libexec.install Dir["*"]

    # Wire `lisa` into the bin path with a shim that runs the bundled CLI.
    (bin/"lisa").write <<~SHIM
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/cli.js" "$@"
    SHIM
    chmod 0755, bin/"lisa"
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
