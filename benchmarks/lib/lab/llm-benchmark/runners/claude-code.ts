import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BenchmarkModel, BenchmarkTask } from '../types'
import { generateFromCli, type CliRunnerConfig, type GenerationResponse } from './cli'
import { CLI_COMMANDS } from './execution-target'

export interface ClaudeCodeConfig {
  /** Model id the CLI session should run. Defaults to the model's apiModelId. */
  model?: string
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number
}

/**
 * Claude Code CLI runner, driving Kimi through the Kimi Code endpoint — the
 * same arrangement as the user's `kc` shell function: a settings.json env
 * block pointing Claude Code's Anthropic-compatible client at
 * https://api.kimi.com/coding with a Kimi Code key.
 *
 * Why settings.json instead of process env: Claude Code's settings env
 * OVERRIDES the process environment (verified 2026-10-24: an exported
 * ANTHROPIC_BASE_URL was ignored while settings.json held another value), so
 * the only reliable knob is the file `kc` already rewrites. The runner backs
 * up the current file and restores it in a `finally`, and serialises calls
 * through a module-level chain so concurrent iterations cannot interleave a
 * read-modify-write. The auth token lives in the file, never in the child env
 * (cli.ts's scrubEnv drops it), and `--tools ""` disables every tool, so the
 * model cannot read the file back into a published artifact.
 *
 * The artifact arrives as plain stdout text (`-p` print mode): the generic
 * cli.ts extraction (markdown fences, prose fallbacks) applies unchanged.
 */
export async function generateClaudeCode(
  config: ClaudeCodeConfig,
  model: BenchmarkModel,
  task: BenchmarkTask,
  iterationIndex = 0
): Promise<GenerationResponse> {
  const claudeModel = config.model ?? model.apiModelId ?? model.id
  const token = await kimiAuthToken()
  if (!token) {
    throw new Error('Claude Code config missing auth: set MOONSHOT_API_KEY in ~/.config/kimi.env')
  }
  // Serialize the settings read-modify-restore across concurrent iterations.
  const run = settingsChain.then(() =>
    runWithSettings(token, claudeModel, config, model, task, iterationIndex)
  )
  settingsChain = run.catch(() => {})
  return run
}

const KIMI_ENV = join(homedir(), '.config', 'kimi.env')
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

/** settings.json read-modify-restore chain (see generateClaudeCode). */
let settingsChain: Promise<unknown> = Promise.resolve()

/**
 * The Kimi Code key: `~/.config/kimi.env` is the canonical store (the `kc`
 * function reads the same file); the environment variable is the fallback.
 * Never returned to the child env — it goes into settings.json only.
 */
async function kimiAuthToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(KIMI_ENV, 'utf8')
    const match = raw.match(/^MOONSHOT_API_KEY=(.+)$/m)
    if (match?.[1]) return match[1].trim()
  } catch {
    // no kimi.env — fall through to the environment
  }
  return process.env.MOONSHOT_API_KEY
}

/** The same env block `kc` writes, parameterised by model. */
function settingsJson(token: string, model: string): string {
  return (
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding',
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
          ANTHROPIC_DEFAULT_FABLE_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
        },
      },
      null,
      2
    ) + '\n'
  )
}

async function runWithSettings(
  token: string,
  claudeModel: string,
  config: ClaudeCodeConfig,
  model: BenchmarkModel,
  task: BenchmarkTask,
  iterationIndex: number
): Promise<GenerationResponse> {
  let backup: string | null = null
  try {
    try {
      backup = await readFile(SETTINGS_PATH, 'utf8')
    } catch {
      backup = null // no pre-existing settings.json — restore by deletion
    }
    await writeFile(SETTINGS_PATH, settingsJson(token, claudeModel))

    const runner: CliRunnerConfig = {
      // Single-sourced with the sweep pre-flight (see execution-target.ts).
      command: CLI_COMMANDS['Claude Code'],
      // `--tools ""` disables every tool: the artifact must come back as
      // stdout text (print mode), which is also what keeps the settings.json
      // auth out of the model's reach. `--` ends the variadic --tools list so
      // the prompt (last argv element) is never swallowed as a tool name.
      buildArgs: (prompt) => ['-p', '--model', claudeModel, '--tools', '', '--', prompt],
      timeoutMs: config.timeoutMs,
    }
    return await generateFromCli(runner, model, task, iterationIndex)
  } finally {
    if (backup === null) {
      await rm(SETTINGS_PATH, { force: true })
    } else {
      await writeFile(SETTINGS_PATH, backup)
    }
  }
}
