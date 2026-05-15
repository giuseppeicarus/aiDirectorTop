'use strict'
/**
 * LlmCinematicSupervisorService
 * Interface + mock for future LLM-based visual supervision of cut decisions.
 *
 * When enabled, it will receive frame previews, similarity/motion scores,
 * and the preliminary cut decision, and may return cinematically-aware overrides.
 *
 * Current state: mock implementation always returns null (no override).
 * Future: integrate with LLM vision adapter (e.g. GPT-4o, Claude vision).
 */

class LlmCinematicSupervisorService {
  /**
   * @param {boolean} enabled     - whether supervision is active
   * @param {Object}  llmAdapter  - future: inject LLM adapter instance
   */
  constructor(enabled = false, llmAdapter = null) {
    this.enabled    = enabled
    this.llmAdapter = llmAdapter
  }

  /**
   * Supervise a cut decision.
   * Returns an override object, or null if no override is needed.
   *
   * @param {Object} ctx
   * @param {string} ctx.framePathLastA       - absolute path to last frame of clip A
   * @param {string} ctx.framePathFirstActiveB - absolute path to first non-static frame of clip B
   * @param {Object} ctx.similarityResult
   * @param {Object} ctx.motionResult         - { a: [...], b: [...] }
   * @param {Object} ctx.cutDecision          - preliminary cut decision from CutDecisionService
   *
   * @returns {Promise<{
   *   override_trim_b?: number,
   *   override_trim_a?: number,
   *   cinematic_reason?: string
   * } | null>}
   */
  async supervise(ctx) {  // eslint-disable-line no-unused-vars
    if (!this.enabled || !this.llmAdapter) return null

    // TODO: encode frames as base64, build vision prompt, call LLM
    // const frameB64A = encodeFrameBase64(ctx.framePathLastA)
    // const frameB64B = encodeFrameBase64(ctx.framePathFirstActiveB)
    // const response = await this.llmAdapter.generateJson(
    //   system: CINEMATIC_SUPERVISOR_SYSTEM,
    //   user: buildSupervisorPrompt(ctx, frameB64A, frameB64B)
    // )
    // return response  // { override_trim_b, override_trim_a, cinematic_reason }

    return null
  }
}

module.exports = { LlmCinematicSupervisorService }
