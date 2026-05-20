# Fish completion for `lisa`.
#
# Install:
#   cp lisa.fish ~/.config/fish/completions/lisa.fish
#
# Fish loads completions automatically — no shell restart needed.

# ── helper: list skills ─────────────────────────────────────────────
function __lisa_skill_slugs
    if test -d "$HOME/.lisa/skills"
        for d in "$HOME/.lisa/skills"/*/
            basename $d
        end
    end
end

# ── helper: did the user already type a subcommand? ─────────────────
function __lisa_no_subcommand
    set cmd (commandline -opc)
    set sub resume sessions serve heartbeat search birth soul channels skills wishlist status doctor monitor
    for word in $cmd[2..-1]
        if contains -- $word $sub
            return 1
        end
    end
    return 0
end

function __lisa_using_subcommand
    set cmd (commandline -opc)
    for word in $cmd[2..-1]
        if test "$word" = "$argv[1]"
            return 0
        end
    end
    return 1
end

# ── subcommands (only when none typed yet) ──────────────────────────
complete -c lisa -n __lisa_no_subcommand -f -a resume     -d "resume a previous session"
complete -c lisa -n __lisa_no_subcommand -f -a sessions   -d "list recent sessions"
complete -c lisa -n __lisa_no_subcommand -f -a serve      -d "start web UI / IM channels"
complete -c lisa -n __lisa_no_subcommand -f -a heartbeat  -d "run / install scheduled tasks"
complete -c lisa -n __lisa_no_subcommand -f -a search     -d "search past sessions"
complete -c lisa -n __lisa_no_subcommand -f -a birth      -d "run birth ritual"
complete -c lisa -n __lisa_no_subcommand -f -a soul       -d "print soul summary"
complete -c lisa -n __lisa_no_subcommand -f -a channels   -d "list channel adapters"
complete -c lisa -n __lisa_no_subcommand -f -a skills     -d "manage executable skills"
complete -c lisa -n __lisa_no_subcommand -f -a wishlist   -d "Lisa's own toolset feedback"
complete -c lisa -n __lisa_no_subcommand -f -a status     -d "one-shot snapshot"
complete -c lisa -n __lisa_no_subcommand -f -a doctor     -d "health check"
complete -c lisa -n __lisa_no_subcommand -f -a monitor    -d "TUI live dashboard"

# ── skills sub-actions ──────────────────────────────────────────────
complete -c lisa -n "__lisa_using_subcommand skills" -f -a list     -d "list executable skills"
complete -c lisa -n "__lisa_using_subcommand skills" -f -a approve  -d "approve a skill"
complete -c lisa -n "__lisa_using_subcommand skills" -f -a disable  -d "block a skill"
complete -c lisa -n "__lisa_using_subcommand skills" -f -a enable   -d "remove disable"
complete -c lisa -n "__lisa_using_subcommand skills" -f -a audit    -d "show audit trail"
complete -c lisa -n "__lisa_using_subcommand skills" -f -a "(__lisa_skill_slugs)" -d "skill slug"

# ── heartbeat sub-actions ───────────────────────────────────────────
complete -c lisa -n "__lisa_using_subcommand heartbeat" -f -a run       -d "run once"
complete -c lisa -n "__lisa_using_subcommand heartbeat" -f -a install   -d "install launchd plist"
complete -c lisa -n "__lisa_using_subcommand heartbeat" -f -a uninstall -d "remove plist"

# ── global flags ────────────────────────────────────────────────────
complete -c lisa -l help         -s h -d "show help"
complete -c lisa -l version      -s v -d "print version and exit"
complete -c lisa -l think              -d "enable adaptive thinking"
complete -c lisa -l no-reflect         -d "skip end-of-session reflection"
complete -c lisa -l compact            -d "enable Anthropic context compaction"
complete -c lisa -l no-mcp             -d "skip MCP loading"
complete -c lisa -l no-plugins         -d "skip plugin loading"
complete -c lisa -l voice              -d "enable speak/transcribe"
complete -c lisa -l no-idle            -d "disable idle mode"
complete -c lisa -l web                -d "start web UI (with serve)"
complete -c lisa -l imessage           -d "start iMessage (with serve)"

# ── flags with arguments ────────────────────────────────────────────
complete -c lisa -l model     -r -d "LLM model" -a "claude-sonnet-4-5-20250929 claude-opus-4 gpt-5 gpt-4o o3 gemini-2.5-pro gemini-2.5-flash deepseek-chat doubao-1.5-pro-32k qwen3-72b-instruct moonshot-v1-32k grok-2-latest glm-4.5"
complete -c lisa -l provider  -r -d "provider"  -a "anthropic openai gemini"
complete -c lisa -l approval  -r -d "approval mode" -a "auto ask ask-mutating"
complete -c lisa -l idle      -r -d "idle minutes"
complete -c lisa -l port      -r -d "web UI port"
complete -c lisa -l channels  -r -d "comma-separated channels" -a "telegram discord slack feishu webhook imessage all"
