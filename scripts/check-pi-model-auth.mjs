// 可选兼容性验证：使用显式指定的 pi 安装目录，只读程序文件；认证和模型配置均在内存中。
// 所有 SDK 请求由本进程拦截，不访问外部服务，也不读取真实 auth.json / models.json。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { modelKeyHeaders } from '../src/lib/modelAuth.ts'

const [piDirectory] = process.argv.slice(2)
if (!piDirectory) throw new Error('请指定已安装的 pi-coding-agent 目录')
const root = resolve(piDirectory)
const load = (name) => import(pathToFileURL(join(root, 'dist/core', name)).href)
const { ModelRuntime } = await load('model-runtime.js')
const { ModelConfig } = await load('model-config.js')
const { RuntimeCredentials } = await load('runtime-credentials.js')
const { AuthStorage } = await load('auth-storage.js')
const { InMemoryCodingAgentModelsStore } = await load('models-store.js')
const originalFetch = globalThis.fetch
const requests = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  assert.equal(url.hostname, 'pi-manage-auth.test')
  requests.push({ url: url.href, headers: new Headers(init?.headers ?? input.headers) })
  // 明确的 400 结束 SDK 请求，避免重试；这里仅验证真正发出的认证信息。
  return new Response(JSON.stringify({ error: { message: 'fixture complete' } }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  })
}
try {
  for (const [api, authHeader] of [
    ['openai-completions', false], ['openai-responses', false],
    ['anthropic-messages', false], ['anthropic-messages', true],
    ['google-generative-ai', false], ['google-generative-ai', true],
  ]) {
    requests.length = 0
    const config = {
      api, authHeader, apiKey: 'fixture-provider-key', baseUrl: 'https://pi-manage-auth.test',
      models: [{ id: 'fixture-model', headers: modelKeyHeaders({ api, authHeader }, {}, 'fixture-model-key') }],
    }
    const runtime = new ModelRuntime(
      new RuntimeCredentials(AuthStorage.inMemory()),
      new ModelConfig(new Map([['fixture-relay', config]])),
      undefined, new InMemoryCodingAgentModelsStore(), [], false,
    )
    const model = runtime.getModel('fixture-relay', 'fixture-model')
    assert.ok(model, `${api} 模型注册失败`)
    const result = await runtime.complete(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, {
      maxTokens: 1, signal: AbortSignal.timeout(15_000),
    })
    assert.ok(requests.length > 0, result.errorMessage ?? `${api} 未发送请求`)
    for (const request of requests) {
      const header = api.startsWith('openai-') ? 'authorization' : api === 'anthropic-messages' ? 'x-api-key' : 'x-goog-api-key'
      assert.equal(request.headers.get(header), header === 'authorization' ? 'Bearer fixture-model-key' : 'fixture-model-key')
      if (authHeader) assert.equal(request.headers.get('authorization'), 'Bearer fixture-model-key')
      assert.ok(![...request.headers.values()].some((value) => value.includes('fixture-provider-key')))
    }
    console.log(`✓ pi 实际请求采用模型密钥：${api}${authHeader ? ' + Bearer' : ''}`)
  }
  console.log(`Pi ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version} 兼容性验证通过`)
} finally {
  globalThis.fetch = originalFetch
}
