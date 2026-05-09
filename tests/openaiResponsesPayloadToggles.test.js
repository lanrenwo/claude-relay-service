const crypto = require('crypto')

const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn(),
  tryAcquireConcurrencySlot: jest.fn(),
  decrConcurrency: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn().mockImplementation(() => ({
    feed: jest.fn(() => []),
    getRemaining: jest.fn(() => '')
  }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || 'error')
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, meta) => meta),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const axios = require('axios')
const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createReq({
  path = '/v1/responses',
  body = {},
  userAgent = 'my-client/1.0',
  apiKeyOverrides = {},
  fromUnifiedEndpoint = false
} = {}) {
  return {
    method: 'POST',
    path,
    originalUrl: `/openai${path}`,
    headers: {
      'user-agent': userAgent
    },
    body: JSON.parse(JSON.stringify(body)),
    once: jest.fn(),
    apiKey: {
      id: 'key_1',
      permissions: ['openai'],
      enableOpenAIResponsesCodexAdaptation: true,
      enableOpenAIResponsesPayloadRules: false,
      openaiResponsesPayloadRules: [],
      imageConcurrencyLimit: 1,
      ...apiKeyOverrides
    },
    _fromUnifiedEndpoint: fromUnifiedEndpoint
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value
    }),
    set: jest.fn((key, value) => {
      res.headers[key] = value
      return res
    }),
    once: jest.fn()
  }
  return res
}

describe('openai responses payload toggles', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'resp-1',
      accountType: 'openai-responses'
    })

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Account',
      apiKey: 'sk-responses'
    })

    openaiResponsesRelayService.handleRequest.mockResolvedValue({ ok: true })
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
    redis.tryAcquireConcurrencySlot.mockResolvedValue({ acquired: true, count: 1, limit: 1 })
    redis.decrConcurrency.mockResolvedValue(0)
  })

  test('keeps standard responses payload unchanged for openai-responses when both toggles are off', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'session-a'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body).toEqual({
      model: 'gpt-5-2025-08-07',
      temperature: 0.2,
      service_tier: 'priority',
      prompt_cache_key: 'session-a'
    })
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('session-a'),
      'gpt-5'
    )
  })

  test('applies Codex adaptation only when adaptation toggle is on', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'session-b'
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5')
    expect(req.body.instructions).toBe(openaiRoutes.CODEX_CLI_INSTRUCTIONS)
    expect(req.body.temperature).toBeUndefined()
    expect(req.body.service_tier).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('session-b'),
      'gpt-5'
    )
  })

  test('applies payload rules directly on the original payload when adaptation is off', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        temperature: 0.5,
        prompt_cache_key: 'old-key',
        text: { format: {} }
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'new-key' },
          { path: 'text.format.type', valueType: 'string', value: 'json_schema' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body).toEqual({
      model: 'gpt-5',
      temperature: 0.5,
      prompt_cache_key: 'new-key',
      text: {
        format: {
          type: 'json_schema'
        }
      }
    })
    expect(req.body.instructions).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('new-key'),
      'gpt-5'
    )
  })

  test('applies payload rules after Codex adaptation when both toggles are on', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        prompt_cache_key: 'legacy-key',
        temperature: 0.2,
        instructions: 'raw'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: true,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5-codex' },
          { path: 'instructions', valueType: 'string', value: 'custom instructions' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'rule-key' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5-codex')
    expect(req.body.instructions).toBe('custom instructions')
    expect(req.body.temperature).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('rule-key'),
      'gpt-5-codex'
    )
  })

  test('normalizes dated gpt-5 models only for scheduling and upstream openai requests when adaptation is off', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        service_tier: 'priority',
        prompt_cache_key: 'compat-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('compat-key'),
      'gpt-5'
    )
    expect(req.body.model).toBe('gpt-5')
    expect(req.body.service_tier).toBe('priority')
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
      service_tier: 'priority',
      store: false
    })
  })

  test('normalizes payload-rule gpt-5 aliases for openai scheduling without applying full Codex adaptation', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        text: { format: {} },
        prompt_cache_key: 'rule-model-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5-2025-08-07' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('rule-model-key'),
      'gpt-5'
    )
    expect(req.body.model).toBe('gpt-5')
    expect(req.body.text).toEqual({ format: {} })
    expect(req.body.instructions).toBeUndefined()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
      text: { format: {} },
      store: false
    })
  })

  test('records the mutated service_tier for standard responses sent through openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-4.1',
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          total_tokens: 18
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'tier-rule-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._serviceTier).toBe('priority')
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBe('priority')
  })

  test('records null service_tier after Codex adaptation removes it for openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'adapt-tier-key',
        stream: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.service_tier).toBeUndefined()
    expect(req._serviceTier).toBeNull()
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBeNull()
  })

  test('captures the post-rule service_tier before relaying openai-responses requests', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'relay-tier-key'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._serviceTier).toBe('priority')
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
    expect(openaiResponsesRelayService.handleRequest.mock.calls[0][0]._serviceTier).toBe('priority')
  })

  test('injects the image_generation bridge before relaying openai-responses accounts', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'relay-image-key',
        tool_choice: 'image_generation'
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
    const forwardedReq = openaiResponsesRelayService.handleRequest.mock.calls[0][0]
    expect(forwardedReq.body.tools).toContainEqual({
      type: 'image_generation',
      output_format: 'png'
    })
    expect(forwardedReq.body.instructions).toContain('<codex-image-generation-bridge>')
  })

  test('strips advertised image_generation tools when the API key image service is disabled', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        tools: [{ type: 'image_generation' }]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
    const forwardedReq = openaiResponsesRelayService.handleRequest.mock.calls[0][0]
    expect(forwardedReq.body.tools).toBeUndefined()
  })

  test('rejects explicit image_generation tool choice when the API key image service is disabled', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        tools: [{ type: 'image_generation' }],
        tool_choice: 'image_generation'
      }
    })
    const res = createRes()

    await openaiRoutes.handleResponses(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.payload.error.code).toBe('image_generation_disabled')
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('does not inject image_generation for normal text requests when image service is disabled', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-4.1', usage: { total_tokens: 0 } },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'text-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1].tools).toBeUndefined()
  })

  test('injects the image_generation bridge only for explicit image requests', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-4.1', usage: { total_tokens: 0 } },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'image-key',
        stream: false,
        tool_choice: 'image_generation'
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1].tools).toContainEqual({
      type: 'image_generation',
      output_format: 'png'
    })
    expect(axios.post.mock.calls[0][1].instructions).toContain('<codex-image-generation-bridge>')
  })

  test('does not reserve image concurrency slots for text requests on image-enabled keys', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-4.1', usage: { total_tokens: 0 } },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'text-with-image-service-key',
        stream: false
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(redis.tryAcquireConcurrencySlot).not.toHaveBeenCalled()
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1].tools).toBeUndefined()
  })

  test('strips advertised image_generation tool when there is no explicit image intent', async () => {
    // A request that merely advertises the image_generation tool without explicit
    // intent (no tool_choice, no gpt-image-* model, no image_generation options)
    // must NOT acquire an image concurrency slot and must have the tool removed.
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-4.1', usage: { total_tokens: 0 } },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'client-image-tool-key',
        stream: false,
        tools: [{ type: 'image_generation', format: 'webp', compression: 80 }]
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    // No image slot should be acquired for an advertise-only tool
    expect(redis.tryAcquireConcurrencySlot).not.toHaveBeenCalled()
    // The tool must be stripped from the forwarded request
    const forwardedBody = axios.post.mock.calls[0][1]
    const hasImageTool = (forwardedBody.tools || []).some((t) => t?.type === 'image_generation')
    expect(hasImageTool).toBe(false)
  })

  test('passes image generation options into the injected tool', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-4.1', usage: { total_tokens: 0 } },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'image-options-key',
        stream: false,
        image_generation: {
          quality: 'high',
          size: '1024x1024',
          background: 'transparent',
          output_format: 'webp'
        }
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(redis.tryAcquireConcurrencySlot).toHaveBeenCalledWith(
      'image_generation:key_1',
      expect.any(String),
      1,
      expect.any(Number)
    )
    expect(axios.post.mock.calls[0][1].tools).toContainEqual({
      type: 'image_generation',
      quality: 'high',
      size: '1024x1024',
      background: 'transparent',
      output_format: 'webp'
    })
  })

  test('normalizes gpt-image models into Responses image_generation tools', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-5.4', usage: { total_tokens: 0 } },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-image-1.5',
        prompt: 'draw a cat',
        stream: false,
        size: '1024x1024',
        format: 'webp'
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    const upstreamBody = axios.post.mock.calls[0][1]
    expect(upstreamBody.model).toBe('gpt-5.4')
    expect(upstreamBody.input).toBe('draw a cat')
    expect(upstreamBody.prompt).toBeUndefined()
    expect(upstreamBody.tool_choice).toEqual({ type: 'image_generation' })
    expect(upstreamBody.tools).toContainEqual({
      type: 'image_generation',
      model: 'gpt-image-1.5',
      size: '1024x1024',
      output_format: 'webp'
    })
  })

  test('rejects image-enabled API keys when the image concurrency limit is reached', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    redis.tryAcquireConcurrencySlot.mockResolvedValue({ acquired: false, count: 1, limit: 1 })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'image-limit-key',
        stream: false,
        tools: [{ type: 'image_generation', output_format: 'png' }],
        tool_choice: 'image_generation'
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        imageConcurrencyLimit: 1,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })
    const res = createRes()

    await openaiRoutes.handleResponses(req, res)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.payload.error.code).toBe('image_concurrency_limit_exceeded')
    expect(axios.post).not.toHaveBeenCalled()
    expect(redis.decrConcurrency).not.toHaveBeenCalled()
  })

  test('enforces image concurrency before relaying openai-responses accounts', async () => {
    redis.tryAcquireConcurrencySlot.mockResolvedValue({ acquired: false, count: 1, limit: 1 })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        tools: [{ type: 'image_generation' }],
        tool_choice: 'image_generation'
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        imageConcurrencyLimit: 1,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })
    const res = createRes()

    await openaiRoutes.handleResponses(req, res)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.payload.error.code).toBe('image_concurrency_limit_exceeded')
    expect(openaiResponsesRelayService.handleRequest).not.toHaveBeenCalled()
    expect(redis.decrConcurrency).not.toHaveBeenCalled()
  })

  test('records per-image metadata for multiple generated images', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-4.1',
        output: [
          {
            type: 'image_generation_call',
            result: 'base64-a',
            output_format: 'png',
            size: '1024x1024',
            quality: 'high'
          },
          {
            type: 'image_generation_call',
            result: 'base64-b',
            output_format: 'webp',
            size: '512x512',
            quality: 'medium'
          }
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        tools: [{ type: 'image_generation' }],
        stream: false,
        tool_choice: 'image_generation'
      },
      apiKeyOverrides: {
        allowImageGeneration: true,
        enableOpenAIResponsesCodexAdaptation: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    const meta = apiKeyService.recordUsage.mock.calls[0][9]
    expect(meta.imageGeneration).toMatchObject({
      count: 2,
      format: 'png',
      size: '1024x1024',
      items: [
        { format: 'png', size: '1024x1024', quality: 'high' },
        { format: 'webp', size: '512x512', quality: 'medium' }
      ]
    })
  })

  test('does not apply the new rule flow to compact responses routes', async () => {
    const req = createReq({
      path: '/v1/responses/compact',
      body: {
        model: 'o1-mini',
        prompt_cache_key: 'compact-key',
        temperature: 0.1
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'rule-key' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('o1-mini')
    expect(req.body.prompt_cache_key).toBe('compact-key')
    expect(req.body.instructions).toBe(openaiRoutes.CODEX_CLI_INSTRUCTIONS)
  })
})
