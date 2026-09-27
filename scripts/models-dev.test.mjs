import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookupModelMeta } from '../server/modelsDev.ts'

const model = (context, price, levels = ['low', 'high']) => ({
  name: 'fixture model', reasoning: true,
  limit: { context, output: 4096 }, cost: { input: price, output: price * 2 },
  modalities: { input: ['text', 'image'] },
  reasoning_options: [{ type: 'effort', values: levels }],
})
const catalog = {
  openai: { npm: '@ai-sdk/openai', models: { demo: model(128000, 1), ambiguous: model(128000, 1) } },
  anthropic: { npm: '@ai-sdk/anthropic', models: { ambiguous: model(200000, 3) } },
  relay: { api: 'https://relay.example/v1', npm: '@ai-sdk/openai-compatible', models: {
    demo: model(64000, 7, ['low', 'medium', 'high']),
    native: { ...model(32000, 8), provider: { api: 'https://relay.example/anthropic/v1', npm: '@ai-sdk/anthropic' } },
    responses: { ...model(24000, 9), provider: { shape: 'responses' } },
  } },
  coding: { api: 'https://relay.example/coding/v1', npm: '@ai-sdk/openai-compatible', models: { demo: model(16000, 0) } },
  other: { api: 'https://other.example/v1', npm: '@ai-sdk/openai-compatible', models: {
    demo: model(999000, 99, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    private: model(999000, 99),
  } },
}

test('元数据保留供应商边界，网络故障与未收录分别处理', async (t) => {
  const previousProxy = process.env.PI_MANAGE_PROXY
  delete process.env.PI_MANAGE_PROXY
  t.after(() => {
    if (previousProxy === undefined) delete process.env.PI_MANAGE_PROXY
    else process.env.PI_MANAGE_PROXY = previousProxy
  })
  let unavailable = true
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://models.dev/api.json', '测试不允许访问真实模型接口')
    requests++
    return unavailable ? new Response('fixture unavailable', { status: 503 }) : Response.json(catalog)
  })
  await assert.rejects(lookupModelMeta('demo'), /503/)
  unavailable = false

  await t.test('官方连接采用自身资料，不拼接其他站更多的思考档位', async () => {
    const meta = await lookupModelMeta('demo', { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1/' })
    assert.equal(meta.contextWindow, 128000)
    assert.equal(meta.cost.input, 1)
    assert.equal(meta.thinkingLevelMap.medium, null)
    assert.equal(meta.thinkingLevelMap.max, null)
    assert.deepEqual(meta.source, { provider: 'openai', modelId: 'demo', match: 'provider' })
  })
  await t.test('已知中转使用该站参数，同域名不同路径的产品分别匹配', async () => {
    const meta = await lookupModelMeta('demo', { api: 'openai-completions', baseUrl: 'https://relay.example/v1' })
    assert.equal(meta.contextWindow, 64000)
    assert.equal(meta.cost.input, 7)
    assert.equal(meta.thinkingLevelMap.medium, 'medium')
    assert.equal(meta.source.provider, 'relay')
    const coding = await lookupModelMeta('demo', { api: 'openai-completions', baseUrl: 'https://relay.example/coding/v1' })
    assert.equal(coding.contextWindow, 16000)
    assert.equal(coding.cost.input, 0)
    assert.equal(coding.source.provider, 'coding')
  })
  await t.test('未知中转仅引用唯一官方资料，价格和思考档位不冒充当前站配置', async () => {
    const meta = await lookupModelMeta('demo', { api: 'openai-completions', baseUrl: 'https://unknown.example/v1' })
    assert.equal(meta.contextWindow, 128000)
    assert.equal(meta.cost.input, 1)
    assert.equal(meta.thinkingLevelMap, undefined)
    assert.equal(meta.source.match, 'reference')
    assert.equal(await lookupModelMeta('private', { baseUrl: 'https://unknown.example/v1' }), null)
  })
  await t.test('同名厂商有歧义时不猜测，只识别明确的厂商前缀', async () => {
    assert.equal(await lookupModelMeta('ambiguous'), null)
    assert.equal(await lookupModelMeta('team/demo'), null)
    const meta = await lookupModelMeta('openrouter/anthropic/ambiguous')
    assert.equal(meta.source.provider, 'anthropic')
    assert.equal(meta.source.modelId, 'ambiguous')
    assert.equal(meta.contextWindow, 200000)
    assert.equal(meta.thinkingLevelMap, undefined)
    assert.equal(await lookupModelMeta('not-listed'), null)
  })
  await t.test('协议缺失或不匹配时不填思考档位，尊重模型自身的协议覆盖', async () => {
    for (const api of [undefined, 'anthropic-messages']) {
      const meta = await lookupModelMeta('demo', { api, baseUrl: 'https://api.openai.com/v1' })
      assert.equal(meta.thinkingLevelMap, undefined)
    }
    const native = await lookupModelMeta('native', { api: 'anthropic-messages', baseUrl: 'https://relay.example/anthropic' })
    assert.equal(native.thinkingLevelMap.high, 'high')
    const mismatch = await lookupModelMeta('native', { api: 'openai-completions', baseUrl: 'https://relay.example/anthropic' })
    assert.equal(mismatch.thinkingLevelMap, undefined)
    const responses = await lookupModelMeta('responses', { api: 'openai-responses', baseUrl: 'https://relay.example/v1' })
    assert.equal(responses.thinkingLevelMap.high, 'high')
  })
  assert.equal(requests, 2, '失败可重试，成功目录在后续匹配中复用')
})
