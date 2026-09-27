import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fetchProviderModels } from '../server/fetchModels.ts'

async function gateway(t, respond) {
  const requests = []
  const previousProxy = process.env.PI_MANAGE_PROXY
  delete process.env.PI_MANAGE_PROXY
  const server = createServer((req, res) => {
    const request = { url: new URL(req.url, 'http://fixture'), headers: req.headers }
    requests.push(request)
    const { status = 200, data } = respond(request, requests.length)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === 'https://models.dev/api.json') return Promise.resolve(Response.json({
      openai: { npm: '@ai-sdk/openai', models: Object.fromEntries(['demo', 'gateway-price'].map((id) => [id, {
        limit: { context: 128000, output: 4096 }, cost: { input: 1, output: 2 },
        reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      }])) },
    }))
    assert.ok(String(url).startsWith(base + '/'), '测试禁止外部模型请求')
    return originalFetch(url, options)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (previousProxy === undefined) delete process.env.PI_MANAGE_PROXY
    else process.env.PI_MANAGE_PROXY = previousProxy
  })
  return { base, requests }
}

test('Google 跨页获取并去重，保留游标原文和同一组认证', async (t) => {
  const cursor = 'opaque+/= token'
  const { base, requests } = await gateway(t, ({ url }) => ({ data: url.searchParams.has('pageToken')
    ? { models: [{ name: 'models/demo', displayName: 'later name' }, { name: 'models/second' }] }
    : { models: [{ name: 'models/demo' }], nextPageToken: cursor } }))
  const models = await fetchProviderModels({ api: 'google-generative-ai', baseUrl: `${base}/v1beta`, apiKey: 'fixture-group-key' })
  assert.deepEqual(models.map((model) => model.id), ['demo', 'second'])
  assert.equal(models[0].name, 'later name')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url.searchParams.get('pageToken'), cursor)
  for (const request of requests) {
    assert.equal(request.headers['x-goog-api-key'], 'fixture-group-key')
    assert.equal(request.url.pathname, '/v1beta/models')
    assert.equal(request.url.searchParams.get('key'), null)
  }
})

test('Google 当前页全是非对话模型时仍读取下一页', async (t) => {
  const { base, requests } = await gateway(t, ({ url }) => ({ data: url.searchParams.has('pageToken')
    ? { models: [{ name: 'models/chat', supportedGenerationMethods: ['generateContent'] }] }
    : { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' } }))
  const models = await fetchProviderModels({ api: 'google-generative-ai', baseUrl: base, apiKey: '' })
  assert.deepEqual(models.map((model) => model.id), ['chat'])
  assert.equal(requests.length, 2)
})

test('Anthropic 根据 last_id 翻页，保留 limit 并合并重复 ID', async (t) => {
  const { base, requests } = await gateway(t, ({ url }) => ({ data: url.searchParams.has('after_id')
    ? { data: [{ id: 'first' }, { id: 'second' }], has_more: false, last_id: 'second' }
    : { data: [{ id: 'first' }], has_more: true, last_id: 'first' } }))
  const models = await fetchProviderModels({ api: 'anthropic-messages', baseUrl: base, apiKey: 'fixture-key' })
  assert.deepEqual(models.map((model) => model.id), ['first', 'second'])
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url.searchParams.get('after_id'), 'first')
  assert.equal(requests[1].url.searchParams.get('limit'), '1000')
  assert.equal(requests[1].headers['x-api-key'], 'fixture-key')
})

test('后续页失败时不给出不完整列表，明确告知已经获取的数量', async (t) => {
  const { base, requests } = await gateway(t, ({ url }) => url.searchParams.has('pageToken')
    ? { status: 503, data: { error: 'fixture unavailable' } }
    : { data: { models: [{ name: 'models/first' }], nextPageToken: 'next' } })
  await assert.rejects(fetchProviderModels({ api: 'google-generative-ai', baseUrl: base, apiKey: '' }), /未完整获取.*1 个模型.*HTTP 503/)
  assert.equal(requests.length, 2)
})

for (const api of ['google-generative-ai', 'anthropic-messages']) {
  test(`${api}：重复游标立即失败，避免无限翻页`, async (t) => {
    const { base, requests } = await gateway(t, () => ({ data: api === 'google-generative-ai'
      ? { models: [{ name: 'models/first' }], nextPageToken: 'same' }
      : { data: [{ id: 'first' }], has_more: true, last_id: 'same' } }))
    await assert.rejects(fetchProviderModels({ api, baseUrl: base, apiKey: '' }), /未完整获取.*游标重复/)
    assert.equal(requests.length, 2)
  })
}

test('声明后续页但游标缺失或类型错误时不能静默当作最后一页', async (t) => {
  let mode = 'anthropic'
  const { base } = await gateway(t, () => ({ data: mode === 'anthropic'
    ? { data: [{ id: 'first' }], has_more: true }
    : { models: [{ name: 'models/first' }], nextPageToken: 123 } }))
  await assert.rejects(fetchProviderModels({ api: 'anthropic-messages', baseUrl: base, apiKey: '' }), /未完整获取.*游标无效或缺失/)
  mode = 'google'
  await assert.rejects(fetchProviderModels({ api: 'google-generative-ai', baseUrl: base, apiKey: '' }), /未完整获取.*游标无效或缺失/)
})

test('OpenAI 备用端点仍可获取，元数据来源和参考价不覆盖网关自己的参数', async (t) => {
  const { base, requests } = await gateway(t, ({ url }) => url.pathname === '/models'
    ? { status: 404, data: { error: 'fixture missing endpoint' } }
    : { data: { data: [{ id: 'demo' }, { id: 'gateway-price', context_length: 64000, pricing: { prompt: '0.000007', completion: '0.000009' } }] } })
  const models = await fetchProviderModels({ api: 'openai-completions', baseUrl: base, apiKey: 'fixture-key' })
  assert.deepEqual(requests.map((request) => request.url.pathname), ['/models', '/v1/models'])
  assert.equal(models[0].contextWindow, 128000)
  assert.equal(models[0].cost.input, 1)
  assert.equal(models[0].referenceCost, true)
  assert.deepEqual(models[0].metadataSource, { provider: 'openai', modelId: 'demo', match: 'reference' })
  assert.equal(models[0].thinkingLevelMap, undefined)
  assert.equal(models[1].contextWindow, 64000)
  assert.equal(models[1].cost.input, 7)
  assert.equal(models[1].cost.output, 9)
  assert.equal(models[1].referenceCost, undefined)
})
