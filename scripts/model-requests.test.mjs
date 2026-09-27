import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { modelKeyHeaders, mergeHeaders } from '../src/lib/modelAuth.ts'
import { testModel } from '../server/modelTest.ts'
import { fetchProviderModels } from '../server/fetchModels.ts'

function eventStream(events) {
  return events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
}

function successfulStream(url) {
  if (url.includes(':streamGenerateContent')) return eventStream([
    { candidates: [{ content: { parts: [{ text: 'fixture ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'reply' }] }, finishReason: 'STOP' }] },
  ])
  if (url.endsWith('/responses')) return eventStream([
    { type: 'response.output_text.delta', delta: 'fixture reply' },
    { type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'fixture reply' }] }] } },
  ])
  if (url.split('?')[0].endsWith('/messages')) return eventStream([
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'fixture ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ])
  return eventStream([
    { choices: [{ delta: { role: 'assistant', content: 'fixture ' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'reply' }, finish_reason: 'stop' }] },
    '[DONE]',
  ])
}

async function gateway(t, respond) {
  const requests = []
  const previousProxy = process.env.PI_MANAGE_PROXY
  delete process.env.PI_MANAGE_PROXY
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
    requests.push(request)
    if (respond) {
      await respond(request, res)
      return
    }
    if (req.method === 'POST' && (JSON.parse(request.body).stream || req.url.includes(':streamGenerateContent'))) {
      res.setHeader('Content-Type', 'text/event-stream')
      // 分块经过真实 HTTP 传输，验证收齐事件后才给出成功结果。
      const stream = successfulStream(req.url)
      res.write(stream.slice(0, 19))
      res.end(stream.slice(19))
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.method === 'GET'
      ? { data: [{ id: 'fixture-model' }], models: [{ name: 'models/fixture-model' }] }
      : { choices: [{ message: { content: 'fixture reply' } }], content: [{ text: 'fixture reply' }], output: [{ content: [{ text: 'fixture reply' }] }], candidates: [{ content: { parts: [{ text: 'fixture reply' }] } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const originalFetch = globalThis.fetch
  // 模型请求实际经过本机 HTTP；外部元数据只返回空目录，验证不接触中转站或真实凭据。
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === 'https://models.dev/api.json') return Promise.resolve(new Response('{}'))
    assert.ok(String(url).startsWith(base + '/'), `测试禁止外部请求：${new URL(String(url)).origin}`)
    return originalFetch(url, options)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    if (previousProxy === undefined) delete process.env.PI_MANAGE_PROXY
    else process.env.PI_MANAGE_PROXY = previousProxy
  })
  return { base, requests }
}

for (const [api, authHeader] of [
  ['openai-completions', false], ['openai-responses', false],
  ['anthropic-messages', false], ['anthropic-messages', true],
  ['google-generative-ai', false], ['google-generative-ai', true],
]) {
  test(`${api}${authHeader ? ' + Bearer' : ''}：获取模型和连接测试实际发送同一把独立密钥`, async (t) => {
    const { base, requests } = await gateway(t)
    const provider = { api, baseUrl: api === 'google-generative-ai' ? `${base}/v1beta` : base, apiKey: 'default-group-key', authHeader, headers: { 'User-Agent': 'fixture-UA' } }
    const model = { id: 'fixture-model', headers: modelKeyHeaders(provider, {}, 'model-group-key') }
    const imported = await fetchProviderModels({ ...provider, headers: mergeHeaders(provider.headers, model.headers) })
    assert.equal(imported[0].id, model.id)
    const result = await testModel(provider, model, { prompt: 'fixture prompt' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.reply, 'fixture reply')
    assert.equal(requests.length, 2)
    const header = api.startsWith('openai-') ? 'authorization' : api === 'anthropic-messages' ? 'x-api-key' : 'x-goog-api-key'
    for (const request of requests) {
      assert.equal(request.headers[header], header === 'authorization' ? 'Bearer model-group-key' : 'model-group-key')
      if (authHeader) assert.equal(request.headers.authorization, 'Bearer model-group-key')
      assert.equal(request.headers['user-agent'], 'fixture-UA')
      assert.ok(!JSON.stringify(request).includes('default-group-key'))
      assert.ok(!request.url.includes('key='))
      if (api === 'anthropic-messages') assert.equal(request.headers['anthropic-version'], '2023-06-01')
    }
    assert.ok(requests[1].body.includes('fixture prompt'))
    if (api === 'google-generative-ai') assert.equal(requests[1].url, '/v1beta/models/fixture-model:streamGenerateContent?alt=sse')
    assert.equal(result.stream, true)
    assert.equal(provider.apiKey, 'default-group-key')
  })
}

test('独立认证解析失败时，导入与测试都在发送请求前失败', async (t) => {
  const { base, requests } = await gateway(t)
  const variable = 'PI_MANAGE_TEST_UNDEFINED_MODEL_KEY'
  const previous = process.env[variable]
  delete process.env[variable]
  t.after(() => { if (previous !== undefined) process.env[variable] = previous })
  const provider = { api: 'openai-completions', baseUrl: base, apiKey: 'default-group-key' }
  const model = { id: 'fixture-model', headers: modelKeyHeaders(provider, {}, `$${variable}`) }
  await assert.rejects(fetchProviderModels({ ...provider, headers: model.headers }), /环境变量未定义/)
  const result = await testModel(provider, model)
  assert.equal(result.ok, false)
  assert.match(result.error, /环境变量未定义/)
  assert.equal(requests.length, 0)
})

test('测试开始前已经取消时不访问网关', async (t) => {
  const { base, requests } = await gateway(t)
  const controller = new AbortController()
  controller.abort()
  const result = await testModel({ api: 'openai-completions', baseUrl: base }, { id: 'demo' }, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.error, '测试已取消')
  assert.equal(requests.length, 0)
})

test('Chat 请求采用兼容配置、模型覆盖和输出上限，不改写原配置', async (t) => {
  const { base, requests } = await gateway(t)
  const provider = {
    api: 'openai-completions', baseUrl: base, apiKey: 'fixture-key',
    compat: { maxTokensField: 'max_tokens', supportsStore: true, supportsUsageInStreaming: true },
    modelOverrides: { demo: { maxTokens: 256, compat: { supportsUsageInStreaming: false }, samplingParams: { top_p: 0.8 } } },
  }
  const model = { id: 'demo', maxTokens: 512, compat: { maxTokensField: 'max_completion_tokens', supportsStore: false }, samplingParams: { temperature: 0.2 } }
  const before = structuredClone({ provider, model })
  const result = await testModel(provider, model, { prompt: 'fixture' })
  assert.equal(result.ok, true, result.error)
  const body = JSON.parse(requests[0].body)
  assert.equal(body.max_completion_tokens, 256)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.store, undefined)
  assert.equal(body.stream_options, undefined)
  assert.equal(body.stream, true)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.top_p, 0.8)
  assert.deepEqual({ provider, model }, before)
})

test('Responses 尊重关闭输出上限字段，保留显式普通对话模式', async (t) => {
  const { base, requests } = await gateway(t)
  const result = await testModel({ api: 'openai-responses', baseUrl: base, compat: { supportsMaxOutputTokens: false } }, { id: 'demo' }, { stream: false })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.stream, false)
  const body = JSON.parse(requests[0].body)
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.stream, false)
  assert.equal(body.store, false)
})

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
  test(`${api}：普通 JSON 对话仍可验证`, async (t) => {
    const { base, requests } = await gateway(t)
    const result = await testModel({ api, baseUrl: base }, { id: 'demo' }, { stream: false })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.reply, 'fixture reply')
    assert.equal(result.stream, false)
    if (api === 'google-generative-ai') assert.equal(requests[0].url, '/models/demo:generateContent')
  })
}

test('HTML、空响应、错误协议和 HTTP 200 中的错误均不能伪装成成功', async (t) => {
  let response = ''
  const { base } = await gateway(t, (_, res) => res.end(response))
  for (const [body, stream, error] of [
    ['<html>login</html>', false, /不是有效 JSON/],
    ['', false, /空响应/],
    ['{}', false, /不符合/],
    [JSON.stringify({ candidates: [] }), false, /不符合/],
    [JSON.stringify({ error: { message: 'invalid fixture credential' } }), false, /invalid fixture credential/],
    [JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), true, /返回普通 JSON/],
    [eventStream([{ error: { message: 'upstream overloaded' } }]), true, /upstream overloaded/],
  ]) {
    response = body
    const result = await testModel({ api: 'openai-completions', baseUrl: base }, { id: 'demo' }, { stream })
    assert.equal(result.ok, false)
    assert.match(result.error, error)
  }
})

test('所有协议都要求流式结束事件，畸形或被截断的事件报告失败', async (t) => {
  let response = ''
  const { base } = await gateway(t, (_, res) => res.end(response))
  for (const [api, events] of [
    ['openai-completions', [{ choices: [{ delta: { content: 'partial' } }] }]],
    ['openai-responses', [{ type: 'response.output_text.delta', delta: 'partial' }]],
    ['anthropic-messages', [{ type: 'message_start', message: { content: [{ text: 'partial' }] } }]],
    ['google-generative-ai', [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }]],
  ]) {
    response = eventStream(events)
    const result = await testModel({ api, baseUrl: base }, { id: 'demo' })
    assert.equal(result.ok, false, api)
    assert.match(result.error, /提前结束/)
  }
  response = 'data: {"choices":\n\n'
  assert.match((await testModel({ api: 'openai-completions', baseUrl: base }, { id: 'demo' })).error, /无效 JSON/)
  response = ': heartbeat\n\ndata: [DONE]\n\n'
  assert.match((await testModel({ api: 'openai-completions', baseUrl: base }, { id: 'demo' })).error, /未收到有效/)
})

test('Chat 仅在显式关闭 finish_reason 时接受 DONE，支持 SSE 多行 data 和 CRLF', async (t) => {
  const response = ': heartbeat\r\n\nevent: message\r\ndata: {"choices": [\r\ndata: {"delta":{"content":"多行回复"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
  const { base } = await gateway(t, (_, res) => res.end(response))
  const provider = { api: 'openai-completions', baseUrl: base }
  assert.equal((await testModel(provider, { id: 'demo' })).ok, false)
  const result = await testModel(provider, { id: 'demo', compat: { supportsFinishReason: false } })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reply, '多行回复')
})

test('未支持协议、缺失显式连接、无效参数和超额采样在网络请求前失败', async (t) => {
  const { base, requests } = await gateway(t)
  for (const [provider, model, message] of [
    [{ api: 'extension-api', baseUrl: base }, { id: 'demo' }, /暂不支持/],
    [{ baseUrl: base }, { id: 'demo' }, /API 协议/],
    [{ api: 'openai-completions' }, { id: 'demo' }, /baseUrl/],
    [{ api: 'openai-completions', baseUrl: base }, { id: 'demo', maxTokens: 0 }, /maxTokens/],
    [{ api: 'openai-completions', baseUrl: base }, { id: 'demo', samplingParams: { stream: false } }, /samplingParams.stream/],
    [{ api: 'openai-completions', baseUrl: base }, { id: 'demo', samplingParams: { max_completion_tokens: 100000 } }, /2048/],
  ]) {
    const result = await testModel(provider, model)
    assert.equal(result.ok, false)
    assert.match(result.error, message)
  }
  assert.equal(requests.length, 0)
})

test('路由覆盖逐层合并，modelOverrides 认证头不会覆盖模型独立密钥', async (t) => {
  const { base, requests } = await gateway(t)
  const provider = {
    api: 'openai-completions', baseUrl: base, apiKey: 'fixture-provider-key',
    compat: { openRouterRouting: { allow_fallbacks: false } },
    modelOverrides: { demo: { headers: { Authorization: 'Bearer fixture-override-key' }, compat: { openRouterRouting: { order: ['fixture'] } } } },
  }
  const model = { id: 'demo', headers: { authorization: 'Bearer fixture-model-key' }, compat: { openRouterRouting: { only: ['fixture'] } } }
  const result = await testModel(provider, model)
  assert.equal(result.ok, true, result.error)
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-model-key')
  assert.deepEqual(JSON.parse(requests[0].body).provider, { allow_fallbacks: false, only: ['fixture'], order: ['fixture'] })
})

test('流正常关闭也不能掩盖拒绝、内容过滤或 Responses 失败状态', async (t) => {
  let response = ''
  const { base } = await gateway(t, (_, res) => res.end(response))
  for (const [api, events, error] of [
    ['openai-completions', [{ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] }, '[DONE]'], /content_filter/],
    ['google-generative-ai', [{ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }], /SAFETY/],
    ['anthropic-messages', [{ type: 'message_start', message: { content: [] } }, { type: 'message_delta', delta: { stop_reason: 'refusal' } }, { type: 'message_stop' }], /refusal/],
    ['openai-responses', [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } }], /content_filter/],
    ['openai-responses', [{ type: 'response.failed', response: { error: { message: 'fixture failure' } } }], /fixture failure/],
    ['openai-responses', [{ type: 'response.completed', response: { status: 'in_progress', output: [] } }], /尚未完成/],
  ]) {
    response = eventStream(events)
    const result = await testModel({ api, baseUrl: base }, { id: 'demo' })
    assert.equal(result.ok, false, api)
    assert.match(result.error, error)
  }
})

test('测试耗时包含接收响应正文，HTTP 错误保留状态码和网关说明', async (t) => {
  let fail = false
  const { base } = await gateway(t, async (_, res) => {
    res.writeHead(fail ? 401 : 200, { 'Content-Type': 'application/json' })
    res.flushHeaders()
    await new Promise((resolve) => setTimeout(resolve, 40))
    res.end(JSON.stringify(fail ? { error: { message: 'fixture auth failure' } } : { choices: [{ message: { content: 'reply' } }] }))
  })
  const provider = { api: 'openai-completions', baseUrl: base }
  const result = await testModel(provider, { id: 'demo' }, { stream: false })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.ms >= 39, `完整响应耗时：${result.ms}`)
  fail = true
  const error = await testModel(provider, { id: 'demo' }, { stream: false })
  assert.equal(error.ok, false)
  assert.match(error.error, /HTTP 401.*fixture auth failure/)
})
