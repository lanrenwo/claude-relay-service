jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_'
    }
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  setApiKey: jest.fn(),
  getApiKey: jest.fn()
}))

jest.mock('../src/services/costRankService', () => ({
  addKeyToIndexes: jest.fn()
}))

jest.mock('../src/services/apiKeyIndexService', () => ({
  addToIndex: jest.fn(),
  updateIndex: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/services/requestDetailService', () => ({}))
jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  finalizeRequestDetailMeta: jest.fn((value) => value)
}))

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')

describe('apiKeyService openai responses config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('generateApiKey stores default toggle values', async () => {
    redis.setApiKey.mockResolvedValue()

    const result = await apiKeyService.generateApiKey({ name: 'Test Key' })
    const [, storedKeyData] = redis.setApiKey.mock.calls[0]

    expect(storedKeyData.enableOpenAIResponsesCodexAdaptation).toBe('true')
    expect(storedKeyData.enableOpenAIResponsesPayloadRules).toBe('false')
    expect(storedKeyData.openaiResponsesPayloadRules).toBe('[]')
    expect(storedKeyData.allowImageGeneration).toBe('false')
    expect(storedKeyData.imageConcurrencyLimit).toBe('1')

    expect(result.enableOpenAIResponsesCodexAdaptation).toBe(true)
    expect(result.enableOpenAIResponsesPayloadRules).toBe(false)
    expect(result.openaiResponsesPayloadRules).toEqual([])
    expect(result.allowImageGeneration).toBe(false)
    expect(result.imageConcurrencyLimit).toBe(1)
  })

  test('updateApiKey serializes toggle, image, and payload rule fields', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      apiKey: 'hashed-key',
      name: 'Old Key',
      isActive: 'true',
      tags: '[]'
    })
    redis.setApiKey.mockResolvedValue()

    await apiKeyService.updateApiKey('key-1', {
      enableOpenAIResponsesCodexAdaptation: false,
      allowImageGeneration: true,
      imageConcurrencyLimit: 2,
      enableOpenAIResponsesPayloadRules: true,
      openaiResponsesPayloadRules: [{ path: 'model', valueType: 'string', value: 'gpt-5' }]
    })

    const [, storedKeyData] = redis.setApiKey.mock.calls[0]
    expect(storedKeyData.enableOpenAIResponsesCodexAdaptation).toBe('false')
    expect(storedKeyData.allowImageGeneration).toBe('true')
    expect(storedKeyData.imageConcurrencyLimit).toBe('2')
    expect(storedKeyData.enableOpenAIResponsesPayloadRules).toBe('true')
    expect(storedKeyData.openaiResponsesPayloadRules).toBe(
      JSON.stringify([{ path: 'model', valueType: 'string', value: 'gpt-5' }])
    )
  })

  test('getApiKeyById returns parsed toggle and rule values', async () => {
    redis.getApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'Key',
      apiKey: 'hashed-key',
      tokenLimit: '0',
      isActive: 'true',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastUsedAt: '',
      expiresAt: '',
      userId: '',
      userUsername: '',
      createdBy: 'admin',
      permissions: '[]',
      dailyCostLimit: '0',
      totalCostLimit: '0',
      claudeAccountId: '',
      claudeConsoleAccountId: '',
      geminiAccountId: '',
      openaiAccountId: '',
      bedrockAccountId: '',
      droidAccountId: '',
      azureOpenaiAccountId: '',
      ccrAccountId: '',
      allowImageGeneration: 'true',
      imageConcurrencyLimit: '3',
      enableOpenAIResponsesCodexAdaptation: 'false',
      enableOpenAIResponsesPayloadRules: 'true',
      openaiResponsesPayloadRules: JSON.stringify([
        { path: 'model', valueType: 'string', value: 'gpt-5' }
      ])
    })

    const result = await apiKeyService.getApiKeyById('key-1')

    expect(result.allowImageGeneration).toBe(true)
    expect(result.imageConcurrencyLimit).toBe(3)
    expect(result.enableOpenAIResponsesCodexAdaptation).toBe(false)
    expect(result.enableOpenAIResponsesPayloadRules).toBe(true)
    expect(result.openaiResponsesPayloadRules).toEqual([
      { path: 'model', valueType: 'string', value: 'gpt-5' }
    ])
  })
})
