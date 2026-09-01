// 展示格式化工具

// token 数值压缩显示：1048576 → 1.05M，272000 → 272k，8000 → 8k
export function formatTokens(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  if (v >= 1_000_000) {
    const m = v / 1_000_000
    return `${trimFloat(m, 2)}M`
  }
  if (v >= 1_000) {
    return `${trimFloat(v / 1_000, 1)}k`
  }
  return String(v)
}

function trimFloat(n: number, digits: number): string {
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
}

// 成本显示：输入 / 输出每百万 token 的美元价
export function formatCost(c: { input?: number; output?: number } | undefined): string {
  if (!c) return '—'
  const parts: string[] = []
  if (c.input !== undefined) parts.push(`$${c.input}`)
  if (c.output !== undefined) parts.push(`$${c.output}`)
  return parts.length ? parts.join(' / ') : '—'
}
