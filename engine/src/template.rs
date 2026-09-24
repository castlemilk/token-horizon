// Chat template rendering — HF `chat_template` from tokenizer_config.json
// is Jinja2; minijinja handles the standard templates (Qwen, Llama, Mistral
// families). A minimal fallback formats role-tagged turns when a model
// ships no template.

use anyhow::Result;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Read `chat_template` out of a tokenizer_config.json in `dir`.
pub fn chat_template_from(dir: &Path) -> Option<String> {
    chat_template_file(&dir.join("tokenizer_config.json"))
}

pub fn chat_template_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v["chat_template"].as_str().map(String::from)
}

/// Render the chat template, or fall back to a generic role format.
pub fn render(
    template: Option<&str>,
    messages: &[ChatMessage],
    bos: Option<&str>,
) -> Result<String> {
    match template {
        Some(t) => render_jinja(t, messages, bos),
        None => Ok(render_fallback(messages)),
    }
}

fn render_jinja(
    template: &str,
    messages: &[ChatMessage],
    bos: Option<&str>,
) -> Result<String> {
    let mut env = minijinja::Environment::new();
    // HF templates commonly reference these helpers; provide safe versions.
    env.add_function("strftime_now", |fmt: String| {
        let _ = fmt;
        chrono_free_date()
    });
    env.add_function("raise_exception", |msg: String| -> Result<String, minijinja::Error> {
        Err(minijinja::Error::new(minijinja::ErrorKind::InvalidOperation, msg))
    });
    // HF templates are written for Python Jinja where strings have methods;
    // minijinja exposes the same ops as filters/tests. Preprocess turns
    // `x.startswith(y)` into `x|startswith(y)`; these filters close the gap.
    env.add_filter("startswith", |s: String, p: String| s.starts_with(&p));
    env.add_filter("endswith", |s: String, p: String| s.ends_with(&p));
    env.add_filter("strip", |s: String, chars: Option<String>| match chars {
        Some(c) => s.trim_matches(|ch| c.contains(ch)).to_string(),
        None => s.trim().to_string(),
    });
    env.add_filter("lstrip", |s: String, chars: Option<String>| match chars {
        Some(c) => s.trim_start_matches(|ch| c.contains(ch)).to_string(),
        None => s.trim_start().to_string(),
    });
    env.add_filter("rstrip", |s: String, chars: Option<String>| match chars {
        Some(c) => s.trim_end_matches(|ch| c.contains(ch)).to_string(),
        None => s.trim_end().to_string(),
    });
    env.add_filter(
        "get",
        |v: minijinja::Value, k: minijinja::Value, d: Option<minijinja::Value>| {
            v.get_item(&k).unwrap_or_else(|_| d.unwrap_or(minijinja::Value::UNDEFINED))
        },
    );
    let processed = preprocess(template);
    let tmpl = env.template_from_str(&processed)?;
    let out = tmpl.render(minijinja::context! {
        messages => messages,
        add_generation_prompt => true,
        bos_token => bos.unwrap_or(""),
        eos_token => "",
    })?;
    Ok(out)
}

/// Translate Pythonisms common in HF chat templates to minijinja syntax.
/// HF templates are written for Python Jinja where strings have methods;
/// minijinja exposes the same ops as filters — and requires a filtered
/// expression to be parenthesized before subscripting, so `x.split(a)[-1]`
/// becomes `(x|split(a))[-1]`, not `x|split(a)[-1]`. `x[::-1]` → `x|reverse`.
fn preprocess(t: &str) -> String {
    let mut s = t.to_string();
    s = s.replace("[::-1]", "|reverse");
    rewrite_method_calls(&mut s);
    s
}

const PY_METHODS: &[&str] = &[
    "startswith", "endswith", "strip", "lstrip", "rstrip", "split", "replace",
    "lower", "upper", "capitalize", "title", "items", "keys", "values", "get",
];

/// Rewrite `RECV.method(ARGS)` → `(RECV|method(ARGS))`. RECV is the
/// expression immediately before the dot: an identifier chain possibly
/// interleaved with subscripts, calls and string literals.
fn rewrite_method_calls(s: &mut String) {
    loop {
        let bytes = s.as_bytes();
        // earliest `.method(` outside a string literal wins
        let mut hit: Option<(usize, &'static str)> = None;
        for m in PY_METHODS {
            let pat = format!(".{m}(");
            let mut from = 0;
            while let Some(off) = s[from..].find(&pat) {
                let pos = from + off;
                if !inside_string(bytes, pos) {
                    if hit.map(|(p, _)| pos < p).unwrap_or(true) {
                        hit = Some((pos, m));
                    }
                    break;
                }
                from = pos + 1;
            }
        }
        let Some((dot, method)) = hit else { return };
        let recv_start = receiver_start(s, dot);
        let open_paren = dot + 1 + method.len();
        let close_paren = match close_paren(s, open_paren) {
            Some(p) => p,
            None => return,
        };
        let recv = s[recv_start..dot].to_string();
        let args = s[open_paren + 1..close_paren].to_string();
        let replacement = format!("({recv}|{method}({args}))");
        s.replace_range(recv_start..=close_paren, &replacement);
    }
}

/// Byte index where the receiver expression of `.method` at `dot` begins.
fn receiver_start(s: &str, dot: usize) -> usize {
    let b = s.as_bytes();
    let mut i = dot;
    loop {
        while i > 0 && b[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i == 0 {
            return 0;
        }
        match b[i - 1] {
            b']' | b')' => {
                // scan back to the matching opener, skipping literals
                let (open, close) = if b[i - 1] == b']' { (b'[', b']') } else { (b'(', b')') };
                let mut depth = 0i32;
                let mut j = i;
                while j > 0 {
                    j -= 1;
                    if b[j] == close {
                        depth += 1;
                    } else if b[j] == open {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
                i = j;
            }
            b'"' | b'\'' => {
                let q = b[i - 1];
                let mut j = i - 1;
                while j > 0 {
                    j -= 1;
                    if b[j] == q && b[j - 1] != b'\\' {
                        break;
                    }
                }
                i = j;
            }
            c if c.is_ascii_alphanumeric() || c == b'_' => {
                while i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') {
                    i -= 1;
                }
                // dotted chain continues: `a.b.method(` — keep going on '.'
                if i > 0 && b[i - 1] == b'.' {
                    // guard against `..` or a `.` that belongs to a float/attr of another expr
                    if i >= 2 && (b[i - 2].is_ascii_alphanumeric() || b[i - 2] == b'_' || b[i - 2] == b']' || b[i - 2] == b')' || b[i - 2] == b'"' || b[i - 2] == b'\'') {
                        i -= 1;
                        continue;
                    }
                }
                return i;
            }
            _ => return i,
        }
    }
}

/// Index of the `)` matching the `(` at `open`, skipping string literals.
fn close_paren(s: &str, open: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 0i32;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Heuristic: is byte offset `pos` inside a '...' or "..." literal?
/// Counts unescaped quotes before `pos` on the same line.
fn inside_string(b: &[u8], pos: usize) -> bool {
    let mut single = 0u32;
    let mut double = 0u32;
    let mut i = 0;
    while i < pos {
        match b[i] {
            b'\'' if double % 2 == 0 => single += 1,
            b'"' if single % 2 == 0 => double += 1,
            _ => {}
        }
        i += 1;
    }
    single % 2 == 1 || double % 2 == 1
}

/// Date without pulling in chrono — templates only use it for a header.
fn chrono_free_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // civil-from-days algorithm
    let days = secs / 86400;
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn render_fallback(messages: &[ChatMessage]) -> String {
    let mut out = String::new();
    for m in messages {
        match m.role.as_str() {
            "system" => out.push_str(&format!("<|im_start|>system\n{}<|im_end|>\n", m.content)),
            "user" => out.push_str(&format!("<|im_start|>user\n{}<|im_end|>\n", m.content)),
            "assistant" => out.push_str(&format!("<|im_start|>assistant\n{}<|im_end|>\n", m.content)),
            _ => out.push_str(&m.content),
        }
    }
    out.push_str("<|im_start|>assistant\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(roles: &[(&str, &str)]) -> Vec<ChatMessage> {
        roles
            .iter()
            .map(|(r, c)| ChatMessage {
                role: r.to_string(),
                content: c.to_string(),
            })
            .collect()
    }

    #[test]
    fn fallback_wraps_turns() {
        let out = render(None, &msgs(&[("user", "hi")]), None).unwrap();
        assert!(out.contains("<|im_start|>user\nhi<|im_end|>"));
        assert!(out.ends_with("<|im_start|>assistant\n"));
    }

    /// The real Qwen3 template uses namespace(), .startswith(), [::-1] and
    /// `is string` — all the Pythonisms preprocess() must bridge.
    #[test]
    fn qwen3_style_template_renders() {
        let t = r#"
{%- set ns = namespace(last=messages|length - 1) %}
{%- for message in messages[::-1] %}
    {%- set index = (messages|length - 1) - loop.index0 %}
    {%- if message.role == "user" and message.content is string and not(message.content.startswith('<tool_response>') and message.content.endswith('</tool_response>')) %}
        {%- set ns.last = index %}
    {%- endif %}
{%- endfor %}
{%- for message in messages %}
    {%- if message.content is string %}{%- set content = message.content %}{%- else %}{%- set content = '' %}{%- endif %}
    {{- '<|im_start|>' + message.role + '\n' + content.strip('\n') + '<|im_end|>\n' }}
{%- endfor %}
{%- if add_generation_prompt %}{{- '<|im_start|>assistant\n' }}{%- endif %}
"#;
        let out = render(
            Some(t),
            &msgs(&[("system", "sys"), ("user", "hi\n"), ("assistant", "hey")]),
            None,
        )
        .unwrap();
        assert!(out.contains("<|im_start|>user\nhi<|im_end|>"), "got: {out}");
        assert!(out.ends_with("<|im_start|>assistant\n"), "got: {out}");
    }

    /// Python `x.split(a)[-1]` must become `(x|split(a))[-1]` — a bare
    /// filtered value can't be subscripted in minijinja.
    #[test]
    fn split_and_negative_index() {
        let t = "{{ 'a,b,c'.split(',')[-1] }}";
        let out = render_jinja(t, &msgs(&[]), None).unwrap();
        assert_eq!(out.trim(), "c");
    }
}
