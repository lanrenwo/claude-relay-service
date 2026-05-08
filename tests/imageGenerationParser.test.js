'use strict'

const { createImageGenerationTracker } = require('../src/utils/imageGenerationParser')

describe('imageGenerationParser', () => {
  test('uses Responses image token details when tool usage is absent', () => {
    const tracker = createImageGenerationTracker()

    tracker.recordItem({
      type: 'image_generation_call',
      result: 'base64-image',
      output_format: 'png',
      model: 'gpt-image-2'
    })
    tracker.recordResponseMeta({
      usage: {
        input_tokens: 120,
        output_tokens: 4200,
        total_tokens: 4320,
        output_tokens_details: {
          image_tokens: 4096
        }
      }
    })

    expect(tracker.build()).toMatchObject({
      count: 1,
      toolModel: 'gpt-image-2',
      outputTokens: 4096,
      totalTokens: 4096
    })
  })

  test('keeps explicit tool_usage image tokens ahead of aggregate usage details', () => {
    const tracker = createImageGenerationTracker()

    tracker.recordItem({
      type: 'image_generation_call',
      result: 'base64-image',
      output_format: 'webp'
    })
    tracker.recordResponseMeta({
      tool_usage: {
        image_gen: {
          input_tokens: 11,
          output_tokens: 22,
          total_tokens: 33
        }
      },
      usage: {
        output_tokens_details: {
          image_tokens: 4096
        }
      }
    })

    expect(tracker.build()).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33
    })
  })

  test('counts input image token details when provided', () => {
    const tracker = createImageGenerationTracker()

    tracker.recordItem({
      type: 'image_generation_call',
      result: 'base64-image',
      output_format: 'png'
    })
    tracker.recordResponseMeta({
      usage: {
        input_tokens_details: {
          image_tokens: 7
        },
        output_tokens_details: {
          image_tokens: 13
        }
      }
    })

    expect(tracker.build()).toMatchObject({
      inputTokens: 7,
      outputTokens: 13,
      totalTokens: 20
    })
  })
})
