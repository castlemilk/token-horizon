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

# quick CLI: nm, nm usage, nm sys, nm events
th() { curl -s -m 2 "${TOKEN_HORIZON_URL%/}/${1:-health}" | python3 -m json.tool 2>/dev/null || echo "token horizon not running"; }
