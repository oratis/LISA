# Shell completions for `lisa`

Tab-completion for subcommands, flags, model names, channel names, and (skills sub-action / slug) pairs.

## Install

### Bash

```sh
# System-wide:
sudo cp lisa.bash /etc/bash_completion.d/lisa

# OR user-local:
cp lisa.bash ~/.lisa-completion.bash
echo 'source ~/.lisa-completion.bash' >> ~/.bashrc
```

Reload: `source ~/.bashrc` or open a new shell.

### Zsh

```sh
mkdir -p ~/.zsh/completions
cp _lisa ~/.zsh/completions/_lisa
```

Add to `~/.zshrc` if not already there:

```sh
fpath=(~/.zsh/completions $fpath)
autoload -U compinit && compinit
```

Reload shell.

### Fish

```sh
cp lisa.fish ~/.config/fish/completions/lisa.fish
```

No reload needed — fish auto-loads completions.

## What gets completed

| Position | Suggestions |
|---|---|
| First arg | The 13 subcommands |
| `--model` value | 17 common model names across providers |
| `--provider` value | `anthropic` / `openai` / `gemini` |
| `--approval` value | `auto` / `ask` / `ask-mutating` |
| `--channels` value | `telegram` / `discord` / `slack` / `feishu` / `webhook` / `imessage` / `all` |
| 2nd arg after `lisa skills` | `list` / `approve` / `disable` / `enable` / `audit` |
| 3rd arg after `lisa skills <action>` | Slugs scanned from `~/.lisa/skills/` |
| 2nd arg after `lisa heartbeat` | `run` / `install` / `uninstall` |
| Generic flag completion | All global flags |

## Future via Homebrew

Once the Homebrew formula ships, completions install automatically:

```sh
brew install lisa-ai/tap/lisa
# bash + zsh completions land in $HOMEBREW_PREFIX/etc/bash_completion.d/
# and $HOMEBREW_PREFIX/share/zsh/site-functions/ respectively.
```
