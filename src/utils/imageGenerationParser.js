'use strict'

/**
 * Factory that creates a per-request image-generation stats tracker.
 *
 * Returns { recordItem, recordResponseMeta, build }.
 *
 * build(reqBody?) resolves toolModel via the full fallback chain:
 *   response.tools[].model
 *   → image_generation_call item.model
 *   → reqBody.tools[image_generation].model
 *   → reqBody.image_generation.model / reqBody.imageGeneration.model
 *   → 'gpt-image-1'
 */
function createImageGenerationTracker() {
  const stats = {
    count: 0,
    format: null,
    size: null,
    quality: null,
    background: null,
    action: null,
    toolModel: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    items: []
  }
  const seenItemKeys = new Set()

  const recordItem = (item) => {
    if (!item || typeof item !== 'object') {
      return
    }
    if (item.type !== 'image_generation_call') {
      return
    }
    const result = typeof item.result === 'string' ? item.result.trim() : ''
    if (!result) {
      return
    }

    // Dedup: id > call_id > result prefix (prevents double-count across
    // output_item.done and response.completed when no id is present)
    const dedupKey = item.id || item.call_id || `result:${result.slice(0, 64)}`
    if (seenItemKeys.has(dedupKey)) {
      return
    }
    seenItemKeys.add(dedupKey)

    stats.count += 1
    const itemMeta = {}

    if (typeof item.output_format === 'string') {
      if (!stats.format) {
        stats.format = item.output_format
      }
      itemMeta.format = item.output_format
    }
    if (typeof item.size === 'string') {
      if (!stats.size) {
        stats.size = item.size
      }
      itemMeta.size = item.size
    }
    if (typeof item.quality === 'string') {
      if (!stats.quality) {
        stats.quality = item.quality
      }
      itemMeta.quality = item.quality
    }
    if (typeof item.background === 'string') {
      if (!stats.background) {
        stats.background = item.background
      }
      itemMeta.background = item.background
    }
    if (typeof item.action === 'string') {
      if (!stats.action) {
        stats.action = item.action
      }
      itemMeta.action = item.action
    }
    if (typeof item.model === 'string') {
      itemMeta.model = item.model
      // Capture model as toolModel fallback (lower priority than response.tools[].model)
      if (!stats.toolModel) {
        stats.toolModel = item.model
      }
    }

    stats.items.push(itemMeta)
  }

  const recordResponseMeta = (response) => {
    if (!response || typeof response !== 'object') {
      return
    }

    // Highest-priority source: response.tools[].model
    if (!stats.toolModel && Array.isArray(response.tools)) {
      const tool = response.tools.find((t) => t && t.type === 'image_generation')
      if (tool && typeof tool.model === 'string') {
        stats.toolModel = tool.model
      }
    }

    const usage = response.tool_usage && response.tool_usage.image_gen
    if (usage && typeof usage === 'object') {
      const input = Number(usage.input_tokens)
      const output = Number(usage.output_tokens)
      const total = Number(usage.total_tokens)
      if (Number.isFinite(input) && input > 0) {
        stats.inputTokens = input
      }
      if (Number.isFinite(output) && output > 0) {
        stats.outputTokens = output
      }
      if (Number.isFinite(total) && total > 0) {
        stats.totalTokens = total
      }
    }
  }

  /**
   * Build the final metadata object. Returns null when no images were generated.
   * @param {object|null} reqBody - Original request body for model fallback.
   */
  const build = (reqBody = null) => {
    if (stats.count === 0) {
      return null
    }

    let { toolModel } = stats

    if (!toolModel && reqBody && typeof reqBody === 'object') {
      if (Array.isArray(reqBody.tools)) {
        const t = reqBody.tools.find((tool) => tool && tool.type === 'image_generation')
        if (t && typeof t.model === 'string') {
          toolModel = t.model
        }
      }
      if (
        !toolModel &&
        reqBody.image_generation &&
        typeof reqBody.image_generation.model === 'string'
      ) {
        toolModel = reqBody.image_generation.model
      }
      if (
        !toolModel &&
        reqBody.imageGeneration &&
        typeof reqBody.imageGeneration.model === 'string'
      ) {
        toolModel = reqBody.imageGeneration.model
      }
    }

    // Ultimate fallback — matches the default tool injected by buildImageGenerationTool()
    if (!toolModel) {
      toolModel = 'gpt-image-1'
    }

    return { ...stats, toolModel }
  }

  return { recordItem, recordResponseMeta, build }
}

module.exports = { createImageGenerationTracker }
