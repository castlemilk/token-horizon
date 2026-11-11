import type { UsageProvenance } from '../types'

/**
 * What a provider billed for one call that still did not yield a usable answer
 * (a refusal, a stop at the output cap, a stream cut off mid-answer).
 *
 * The provider charges for every token it generated, whether or not the answer
 * is usable. A runner that threw the usage away would record $0 for a call that
 * cost money, and the per-model budget cap would never see it.
 */
export interface BilledUsage {
  tokensIn: number
  tokensOut: number
  /** 'reported' when the provider stated the counts, 'estimated' when we counted them ourselves. */
  usageSource: UsageProvenance
  /** Wall-clock time of the call, ms. */
  runtimeMs: number
  /** Visible text the call produced before it failed, if any. Kept for the run log only. */
  partialOutput?: string
}

/**
 * A failed generation that carries the usage it was billed for. Thrown by a
 * runner, read by the harness (`provider.ts`) so the cost reaches the budget and
 * the record. The message is the failure text the classifier reads.
 */
export class BilledGenerationError extends Error {
  readonly billed: BilledUsage

  constructor(message: string, billed: BilledUsage) {
    super(message)
    this.name = 'BilledGenerationError'
    this.billed = billed
  }
}

/** The billed usage an error carries, or undefined for an error that billed nothing we know of. */
export function billedUsageOf(err: unknown): BilledUsage | undefined {
  return err instanceof BilledGenerationError ? err.billed : undefined
}
