// Wire types — OpenAI Chat Completions + Anthropic Messages subsets.
// Deliberately tolerant: we accept the fields we understand and ignore
// the rest, matching how TH's gateway normalizes provider traffic.

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct ChatCompletionsRequest {
    pub messages: Vec<ChatMsg>,
    #[serde(default)]
    pub stream: bool,
    pub max_tokens: Option<usize>,
    pub max_completion_tokens: Option<usize>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<usize>,
    pub seed: Option<u64>,
    pub stop: Option<Stop>,
    /// TH extension: per-request engine tunables that don't fit the
    /// OpenAI shape (repeat penalty, prefill step override).
    pub repeat_penalty: Option<f32>,
    #[serde(flatten)]
    pub _extra: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    #[serde(default)]
    pub content: MsgContent,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum MsgContent {
    Text(String),
    Parts(Vec<Part>),
    None,
}

impl Default for MsgContent {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Deserialize)]
pub struct Part {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
}

impl ChatMsg {
    pub fn text(&self) -> String {
        match &self.content {
            MsgContent::Text(s) => s.clone(),
            MsgContent::Parts(ps) => ps
                .iter()
                .filter(|p| p.kind == "text")
                .filter_map(|p| p.text.clone())
                .collect::<Vec<_>>()
                .join(""),
            MsgContent::None => String::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Stop {
    One(String),
    Many(Vec<String>),
}

impl Stop {
    pub fn into_vec(self) -> Vec<String> {
        match self {
            Self::One(s) => vec![s],
            Self::Many(v) => v,
        }
    }
}

// --- Anthropic Messages ---

#[derive(Deserialize)]
pub struct MessagesRequest {
    pub messages: Vec<ChatMsg>,
    pub system: Option<AnthropicSystem>,
    pub max_tokens: Option<usize>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<usize>,
    pub stop_sequences: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum AnthropicSystem {
    Text(String),
    Parts(Vec<Part>),
}

impl AnthropicSystem {
    pub fn text(&self) -> String {
        match self {
            Self::Text(s) => s.clone(),
            Self::Parts(ps) => ps
                .iter()
                .filter_map(|p| p.text.clone())
                .collect::<Vec<_>>()
                .join(""),
        }
    }
}
