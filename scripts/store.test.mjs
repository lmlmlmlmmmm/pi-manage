import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { usePiStore } from '../src/stores/pi.ts'

async function fixture(t, diffs = []) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = {
    library: { providers: { demo: { enabled: true, config: { baseUrl: 'https://original.example', models: [{ id: 'demo' }] } } } },
    settings: { theme: 'dark', skills: ['original'] },
    revision: 'revision-1',
    warnings: [], diffs, piDir: 'isolated-test',
  }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/config') return Response.json(state)
    if (path === '/api/proxy') return Response.json({})
    assert.equal(path, '/api/save')
    const payload = JSON.parse(init.body)
    return new Promise((resolve) => {
      requests.push({
        payload,
        finish(result = { ok: true, errors: [], written: [], settings: payload.settings, revision: 'revision-2' }) {
          resolve(Response.json(result))
        },
      })
    })
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = usePiStore(pinia)
  await store.reload()
  await nextTick()
  t.after(() => disposePinia(pinia))
  return { store, requests, state }
}

test('连续输入按最后一次编辑防抖，800ms 内不提前提交', async (t) => {
  const { store, requests } = await fixture(t)
  store.settingsData.theme = 'first'
  await nextTick()
  t.mock.timers.tick(500)
  store.settingsData.theme = 'second'
  await nextTick()
  t.mock.timers.tick(799)
  assert.equal(requests.length, 0)
  t.mock.timers.tick(1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].payload.settings.theme, 'second')
  requests[0].finish()
  await nextTurn()
  assert.equal(store.dirty, false)
})

test('保存期间的新 Provider 编辑、settings 修改与删除会留到下一次提交', async (t) => {
  const { store, requests } = await fixture(t)
  store.library.providers.demo.config.baseUrl = 'https://submitted.example'
  store.settingsData.theme = 'submitted'
  const saving = store.flushAutoSave()
  store.library.providers.demo.config.baseUrl = 'https://new-edit.example'
  store.settingsData.theme = 'new-edit'
  delete store.settingsData.skills
  requests[0].finish({
    ok: true, errors: [], written: [], revision: 'revision-2',
    settings: { ...requests[0].payload.settings, externalField: 'retained' },
  })
  await saving
  assert.equal(store.library.providers.demo.config.baseUrl, 'https://new-edit.example')
  assert.equal(store.settingsData.theme, 'new-edit')
  assert.equal(store.settingsData.skills, undefined)
  assert.equal(store.settingsData.externalField, 'retained')
  assert.equal(store.dirty, true)
  const savingNext = store.flushAutoSave()
  assert.equal(requests[1].payload.revision, 'revision-2')
  assert.equal(requests[1].payload.settingsBaseline.theme, 'submitted')
  assert.equal(requests[1].payload.settings.theme, 'new-edit')
  assert.equal(requests[1].payload.settings.skills, undefined)
  requests[1].finish()
  await savingNext
  assert.equal(store.dirty, false)
})

test('自动保存失败停止循环重试，下一次编辑可重新提交', async (t) => {
  const { store, requests } = await fixture(t)
  store.settingsData.theme = 'first'
  const saving = store.flushAutoSave()
  requests[0].finish({ ok: false, errors: ['校验失败'], written: [] })
  await saving
  await nextTick()
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 1)
  assert.equal(store.dirty, true)
  assert.equal(store.autoSaveError, '校验失败')
  store.settingsData.theme = 'corrected'
  await nextTick()
  t.mock.timers.tick(800)
  assert.equal(requests.length, 2)
  requests[1].finish()
  await nextTurn()
  assert.equal(store.autoSaveError, '')
})

test('版本冲突保留页面编辑，重试和继续编辑都不能覆盖磁盘', async (t) => {
  const { store, requests } = await fixture(t)
  store.settingsData.theme = 'unsaved'
  const saving = store.flushAutoSave()
  requests[0].finish({ ok: false, conflict: true, errors: ['需要重新加载'], written: [] })
  await saving
  store.settingsData.theme = 'still-unsaved'
  await nextTick()
  t.mock.timers.tick(5000)
  await store.flushAutoSave()
  assert.equal(requests.length, 1)
  assert.equal(store.settingsData.theme, 'still-unsaved')
  assert.equal(store.saveConflict, true)
  await store.reload()
  assert.equal(store.saveConflict, false)
  assert.equal(store.autoSaveError, '')
  assert.equal(store.dirty, false)
})

test('外部差异未处理前暂停保存，采用外部配置后恢复', async (t) => {
  const { store, requests } = await fixture(t, [{
    kind: 'external-modified', name: 'demo', modelCount: 1,
    config: { baseUrl: 'https://external.example', models: [{ id: 'demo' }] },
  }])
  store.settingsData.theme = 'edited'
  await nextTick()
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 0)
  store.importExternalProvider('demo')
  await nextTick()
  t.mock.timers.tick(800)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].payload.library.providers.demo.config.baseUrl, 'https://external.example')
  requests[0].finish()
  await nextTurn()
  assert.equal(store.dirty, false)
})

test('明确保留本地配置时，即使编辑值未变也会同步启用投影', async (t) => {
  const { store, requests } = await fixture(t, [{ kind: 'external-removed', name: 'demo', modelCount: 1 }])
  assert.equal(store.dirty, false)
  store.keepLocalProvider('demo')
  assert.equal(store.dirty, true)
  await nextTick()
  t.mock.timers.tick(800)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].payload.library.providers.demo.enabled, true)
  requests[0].finish()
  await nextTurn()
  assert.equal(store.dirty, false)
})

test('重新加载后到达的旧保存响应不会覆盖新页面，新编辑仍会自动保存', async (t) => {
  const { store, requests } = await fixture(t)
  store.settingsData.theme = 'old-request'
  const saving = store.flushAutoSave()
  await store.reload()
  store.settingsData.theme = 'after-reload'
  await nextTick()
  requests[0].finish()
  await saving
  assert.equal(store.settingsData.theme, 'after-reload')
  assert.equal(store.dirty, true)
  t.mock.timers.tick(800)
  assert.equal(requests.length, 2)
  requests[1].finish()
  await nextTurn()
})

test('销毁 store 会取消尚未触发的自动保存', async (t) => {
  const { store, requests } = await fixture(t)
  store.settingsData.theme = 'edited'
  await nextTick()
  store.$dispose()
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 0)
})

test('销毁 store 后迟到的保存响应不会再次启动自动保存', async (t) => {
  const { store, requests } = await fixture(t)
  store.settingsData.theme = 'submitted'
  const saving = store.flushAutoSave()
  store.settingsData.theme = 'later-edit'
  store.$dispose()
  requests[0].finish()
  await saving
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 1)
})

for (const newName of ['demo', 'renamed']) {
  test(`Provider 整包移除默认模型时清理默认项（保存为 ${newName}）`, async (t) => {
    const { store, requests } = await fixture(t)
    store.setDefaultModel('demo', 'demo')
    store.updateProvider('demo', newName, { models: [{ id: 'remaining' }] })
    assert.equal(store.settingsData.defaultProvider, newName)
    assert.equal(store.settingsData.defaultModel, undefined)
    const saving = store.flushAutoSave()
    assert.equal(requests[0].payload.settings.defaultModel, undefined)
    assert.deepEqual(requests[0].payload.library.providers[newName].config.models, [{ id: 'remaining' }])
    requests[0].finish()
    await saving
    assert.equal(store.dirty, false)
  })
}

test('保留模型、修改其他 Provider 或引用内置模型时不清理默认项', async (t) => {
  const { store } = await fixture(t)
  store.setDefaultModel('demo', 'demo')
  store.updateProvider('demo', 'demo', { models: [{ id: 'demo', name: 'edited' }] })
  assert.equal(store.settingsData.defaultModel, 'demo')
  store.setDefaultModel('demo', 'builtin-not-in-local-list')
  store.updateProvider('demo', 'renamed', {})
  assert.equal(store.settingsData.defaultProvider, 'renamed')
  assert.equal(store.settingsData.defaultModel, 'builtin-not-in-local-list')
  store.setDefaultModel('different-provider', 'demo')
  store.updateProvider('renamed', 'renamed', {})
  assert.equal(store.settingsData.defaultProvider, 'different-provider')
  assert.equal(store.settingsData.defaultModel, 'demo')
})

test('Provider 重命名冲突时原模型和默认项均保持不变', async (t) => {
  const { store } = await fixture(t)
  store.addProvider('existing', {})
  store.setDefaultModel('demo', 'demo')
  assert.throws(() => store.updateProvider('demo', 'existing', {}), /同名 provider/)
  assert.equal(store.settingsData.defaultProvider, 'demo')
  assert.equal(store.settingsData.defaultModel, 'demo')
  assert.equal(store.library.providers.demo.config.models[0].id, 'demo')
})
