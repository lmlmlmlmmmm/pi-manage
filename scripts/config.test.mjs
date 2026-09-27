import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { loadState, saveAll, validate } from '../server/config.ts'
import { modelKeyHeaders, readModelApiKey } from '../src/lib/modelAuth.ts'

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pi-manage-config-'))
  const previousDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const paths = ['.pi-manage/providers.json', 'models.json', 'settings.json'].map((file) => join(dir, file))
  const provider = { baseUrl: 'https://original.example/v1', models: [{ id: 'demo' }] }
  fs.writeFileSync(paths[1], JSON.stringify({ providers: { demo: provider } }))
  fs.writeFileSync(paths[2], JSON.stringify({ theme: 'dark', unknownSetting: { retained: true } }))
  const state = loadState()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousDir
    // 清理范围固定为本测试创建的临时目录，防止误删用户真实配置。
    const rel = relative(tmpdir(), dir)
    assert.ok(rel.startsWith('pi-manage-config-') && !isAbsolute(rel) && !rel.includes('..'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const read = () => paths.map((path) => fs.readFileSync(path, 'utf-8'))
  return { dir, paths, state, read }
}

test('保存保留未知字段，并合并 pi CLI 在页面打开后的 settings 修改', (t) => {
  const { state, paths } = fixture(t)
  const baseline = structuredClone(state.settings)
  fs.writeFileSync(paths[2], JSON.stringify({ ...state.settings, lastChangelogVersion: 'external' }))
  state.library.providers.demo.config.extraField = { retained: true }
  state.settings.theme = 'light'
  const result = saveAll(state.library, state.settings, baseline, state.revision)
  assert.equal(result.ok, true)
  assert.notEqual(result.revision, state.revision)
  assert.equal(result.settings.theme, 'light')
  assert.equal(result.settings.lastChangelogVersion, 'external')
  assert.deepEqual(result.settings.unknownSetting, { retained: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(paths[1], 'utf-8')).providers.demo.extraField, { retained: true })
})

test('模型独立密钥写入库和 pi 投影，重新加载可继续编辑，恢复继承不影响 Provider', (t) => {
  const { state, paths } = fixture(t)
  const provider = state.library.providers.demo.config
  provider.api = 'openai-completions'
  provider.apiKey = 'fixture-provider-key'
  provider.models[0].headers = modelKeyHeaders(provider, { 'User-Agent': 'fixture-UA' }, '$PI_MANAGE_TEST_MODEL_KEY')
  assert.equal(saveAll(state.library, state.settings, state.settings, state.revision).ok, true)
  for (const path of paths.slice(0, 2)) {
    const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
    const written = data.providers.demo.config ?? data.providers.demo
    assert.equal(written.apiKey, 'fixture-provider-key')
    assert.equal(written.models[0].headers.Authorization, 'Bearer $PI_MANAGE_TEST_MODEL_KEY')
  }
  const loaded = loadState()
  assert.deepEqual(loaded.diffs, [])
  const savedProvider = loaded.library.providers.demo.config
  assert.equal(readModelApiKey(savedProvider.models[0].headers, savedProvider), '$PI_MANAGE_TEST_MODEL_KEY')
  delete savedProvider.models[0].headers.Authorization
  assert.equal(saveAll(loaded.library, loaded.settings, loaded.settings, loaded.revision).ok, true)
  const restored = JSON.parse(fs.readFileSync(paths[1], 'utf-8')).providers.demo
  assert.equal(restored.apiKey, 'fixture-provider-key')
  assert.deepEqual(restored.models[0].headers, { 'User-Agent': 'fixture-UA' })
})

test('外部修改同名 Provider 后拒绝旧版本保存，保持三个文件原样', (t) => {
  const { state, paths, read } = fixture(t)
  const external = JSON.parse(fs.readFileSync(paths[1], 'utf-8'))
  external.providers.demo.baseUrl = 'https://external.example/v1'
  fs.writeFileSync(paths[1], JSON.stringify(external))
  const before = read()
  const result = saveAll(state.library, { theme: 'light' }, state.settings, state.revision)
  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
  assert.deepEqual(result.written, [])
  assert.deepEqual(read(), before)
  const reloaded = loadState()
  assert.equal(reloaded.diffs[0].kind, 'external-modified')
  assert.equal(reloaded.diffs[0].config.baseUrl, 'https://external.example/v1')
})

test('另一个页面已保存库内容时，旧页面不能覆盖新版本', (t) => {
  const { state, read } = fixture(t)
  const secondPage = loadState()
  state.library.providers.demo.config.baseUrl = 'https://first-page.example/v1'
  assert.equal(saveAll(state.library, state.settings, state.settings, state.revision).ok, true)
  const before = read()
  secondPage.library.providers.demo.config.baseUrl = 'https://second-page.example/v1'
  const result = saveAll(secondPage.library, secondPage.settings, secondPage.settings, secondPage.revision)
  assert.equal(result.conflict, true)
  assert.deepEqual(read(), before)
})

test('加载期间发生外部修改时，返回的版本仍对应已读取的旧内容', (t) => {
  const { paths, read } = fixture(t)
  const originalRead = fs.readFileSync
  let changed = false
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const content = originalRead(path, ...args)
    if (!changed && path === paths[1]) {
      changed = true
      const external = JSON.parse(content)
      external.providers.demo.baseUrl = 'https://changed-during-load.example'
      fs.writeFileSync(paths[1], JSON.stringify(external))
    }
    return content
  })
  syncBuiltinESMExports()
  const state = loadState()
  const before = read()
  const result = saveAll(state.library, { theme: 'light' }, state.settings, state.revision)
  assert.equal(result.conflict, true)
  assert.deepEqual(read(), before)
})

test('JSON 对象键顺序变化不会被识别为 Provider 内容修改', (t) => {
  const { paths } = fixture(t)
  fs.writeFileSync(paths[1], JSON.stringify({ providers: { demo: { models: [{ id: 'demo' }], baseUrl: 'https://original.example/v1' } } }))
  assert.deepEqual(loadState().diffs, [])
})

test('缺少版本或 settings 损坏时，保存不会写入任何配置', (t) => {
  const { state, paths, read } = fixture(t)
  const before = read()
  assert.equal(saveAll(state.library, state.settings, state.settings).conflict, true)
  assert.deepEqual(read(), before)
  fs.writeFileSync(paths[2], '{broken')
  const broken = read()
  const result = saveAll(state.library, state.settings, state.settings, state.revision)
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /settings\.json 不是合法 JSON/)
  assert.deepEqual(read(), broken)
})

test('第二个配置替换失败时，恢复第一个文件及全部原始内容', (t) => {
  const { state, paths, read, dir } = fixture(t)
  const before = read()
  const originalRename = fs.renameSync
  let failed = false
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && to === paths[1] && String(from).includes('.tmp-')) {
      failed = true
      throw new Error('模拟目标文件被占用')
    }
    return originalRename(from, to)
  })
  syncBuiltinESMExports()
  state.library.providers.demo.config.baseUrl = 'https://new.example/v1'
  const result = saveAll(state.library, { theme: 'light' }, state.settings, state.revision)
  assert.equal(result.ok, false)
  assert.deepEqual(result.written, [])
  assert.deepEqual(read(), before)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => /\.(tmp|bak)-/.test(name)), [])
  assert.deepEqual(fs.readdirSync(join(dir, '.pi-manage')).filter((name) => /\.(tmp|bak)-/.test(name)), [])
})

test('回滚也失败时保留原始备份，并明确返回尚未恢复的文件', (t) => {
  const { state, paths, read, dir } = fixture(t)
  const before = read()
  const originalRename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === paths[1] || String(from).includes('.bak-')) throw new Error('模拟持续占用')
    return originalRename(from, to)
  })
  syncBuiltinESMExports()
  state.library.providers.demo.config.baseUrl = 'https://new.example/v1'
  const result = saveAll(state.library, state.settings, state.settings, state.revision)
  assert.equal(result.ok, false)
  assert.equal(result.written.length, 1)
  assert.ok(result.errors.some((error) => error.includes('原始备份保留在')))
  const backup = fs.readdirSync(join(dir, '.pi-manage')).find((name) => name.includes('.bak-'))
  assert.ok(backup)
  assert.equal(fs.readFileSync(join(dir, '.pi-manage', backup), 'utf-8'), before[0])
})

test('写盘前拒绝非布尔启用标记和非字符串模型 id', () => {
  assert.ok(validate({ providers: { demo: { enabled: 'false', config: { models: [{ id: 123 }] } } } }).length >= 2)
})

test('models.json 支持行注释、尾逗号和 BOM，保留字符串内容及文件版本检查', (t) => {
  const { paths, state } = fixture(t)
  const provider = state.library.providers.demo.config
  provider.headers = { 'X-Fixture': 'https://example.test/a//b,}\\" // 字符串' }
  const serialized = JSON.stringify({ providers: { demo: provider } }, null, 2)
  const commented = '\uFEFF' + serialized.replace('{', '{\n// 模型配置说明').replace(/\n}$/, ',\n}')
  fs.writeFileSync(paths[1], commented)
  fs.writeFileSync(paths[2], '\uFEFF' + fs.readFileSync(paths[2], 'utf8'))
  const loaded = loadState()
  assert.equal(loaded.settings.theme, 'dark')
  assert.deepEqual(loaded.diffs[0].config.headers, provider.headers)
  loaded.library.providers.demo.config = loaded.diffs[0].config
  const result = saveAll(loaded.library, loaded.settings, loaded.settings, loaded.revision)
  assert.equal(result.ok, true, result.errors.join('；'))
  assert.deepEqual(JSON.parse(fs.readFileSync(paths[1], 'utf8')).providers.demo.headers, provider.headers)
  assert.deepEqual(loadState().diffs, [])
})

test('settings 仍拒绝注释和尾逗号，models 不接受块注释', (t) => {
  const { paths, read } = fixture(t)
  fs.writeFileSync(paths[2], '{"theme":"dark",}')
  const before = read()
  assert.throws(loadState, /settings\.json 不是合法 JSON/)
  assert.deepEqual(read(), before)
  fs.writeFileSync(paths[2], '{"theme":"dark"}')
  fs.writeFileSync(paths[1], '{/* 不受 pi 支持 */"providers":{}}')
  assert.throws(loadState, /models\.json 不是合法 JSON/)
})

test('保存前按字段拒绝无效模型配置，全部文件保持原样', (t) => {
  const { state, read } = fixture(t)
  const before = read()
  const invalidModels = [
    [{ contextWindow: -1 }, 'contextWindow'],
    [{ maxTokens: 0 }, 'maxTokens'],
    [{ headers: { 'X-Key': 123 } }, 'headers[X-Key]'],
    [{ input: ['audio'] }, '.input'],
    [{ reasoning: 'yes' }, 'reasoning'],
    [{ thinkingLevelMap: { high: true } }, 'thinkingLevelMap.high'],
    [{ samplingParams: [] }, 'samplingParams'],
    [{ promptCache: { long: 0 } }, 'promptCache.long'],
    [{ inputLimits: { images: { resize: { jpegQuality: 101 } } } }, 'inputLimits.images.resize.jpegQuality'],
    [{ inputLimits: { maxRequestBytes: 1.5 } }, 'inputLimits.maxRequestBytes'],
    [{ compat: { supportsStore: 'false' } }, 'compat.supportsStore'],
    [{ compat: { maxTokensField: 'tokens' } }, 'compat.maxTokensField'],
  ]
  for (const [fields, field] of invalidModels) {
    const library = structuredClone(state.library)
    library.providers.demo.config.models = [{ id: 'demo', ...fields }]
    const result = saveAll(library, state.settings, state.settings, state.revision)
    assert.equal(result.ok, false, field)
    assert.ok(result.errors.some((error) => error.includes(field)), result.errors.join('；'))
    assert.deepEqual(result.written, [])
    assert.deepEqual(read(), before)
  }
})

test('Provider 和 modelOverrides 校验区分字段类型与局部覆盖，保留扩展字段及合法继承', () => {
  const library = (config) => ({ providers: { extension: { enabled: true, config } } })
  for (const [config, field] of [
    [{ api: 1, models: [{ id: 'demo' }] }, '.api'],
    [{ apiKey: '', models: [{ id: 'demo' }] }, '.apiKey'],
    [{ authHeader: 'true' }, '.authHeader'],
    [{ headers: { 'X-Key': false } }, 'headers[X-Key]'],
    [{ modelOverrides: [] }, '.modelOverrides'],
    [{ modelOverrides: { demo: { cost: { input: 'bad' } } } }, 'cost.input'],
    [{ models: [[]] }, '不是对象'],
    [{ oauth: 'radius' }, 'baseUrl'],
    [{}, '至少一项'],
  ]) {
    const errors = validate(library(config))
    assert.ok(errors.some((error) => error.includes(field)), `${field}: ${errors.join('；')}`)
  }
  // 官方允许自定义 API 字符串和内置/扩展提供默认连接；覆盖项不要求写齐所有费率。
  const config = {
    models: [{ id: 'demo', futureField: { preserved: true } }],
    modelOverrides: { demo: { cost: { input: 1 }, headers: { Authorization: '$AUTH' }, futureField: 1 } },
    compat: { futureOption: true },
  }
  assert.deepEqual(validate(library(config)), [])
  assert.deepEqual(validate(library({ api: 'extension-api', models: [{ id: 'demo' }] })), [])
})
