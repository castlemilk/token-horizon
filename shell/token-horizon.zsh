# Token Horizon shell integration — reports command activity to the statusline app.
# Source from ~/.zshrc after starship init.

typeset -g TOKEN_HORIZON_URL="${TOKEN_HORIZON_URL:-http://127.0.0.1:8765}"
typeset -g _TOKEN_HORIZON_T0

zmodload zsh/datetime 2>/dev/null

_tokenhorizon_preexec() {
    _TOKEN_HORIZON_T0=${EPOCHREALTIME:-$SECONDS.0}
}

_tokenhorizon_precmd() {
    local rc=$?
    local t1=${EPOCHREALTIME:-$SECONDS.0}
    local dur
    dur=$(printf '%.0f' $(( (t1 - ${_TOKEN_HORIZON_T0:-$t1}) * 1000 )) 2>/dev/null) || dur=0
    (
        curl -s -m 1 -X POST "$TOKEN_HORIZON_URL/event" \
            --data-urlencode "cwd=$PWD" \
            --data-urlencode "dur=${dur:-0}" \
            --data-urlencode "exit=$rc" >/dev/null 2>&1
    ) >/dev/null 2>&1 &!
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _tokenhorizon_preexec
add-zsh-hook precmd _tokenhorizon_precmd

# quick CLI: th, th stats, th limits, th history, th cache, th reset-cache, th leaderboard, th share
th() {
    local cmd="${1:-health}"
    shift 2>/dev/null || true
    if [[ "$cmd" == "reset-cache" ]]; then cmd="cache/reset"; fi
    if [[ "$cmd" == "leaderboard" || "$cmd" == "lb" ]]; then
        local sub="${1:-today}"
        if [[ "$sub" == "publish" || "$sub" == "push" ]]; then
            local target="cloudflare"
            if [[ "$2" == "--sheets" || "$2" == "sheets" ]]; then target="sheets"; fi
            if [[ "$2" == "--cf" || "$2" == "cf" || "$2" == "--cloud" ]]; then target="cloudflare"; fi
            curl -s -m 12 -X POST "${TOKEN_HORIZON_URL%/}/leaderboard/${target}/publish" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
            return 0
        elif [[ "$sub" == "pull" || "$sub" == "sync" ]]; then
            local target="cloudflare"
            if [[ "$2" == "--sheets" || "$2" == "sheets" ]]; then target="sheets"; fi
            if [[ "$2" == "--cf" || "$2" == "cf" || "$2" == "--cloud" ]]; then target="cloudflare"; fi
            curl -s -m 12 -X POST "${TOKEN_HORIZON_URL%/}/leaderboard/${target}/pull" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
            return 0
        elif [[ "$sub" == "web" || "$sub" == "pages" || "$sub" == "open" ]]; then
            local target
            target=$(curl -s -m 2 -I "${TOKEN_HORIZON_URL%/}/leaderboard/web" 2>/dev/null | grep -i "^Location:" | awk '{print $2}' | tr -d '\r\n')
            if [[ -z "$target" ]]; then
                target="https://token-horizon.dev/leaderboard"
            fi
            echo "Opening Leaderboard: $target"
            open "$target" 2>/dev/null || xdg-open "$target" 2>/dev/null || echo "$target"
            return 0
        elif [[ "$sub" == "config" ]]; then
            if [[ "$2" == "cf" || "$2" == "cloudflare" || "$2" == "cloud" ]]; then
                if [[ -n "$3" ]]; then
                    curl -s -m 3 -X POST "${TOKEN_HORIZON_URL%/}/leaderboard/cloudflare/config" --data-urlencode "cloudflareURL=$3" ${4:+--data-urlencode "cloudToken=$4"} | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
                else
                    curl -s -m 3 "${TOKEN_HORIZON_URL%/}/leaderboard/cloudflare/config" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
                fi
            elif [[ "$2" == "sheets" ]]; then
                if [[ -n "$3" ]]; then
                    curl -s -m 3 -X POST "${TOKEN_HORIZON_URL%/}/leaderboard/sheets/config" --data-urlencode "sheetsURL=$3" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
                else
                    curl -s -m 3 "${TOKEN_HORIZON_URL%/}/leaderboard/sheets/config" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
                fi
            elif [[ -n "$2" ]]; then
                curl -s -m 3 -X POST "${TOKEN_HORIZON_URL%/}/leaderboard/cloudflare/config" --data-urlencode "cloudflareURL=$2" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
            else
                curl -s -m 3 "${TOKEN_HORIZON_URL%/}/leaderboard/sheets/config" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
            fi
            return 0
        fi
        local period="${sub:-today}"
        local team="${2:-}"
        local url="${TOKEN_HORIZON_URL%/}/leaderboard?period=$period"
        if [[ -n "$team" ]]; then url="${url}&team=$team"; fi
        curl -s -m 3 "$url" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
        return 0
    fi
    if [[ "$cmd" == "share" ]]; then
        local format="text"
        local period="today"
        local copy=0
        for arg in "$@"; do
            if [[ "$arg" == "--copy" || "$arg" == "-c" ]]; then
                copy=1
            elif [[ "$arg" == "text" || "$arg" == "markdown" || "$arg" == "md" || "$arg" == "json" || "$arg" == "svg" ]]; then
                format="$arg"
            elif [[ "$arg" == "today" || "$arg" == "week" || "$arg" == "7d" || "$arg" == "all" || "$arg" == "streak" ]]; then
                period="$arg"
            fi
        done
        local res
        res=$(curl -s -m 3 "${TOKEN_HORIZON_URL%/}/leaderboard/share?format=$format&period=$period")
        if [[ $? -ne 0 || -z "$res" ]]; then
            echo "token horizon not running"
            return 1
        fi
        printf "%s\n" "$res"
        if [[ $copy -eq 1 ]] && command -v pbcopy >/dev/null 2>&1; then
            printf "%s" "$res" | pbcopy
            echo "📋 Copied share card to clipboard."
        fi
        return 0
    fi
    curl -s -m 2 "${TOKEN_HORIZON_URL%/}/$cmd" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"
}
