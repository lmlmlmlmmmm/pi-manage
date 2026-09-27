// 使用显式指定的 pi 安装目录核对请求参数，全部请求在内存中拦截，不读取用户配置。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { testModel } from '../server/modelTest.ts'

const [piDirectory] = process.argv.slice(2)
assert.ok(piDirectory, '请指定 pi-coding-agent 安装目录')
const root = resolve(piDirectory)
const load = (name) => import(pathToFileURL(join(root, 'dist/core', name)).href)
const { ModelRuntime } = await load('model-runtime.js')
const { ModelConfig } = await load('model-config.js')
const { RuntimeCredentials } = await load('runtime-credentials.js')
const { AuthStorage } = await load('auth-storage.js')
const { InMemoryCodingAgentModelsStore } = await load('models-store.js')
const originalFetch = globalThis.fetch
const originalProxy = process.env.PI_MANAGE_PROXY
process.env.PI_MANAGE_PROXY = ''
const requests = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  assert.equal(url.hostname, 'pi-manage-request.test')
  const body = init?.body ?? await input.clone().text()
  requests.push({ url: url.href, body: JSON.parse(body) })
  // 400 使 SDK 立即结束；只核对它真实生成的请求，不触发重试或外部调用。
  return new Response(JSON.stringify({ error: { message: 'fixture complete' } }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  })
}

try {
  const scenarios = [
    { api: 'openai-completions', label: 'Chat 默认字段', fields: ['stream', 'store', 'stream_options', 'max_tokens', 'max_completion_tokens'] },
    { api: 'openai-completions', name: 'deepseek', label: '厂商默认兼容值', fields: ['stream', 'store', 'stream_options', 'max_tokens', 'max_completion_tokens'] },
    {
      api: 'openai-completions', label: 'Provider / 模型 / modelOverrides 合并',
      provider: {
        compat: { supportsStore: true, maxTokensField: 'max_tokens', openRouterRouting: { require_parameters: true } },
        modelOverrides: { probe: { compat: { supportsUsageInStreaming: false, openRouterRouting: { order: ['fixture'] } }, maxTokens: 256 } },
      },
      model: { compat: { supportsStore: false, maxTokensField: 'max_completion_tokens', openRouterRouting: { only: ['fixture'] } }, samplingParams: { temperature: 0.3 } },
      fields: ['stream', 'store', 'stream_options', 'max_tokens', 'max_completion_tokens', 'provider', 'temperature'],
    },
    { api: 'openai-responses', label: 'Responses 关闭输出上限字段', model: { compat: { supportsMaxOutputTokens: false } }, fields: ['stream', 'store', 'max_output_tokens'] },
    { api: 'anthropic-messages', label: 'Anthropic 输出限制和采样', model: { maxTokens: 128, samplingParams: { temperature: 0.4 } }, fields: ['stream', 'max_tokens', 'temperature'] },
    { api: 'google-generative-ai', label: 'Google 流式端点和采样', model: { maxTokens: 128, samplingParams: { temperature: 0.4 } }, fields: ['generationConfig.maxOutputTokens', 'generationConfig.temperature'] },
  ]
  for (const scenario of scenarios) {
    const providerName = scenario.name ?? 'fixture-relay'
    const basePath = scenario.api === 'google-generative-ai' ? '/v1beta' : scenario.api === 'anthropic-messages' ? '' : '/v1'
    const provider = {
      api: scenario.api, baseUrl: `https://pi-manage-request.test${basePath}`, apiKey: 'fixture-key',
      ...scenario.provider, models: [{ id: 'probe', ...scenario.model }],
    }
    requests.length = 0
    await testModel(provider, provider.models[0], { prompt: 'fixture', providerName })
    assert.equal(requests.length, 1, scenario.label)
    const actual = requests[0]
    const runtime = new ModelRuntime(
      new RuntimeCredentials(AuthStorage.inMemory()),
      new ModelConfig(new Map([[providerName, provider]])),
      undefined, new InMemoryCodingAgentModelsStore(), [], false,
    )
    const model = runtime.getModel(providerName, 'probe')
    assert.ok(model, runtime.getError())
    requests.length = 0
    // pi 的会话入口使用 streamSimple，模型采样参数在该层与调用选项合并。
    await runtime.streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, {
      maxTokens: Math.min(2048, model.maxTokens), signal: AbortSignal.timeout(15000),
    }).result()
    assert.equal(requests.length, 1, scenario.label)
    const expected = requests[0]
    assert.equal(actual.url, expected.url, scenario.label)
    for (const field of scenario.fields) {
      const actualValue = field.split('.').reduce((value, key) => value?.[key], actual.body)
      const expectedValue = field.split('.').reduce((value, key) => value?.[key], expected.body)
      assert.deepEqual(actualValue, expectedValue, `${scenario.label}: ${field}`)
    }
    console.log(`✓ ${scenario.label}`)
  }
  console.log(`Pi ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version} 请求参数对照通过`)
} finally {
  globalThis.fetch = originalFetch
  if (originalProxy === undefined) delete process.env.PI_MANAGE_PROXY
  else process.env.PI_MANAGE_PROXY = originalProxy
}
