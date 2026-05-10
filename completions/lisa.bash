# Bash completion for `lisa`.
#
# Install:
#   sudo cp lisa.bash /etc/bash_completion.d/lisa     # system-wide
# OR
#   cp lisa.bash ~/.lisa-completion.bash
#   echo 'source ~/.lisa-completion.bash' >> ~/.bashrc
#
# Reload your shell or `source ~/.bashrc`.

_lisa_completion() {
    local cur prev words cword
    _init_completion -n : 2>/dev/null || _get_comp_words_by_ref -n : cur prev words cword

    local subcommands="resume sessions serve heartbeat search birth soul channels skills wishlist status doctor monitor"
    local global_flags="--model --provider --think --no-reflect --compact --approval --no-mcp --no-plugins --voice --idle --no-idle --help -h"
    local serve_flags="--web --imessage --channels --port"
    local skills_actions="list approve disable enable audit"
    local heartbeat_actions="run install uninstall"
    local approval_modes="auto ask ask-mutating"
    local providers="anthropic openai gemini"
    local models="claude-sonnet-4-5-20250929 claude-opus-4 claude-haiku-4 gpt-5 gpt-4o o3 o4-mini gemini-2.5-pro gemini-2.5-flash deepseek-chat deepseek-reasoner doubao-1.5-pro-32k qwen3-72b-instruct moonshot-v1-32k kimi-128k grok-2-latest glm-4.5"

    # If we just typed `lisa` and now want a token, suggest subcommand or "prompt"
    if [ ${cword} -eq 1 ]; then
        COMPREPLY=( $(compgen -W "${subcommands}" -- "${cur}") )
        return 0
    fi

    # Flag value completion
    case "${prev}" in
        --model)
            COMPREPLY=( $(compgen -W "${models}" -- "${cur}") )
            return 0
            ;;
        --provider)
            COMPREPLY=( $(compgen -W "${providers}" -- "${cur}") )
            return 0
            ;;
        --approval)
            COMPREPLY=( $(compgen -W "${approval_modes}" -- "${cur}") )
            return 0
            ;;
        --idle|--port)
            return 0  # numeric, no completion
            ;;
        --channels)
            COMPREPLY=( $(compgen -W "telegram discord slack feishu webhook imessage all" -- "${cur}") )
            return 0
            ;;
    esac

    # Subcommand-specific completion
    local sub=""
    for w in "${words[@]:1}"; do
        case "${w}" in
            -*) ;;
            *) sub="${w}"; break ;;
        esac
    done

    case "${sub}" in
        skills)
            if [ ${cword} -eq 2 ]; then
                COMPREPLY=( $(compgen -W "${skills_actions}" -- "${cur}") )
                return 0
            fi
            # 3rd argument: skill slug — list dirs in ~/.lisa/skills/
            if [ -d "${HOME}/.lisa/skills" ]; then
                local slugs
                slugs=$(ls -1 "${HOME}/.lisa/skills" 2>/dev/null | grep -v '^\.')
                COMPREPLY=( $(compgen -W "${slugs}" -- "${cur}") )
                return 0
            fi
            ;;
        heartbeat)
            if [ ${cword} -eq 2 ]; then
                COMPREPLY=( $(compgen -W "${heartbeat_actions}" -- "${cur}") )
                return 0
            fi
            ;;
        serve)
            COMPREPLY=( $(compgen -W "${serve_flags} ${global_flags}" -- "${cur}") )
            return 0
            ;;
    esac

    # Default: global flags
    if [[ "${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "${global_flags}" -- "${cur}") )
    fi
}

complete -F _lisa_completion lisa
