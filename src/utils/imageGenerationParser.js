'use strict'

const crypto = require('crypto')

/**
 * Factory that creates a per-request image-generation stats tracker.
 *
 * Returns { recordItem, recordCompletedEvent, recordResponseMeta, build }.
 *
 * build(reqBody?) resolves toolModel via the full fallback chain:
 *   response.tools[].model
 *   → image_generation_call / image_generation.completed item.model
 *   → reqBody.tools[image_generation].model
 *   → reqBody.image_generation.model / reqBody.imageGeneration.model
 *   → 'gpt-image-2'  (OpenAI current default when tool present but model omitted)
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

  /**
   * Build a stable dedup key from an image item.
   * Mirrors sub2api: outputFormat|result > item:id/call_id > SHA-256(result).
   */
  const buildDedupKey = (item, result) => {
    if (result) {
      const fmt = typeof item.output_format === 'string' ? item.output_format.trim() : ''
      return `${fmt}|${crypto.createHash('sha256').update(result).digest('hex')}`
    }
    const id = (item.id || item.call_id || '').toString().trim()
    return id ? `item:${id}` : ''
  }

  /**
   * Returns true if this item represents a partial/in-progress image frame
   * (e.g. when partial_images > 0 is requested).  Such items must not be counted.
   */
  const isPartialImageItem = (item) => {
    if (typeof item.partial_image_index === 'number') {
      return true
    }
    const t = typeof item.type === 'string' ? item.type : ''
    if (t.includes('partial_image')) {
      return true
    }
    return false
  }

  /**
   * Core recording logic. Accepts items of type:
   *   - image_generation_call  (from response.output[] and response.output_item.done)
   *   - image_generation.completed  (standalone SSE event type on some API versions)
   *   - '' / undefined  (when called from a known-image event context)
   */
  const recordItem = (item) => {
    if (!item || typeof item !== 'object') {
      return
    }

    const type = typeof item.type === 'string' ? item.type : ''
    if (type !== '' && type !== 'image_generation_call' && type !== 'image_generation.completed') {
      return
    }

    // Skip partial image delivery frames — they are not complete images
    if (isPartialImageItem(item)) {
      return
    }

    // Resolve result from result > b64_json > url (mirrors sub2api)
    const result =
      (typeof item.result === 'string' ? item.result.trim() : '') ||
      (typeof item.b64_json === 'string' ? item.b64_json.trim() : '') ||
      (typeof item.url === 'string' ? item.url.trim() : '')

    // For typed items, a non-empty result is required
    if (!result && type !== '') {
      return
    }

    const dedupKey = buildDedupKey(item, result)
    if (!dedupKey) {
      return
    }
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
      if (!stats.toolModel) {
        stats.toolModel = item.model
      }
    }
    if (typeof item.revised_prompt === 'string' && item.revised_prompt.trim()) {
      itemMeta.revisedPrompt = item.revised_prompt.trim()
    }

    stats.items.push(itemMeta)
  }

  /**
   * Handle an SSE event with type === 'image_generation.completed'.
   * The image data may be in event.item, event.output, or the event root.
   */
  const recordCompletedEvent = (eventData) => {
    if (!eventData || typeof eventData !== 'object') {
      return
    }
    const candidate = eventData.item || eventData.output || eventData
    recordItem(candidate)
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

    // Ultimate fallback: gpt-image-2 is the current OpenAI default when the
    // image_generation tool is present but no model is explicitly specified.
    if (!toolModel) {
      toolModel = 'gpt-image-2'
    }

    return { ...stats, toolModel }
  }

  return { recordItem, recordCompletedEvent, recordResponseMeta, build }
}

module.exports = { createImageGenerationTracker }
