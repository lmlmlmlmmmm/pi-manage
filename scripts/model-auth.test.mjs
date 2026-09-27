import assert from 'node:assert/strict'
import { test } from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { modelKeyHeaders, mergeHeaders, readModelApiKey, redactHeaders, providerAuthNotice } from '../src/lib/modelAuth.ts'
import { resolveRequestHeaders } from '../server/requestAuth.ts'

const cases = [
  ['openai-completions', false, { Authorization: 'Bearer model-key' }],
  ['openai-responses', false, { Authorization: 'Bearer model-key' }],
  ['anthropic-messages', false, { 'x-api-key': 'model-key' }],
  ['anthropic-messages', true, { 'x-api-key': 'model-key', Authorization: 'Bearer model-key' }],
  ['google-generative-ai', false, { 'x-goog-api-key': 'model-key' }],
  ['google-generative-ai', true, { 'x-goog-api-key': 'model-key', Authorization: 'Bearer model-key' }],
]

test('认证提示不读取凭据或泄露密钥，独立模型认证不能被标记为 Provider 已可用', () => {
  const missing = providerAuthNotice({}, true)
  assert.equal(missing.type, 'warning')
  assert.match(missing.text, /不能单独使模型出现在/)
  assert.match(missing.text, /未验证/)
  for (const apiKey of ['fixture-secret', '$FIXTURE_SECRET', '!fixture-secret-command']) {
    const notice = providerAuthNotice({ apiKey }, true)
    assert.ok(!notice.text.includes(apiKey))
    assert.match(notice.text, /不代表.*可用性已验证/)
  }
  assert.match(providerAuthNotice({ oauth: 'radius' }).text, /OAuth 登录/)
})

for (const [api, authHeader, expected] of cases) {
  test(`${api}${authHeader ? ' + Bearer' : ''}：独立密钥可保存重读，移除后恢复 Provider 密钥`, () => {
    const provider = { api, apiKey: 'provider-key', authHeader }
    const modelHeaders = modelKeyHeaders(provider, { 'User-Agent': 'fixture-client' }, 'model-key')
    const saved = JSON.parse(JSON.stringify({ id: 'fixture-model', headers: modelHeaders }))
    assert.equal(saved.apiKey, undefined)
    assert.equal(readModelApiKey(saved.headers, provider), 'model-key')
    assert.deepEqual(resolveRequestHeaders(api, provider, saved.headers), { 'User-Agent': 'fixture-client', ...expected })
    assert.equal(provider.apiKey, 'provider-key')
    const inherited = resolveRequestHeaders(api, provider)
    for (const value of Object.values(inherited)) assert.ok(value.includes('provider-key'))
  })
}

test('模型覆盖认证头时忽略大小写，Provider 和其他 Header 原样保留', () => {
  const provider = { api: 'openai-completions', apiKey: 'provider-key', headers: { authorization: 'Bearer header-key', 'User-Agent': 'provider-UA' } }
  const saved = modelKeyHeaders(provider, { 'user-agent': 'model-UA' }, 'model-key')
  assert.deepEqual(resolveRequestHeaders(provider.api, provider, saved), { 'user-agent': 'model-UA', Authorization: 'Bearer model-key' })
  assert.equal(provider.headers.authorization, 'Bearer header-key')
  assert.deepEqual(mergeHeaders({ 'X-Custom': 'before' }, { 'x-custom': 'after' }), { 'x-custom': 'after' })
})

test('已存在手写认证头、跨协议认证头或不完整密钥时明确拒绝，避免静默改写分组', () => {
  const provider = { api: 'openai-completions' }
  assert.throws(() => modelKeyHeaders(provider, { authorization: 'Basic existing' }, 'new-key'), /已有认证 Header/)
  assert.throws(() => modelKeyHeaders({ ...provider, headers: { 'x-api-key': 'other-key' } }, {}, 'new-key'), /Provider 中存在其他认证 Header/)
  assert.throws(() => modelKeyHeaders(provider, {}, ''), /不能为空/)
  assert.throws(() => modelKeyHeaders(provider, {}, 'secret\nheader'), /换行/)
  assert.throws(() => modelKeyHeaders(provider, {}, '!some-command'), /自定义 headers/)
  assert.throws(() => modelKeyHeaders({}, {}, 'key'), /API 协议/)
  assert.equal(readModelApiKey({ Authorization: 'Basic existing' }, provider), undefined)
  assert.equal(readModelApiKey({ Authorization: '!full-header-command' }, provider), undefined)
  assert.equal(readModelApiKey({ Authorization: 'Bearer a', authorization: 'Bearer b' }, provider), undefined)
})

test('独立密钥保留环境变量引用，发送时解析；缺失或空值不会退回默认分组', (t) => {
  const name = 'PI_MANAGE_TEST_MODEL_KEY'
  const previous = process.env[name]
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
  const provider = { api: 'openai-completions', apiKey: 'provider-key' }
  const headers = modelKeyHeaders(provider, {}, `$${name}`)
  assert.equal(readModelApiKey(headers, provider), `$${name}`)
  process.env[name] = 'resolved-model-key'
  assert.equal(resolveRequestHeaders(provider.api, provider, headers).Authorization, 'Bearer resolved-model-key')
  process.env[name] = ''
  assert.throws(() => resolveRequestHeaders(provider.api, provider, headers), /不能为空/)
  delete process.env[name]
  assert.throws(() => resolveRequestHeaders(provider.api, provider, headers), /环境变量未定义/)
})

test('列表提示中的所有认证头均脱敏，其他 Header 可正常查看', () => {
  const result = redactHeaders({ Authorization: 'Bearer secret-one', 'X-Api-Key': 'secret-two', 'x-goog-api-key': 'secret-three', 'User-Agent': 'fixture-UA' })
  assert.ok(!JSON.stringify(result).includes('secret-'))
  assert.equal(result['User-Agent'], 'fixture-UA')
})

test('高级 Header 的取值命令只执行一次，失败后不会尝试 Provider 的另一把密钥', (t) => {
  const commands = []
  let fail = false
  t.mock.method(childProcess, 'execSync', (command) => {
    commands.push(command)
    if (fail) throw new Error('fixture failure')
    return 'Bearer fixture-command-key\n'
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const provider = { apiKey: '!unused-provider-command' }
  const headers = { Authorization: '!model-header-command' }
  assert.equal(resolveRequestHeaders('openai-completions', provider, headers).Authorization, 'Bearer fixture-command-key')
  assert.deepEqual(commands, ['model-header-command'])
  fail = true
  assert.throws(() => resolveRequestHeaders('openai-completions', provider, headers), /取值命令失败/)
  assert.deepEqual(commands, ['model-header-command', 'model-header-command'])
})
