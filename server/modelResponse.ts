import type { PiApi } from '../src/types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function responseError(data: unknown): string | undefined {
  if (!isRecord(data) || !data.error) return undefined
  if (typeof data.error === 'string') return data.error
  if (isRecord(data.error) && typeof data.error.message === 'string') return data.error.message
  return '网关返回错误响应'
}

function textBlocks(value: unknown): string {
  if (!Array.isArray(value) || value.some((block) => !isRecord(block))) throw new Error('响应内容不是有效的内容块数组')
  return value.map((block: Record<string, unknown>) => {
    if (block.text !== undefined && typeof block.text !== 'string') throw new Error('响应中的文本字段不是字符串')
    return typeof block.text === 'string' ? block.text : ''
  }).join('')
}

function checkFinishReason(api: PiApi, reason: unknown): boolean {
  if (reason === undefined || reason === null || reason === '') return false
  const allowed = api === 'google-generative-ai' ? ['STOP', 'MAX_TOKENS']
    : api === 'anthropic-messages' ? ['end_turn', 'max_tokens', 'tool_use', 'pause_turn', 'stop_sequence']
    : ['stop', 'end', 'length', 'function_call', 'tool_calls']
  if (typeof reason !== 'string' || !allowed.includes(reason)) throw new Error(`模型异常结束：${String(reason)}`)
  return true
}

// HTTP 成功不足以证明对话成功：必须存在所选协议的响应结构，并识别 200 状态中的错误。
function jsonReply(api: PiApi, data: unknown): string {
  if (!isRecord(data)) throw new Error('响应不是有效的 JSON 对象')
  const error = responseError(data)
  if (error) throw new Error(error)
  if (api === 'anthropic-messages' && Array.isArray(data.content)) {
    checkFinishReason(api, data.stop_reason)
    return textBlocks(data.content)
  }
  if (api === 'openai-responses' && Array.isArray(data.output)) {
    if (data.status === 'failed' || data.status === 'cancelled') throw new Error(`模型响应状态：${data.status}`)
    if (data.status !== undefined && data.status !== 'completed' && data.status !== 'incomplete') throw new Error('Responses 对话尚未完成')
    if (data.status === 'incomplete' && isRecord(data.incomplete_details) && data.incomplete_details.reason !== 'max_output_tokens') {
      throw new Error(`模型响应未完成：${String(data.incomplete_details.reason)}`)
    }
    return data.output.map((item: unknown) => {
      if (!isRecord(item)) throw new Error('Responses 输出条目不是对象')
      return item.content === undefined ? '' : textBlocks(item.content)
    }).join('')
  }
  if (api === 'google-generative-ai' && Array.isArray(data.candidates) && isRecord(data.candidates[0])) {
    const candidate = data.candidates[0]
    checkFinishReason(api, candidate.finishReason)
    if (isRecord(candidate.content)) return textBlocks(candidate.content.parts)
  }
  if (api === 'openai-completions' && Array.isArray(data.choices) && isRecord(data.choices[0])) {
    const choice = data.choices[0]
    checkFinishReason(api, choice.finish_reason)
    if (isRecord(choice.message)) {
      if (typeof choice.message.content === 'string') return choice.message.content
      if (choice.message.content === null && (Array.isArray(choice.message.tool_calls) || typeof choice.message.reasoning_content === 'string')) return ''
    }
  }
  throw new Error(`响应不符合 ${api} 对话格式`)
}

export function readModelResponse(api: PiApi, text: string, stream: boolean, compat: Record<string, unknown>): string {
  const source = text.replace(/^\uFEFF/, '').trim()
  if (!source) throw new Error('网关返回空响应')
  if (!stream || source.startsWith('{') || source.startsWith('[')) {
    let data: unknown
    try { data = JSON.parse(source) }
    catch { throw new Error('网关返回的内容不是有效 JSON，可能是 HTML 页面或不完整响应') }
    const error = responseError(data)
    if (error) throw new Error(error)
    if (stream) throw new Error('请求了流式对话，但网关返回普通 JSON；可切换普通对话测试排查')
    return jsonReply(api, data)
  }

  let reply = ''
  let seenResponse = false
  let finished = false
  let done = false
  // SSE 的 data 可跨行，空行分隔事件；注释/心跳不能被当成对话成功。
  for (const frame of source.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const lines = frame.split('\n').filter((line) => line.startsWith('data:'))
    if (!lines.length) continue
    const payload = lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n')
    if (!payload.trim()) continue
    if (payload.trim() === '[DONE]') {
      done = true
      continue
    }
    let data: unknown
    try { data = JSON.parse(payload) }
    catch { throw new Error('流式事件包含无效 JSON，响应可能已被截断') }
    if (!isRecord(data)) throw new Error('流式事件不是 JSON 对象')
    const error = responseError(data)
    if (error) throw new Error(error)

    if (api === 'openai-completions' && Array.isArray(data.choices)) {
      const choice: unknown = data.choices[0]
      // choices 为空的用量统计事件合法，但它本身不能证明模型曾返回对话。
      if (isRecord(choice) && isRecord(choice.delta)) {
        seenResponse = true
        if (choice.delta.content !== undefined && choice.delta.content !== null && typeof choice.delta.content !== 'string') {
          throw new Error('流式文本增量不是字符串')
        }
        reply += typeof choice.delta.content === 'string' ? choice.delta.content : ''
        finished = checkFinishReason(api, choice.finish_reason) || finished
      }
    } else if (api === 'openai-responses') {
      if (data.type === 'response.failed' || data.type === 'error') {
        throw new Error(responseError(data.response) ?? (typeof data.message === 'string' ? data.message : 'Responses 流返回错误'))
      }
      if (data.type === 'response.output_text.delta') {
        if (typeof data.delta !== 'string') throw new Error('Responses 文本增量不是字符串')
        seenResponse = true
        reply += data.delta
      }
      if (data.type === 'response.completed' || data.type === 'response.incomplete') {
        const finalReply = jsonReply(api, data.response)
        reply = finalReply || reply
        seenResponse = true
        finished = true
      }
    } else if (api === 'anthropic-messages') {
      if (data.type === 'message_start') {
        reply += jsonReply(api, data.message)
        seenResponse = true
      } else if (data.type === 'content_block_start' && isRecord(data.content_block)) {
        reply += textBlocks([data.content_block])
      } else if (data.type === 'content_block_delta' && isRecord(data.delta) && data.delta.type === 'text_delta') {
        if (typeof data.delta.text !== 'string') throw new Error('Anthropic 文本增量不是字符串')
        reply += data.delta.text
      } else if (data.type === 'message_delta' && isRecord(data.delta)) {
        checkFinishReason(api, data.delta.stop_reason)
      } else if (data.type === 'message_stop') {
        finished = true
      }
    } else if (api === 'google-generative-ai' && Array.isArray(data.candidates) && isRecord(data.candidates[0])) {
      const candidate = data.candidates[0]
      if (isRecord(candidate.content)) {
        reply += textBlocks(candidate.content.parts)
        seenResponse = true
      }
      finished = checkFinishReason(api, candidate.finishReason) || finished
    }
  }
  if (!seenResponse) throw new Error(`未收到有效的 ${api} 流式对话事件`)
  // 只有显式声明不返回 finish_reason 的 Chat 网关，才允许用 [DONE] 作为终止依据。
  if (!finished && !(api === 'openai-completions' && compat.supportsFinishReason === false && done)) {
    throw new Error('流式响应提前结束：未收到协议要求的结束事件或结束原因')
  }
  return reply
}
