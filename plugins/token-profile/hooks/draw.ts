import type { Report, View } from '../types'

const DAY_MS = 86_400_000
export const FONT = `-apple-system, 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK TC', sans-serif`
const MUTED = '#8a8a86'
const GRID = '#8a8a8633'
const LINE = '#d97757'
// Brighter is more on a dark surface, darker is more on a light one.
const LEVELS = ['#8a8a8626', '#5e3224', '#964c35', '#d97757', '#f2b8a2']
const LIGHT_LEVELS = ['#8a8a8626', '#f7dcd1', '#eeb39e', '#d97757', '#a8492c']
const LEVEL_STYLE = `<style>@media (prefers-color-scheme: light) {${LIGHT_LEVELS.map(
  (color, level) => `.l${level}{fill:${color}}`,
).join('')}}</style>`

const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const weekStart = (ms: number) => ms - new Date(ms).getUTCDay() * DAY_MS
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value))

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const formatTokens = (tokens: number) => {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B`
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}K`
  return String(tokens)
}

export const formatDuration = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
  `viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="11" fill="${MUTED}">` +
  `${LEVEL_STYLE}${body}</svg>`

const label = (x: number, y: number, text: string, anchor = 'start') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}">${escapeXml(text)}</text>`

const shortDay = (day: string) => {
  const [, month, date] = day.split('-').map(Number)
  return `${month}月${date}日`
}

const CARD = { width: 116, height: 44, gap: 8 }
const CARD_STYLE =
  `.card{display:none;pointer-events:none}` +
  `.card rect{fill:#2b2a27;stroke:#ffffff26}` +
  `.card text{fill:#f5f4ef;font-size:12px}` +
  `.card text+text{fill:#c9c7bf}` +
  `.card line{stroke:#8a8a8680}`

/**
 * Hover cards in pure CSS, since the sandboxed frame runs no script. Each mark
 * carries an id and its card comes after every mark, so `#h1:hover~#c1` shows
 * it above the chart. A card sits right of its mark, or left at the chart's edge.
 */
const hoverCards = (chartWidth: number, chartHeight: number) => {
  const cards: string[] = []
  const rules: string[] = []

  return {
    add: (
      mark: { left: number; right: number; y: number },
      title: string,
      value: string,
      extra = '',
    ) => {
      const id = cards.length
      const fits = mark.right + CARD.gap + CARD.width <= chartWidth
      const x = fits ? mark.right + CARD.gap : mark.left - CARD.gap - CARD.width
      const y = clamp(mark.y - 12, 0, chartHeight - CARD.height - 1)
      rules.push(`#h${id}:hover~#c${id}{display:inline}`)
      cards.push(
        `<g id="c${id}" class="card">${extra}` +
          `<rect x="${x}" y="${y}" width="${CARD.width}" height="${CARD.height}" rx="9"/>` +
          `<text x="${x + 11}" y="${y + 18}">${title}</text>` +
          `<text x="${x + 11}" y="${y + 35}">${value}</text></g>`,
      )
      return `h${id}`
    },
    draw: () => `<style>${CARD_STYLE}${rules.join('')}</style>${cards.join('')}`,
  }
}

/** Quartiles of the days in use, so one huge day does not wash out the rest. */
const levelOf = (days: Record<string, number>) => {
  const used = Object.values(days)
    .filter(tokens => tokens > 0)
    .sort((a, b) => a - b)
  const at = (share: number) => used[Math.floor((used.length - 1) * share)] ?? 0
  const cuts = [at(0.25), at(0.5), at(0.75)]

  return (tokens: number) =>
    tokens <= 0 ? 0 : 1 + cuts.filter(cut => tokens > cut).length
}

const heatmap = (report: Report, width: number) => {
  const pitch = 14
  const cell = 11
  const left = 22
  const weeks = clamp(Math.floor((width - left) / pitch), 8, 53)
  const today = toMs(report.today)
  const first = weekStart(today) - (weeks - 1) * 7 * DAY_MS
  const level = levelOf(report.days)
  const legendY = 7 * pitch + 26
  const chartWidth = left + weeks * pitch
  const chartHeight = legendY + cell + 2
  const cards = hoverCards(chartWidth, chartHeight)
  const parts: string[] = []
  let lastLabelAt = -4
  let lastMonth = -1

  for (let week = 0; week < weeks; week++) {
    const x = left + week * pitch
    const month = new Date(first + week * 7 * DAY_MS).getUTCMonth()
    if (month !== lastMonth && week - lastLabelAt >= 3) {
      const atEdge = week >= weeks - 2
      parts.push(
        label(atEdge ? x + cell : x, 7 * pitch + 14, `${month + 1}月`, atEdge ? 'end' : 'start'),
      )
      lastLabelAt = week
    }
    lastMonth = month

    for (let weekday = 0; weekday < 7; weekday++) {
      const ms = first + (week * 7 + weekday) * DAY_MS
      if (ms > today) continue
      const day = toDay(ms)
      const tokens = report.days[day] ?? 0
      const step = level(tokens)
      const y = weekday * pitch
      const id = cards.add(
        { left: x, right: x + cell, y },
        shortDay(day),
        `${formatTokens(tokens)} tokens`,
      )
      parts.push(
        `<rect id="${id}" class="l${step}" x="${x}" y="${y}" width="${cell}" ` +
          `height="${cell}" rx="2" fill="${LEVELS[step]}"/>`,
      )
    }
  }

  ;['一', '三', '五'].forEach((name, index) => {
    parts.push(label(0, (index * 2 + 1) * pitch + 10, name))
  })

  const legendX = chartWidth - 3 - 5 * pitch - 14
  parts.push(label(legendX - 6, legendY + 10, '少', 'end'))
  LEVELS.forEach((color, step) => {
    parts.push(
      `<rect class="l${step}" x="${legendX + step * pitch}" y="${legendY}" ` +
        `width="${cell}" height="${cell}" rx="2" fill="${color}"/>`,
    )
  })
  parts.push(label(legendX + 5 * pitch + 3, legendY + 10, '多'))

  return svg(chartWidth, chartHeight, parts.join('') + cards.draw())
}

/** The next 1, 2 or 5 step above `value`, so the top gridline reads cleanly. */
const niceMax = (value: number) => {
  const power = 10 ** Math.floor(Math.log10(Math.max(value, 1)))
  const step = [1, 2, 5, 10].find(mult => mult * power >= value) ?? 10
  return step * power
}

const PLOT = { top: 16, bottom: 22, left: 46, right: 12, height: 170 }

const axis = (width: number, top: number) => {
  const baseline = PLOT.top + PLOT.height
  return [0, 0.5, 1]
    .map(share => {
      const y = baseline - share * PLOT.height
      return (
        `<line x1="${PLOT.left}" x2="${width - PLOT.right}" y1="${y}" y2="${y}" ` +
        `stroke="${GRID}"/>` +
        label(PLOT.left - 6, y + 4, formatTokens(top * share), 'end')
      )
    })
    .join('')
}

const weekly = (report: Report, width: number) => {
  const totals = new Map<number, number>()
  for (const [day, tokens] of Object.entries(report.days)) {
    const week = weekStart(toMs(day))
    totals.set(week, (totals.get(week) ?? 0) + tokens)
  }

  const plotWidth = width - PLOT.left - PLOT.right
  const count = clamp(Math.floor(plotWidth / 18), 8, 26)
  const lastWeek = weekStart(toMs(report.today))
  const top = niceMax(Math.max(...totals.values(), 1))
  const slot = plotWidth / count
  const barWidth = Math.max(4, Math.min(16, slot - 2))
  const baseline = PLOT.top + PLOT.height
  const cards = hoverCards(width, baseline + PLOT.bottom)
  const parts = [axis(width, top)]
  let lastLabelAt = -3
  let lastMonth = -1

  for (let index = 0; index < count; index++) {
    const week = lastWeek - (count - 1 - index) * 7 * DAY_MS
    const tokens = totals.get(week) ?? 0
    const x = PLOT.left + index * slot + (slot - barWidth) / 2
    const month = new Date(week).getUTCMonth()
    if (month !== lastMonth && index - lastLabelAt >= 3 && index < count - 1) {
      parts.push(label(x, baseline + 16, `${month + 1}月`))
      lastLabelAt = index
    }
    lastMonth = month
    const height = (tokens / top) * PLOT.height
    if (height > 0) {
      const radius = Math.min(4, barWidth / 2, height)
      parts.push(
        `<path fill="${LINE}" d="M${x} ${baseline}v${-(height - radius)}` +
          `q0 ${-radius} ${radius} ${-radius}h${barWidth - 2 * radius}` +
          `q${radius} 0 ${radius} ${radius}v${height - radius}z"/>`,
      )
    }
    const id = cards.add(
      { left: x, right: x + barWidth, y: baseline - height },
      `${shortDay(toDay(week))}當週`,
      `${formatTokens(tokens)} tokens`,
    )
    parts.push(
      `<rect id="${id}" x="${PLOT.left + index * slot}" y="${PLOT.top}" width="${slot}" ` +
        `height="${PLOT.height}" fill="transparent"/>`,
    )
  }

  return svg(width, baseline + PLOT.bottom, parts.join('') + cards.draw())
}

const cumulative = (report: Report, width: number) => {
  const firstMs = toMs(report.firstDay ?? report.today)
  const count = Math.round((toMs(report.today) - firstMs) / DAY_MS) + 1
  const plotWidth = width - PLOT.left - PLOT.right
  const top = niceMax(report.lifetime)
  const baseline = PLOT.top + PLOT.height
  const xOf = (index: number) =>
    PLOT.left + (count > 1 ? (index / (count - 1)) * plotWidth : plotWidth / 2)
  const yOf = (tokens: number) => baseline - (tokens / top) * PLOT.height
  const cards = hoverCards(width, baseline + PLOT.bottom)
  const parts = [axis(width, top)]
  const points: string[] = []
  const hits: string[] = []
  // Keeps a long history inside what an Svg may hold.
  const every = Math.ceil(count / 200)
  const slot = (plotWidth / Math.max(count - 1, 1)) * every
  let running = 0

  for (let index = 0; index < count; index++) {
    const day = toDay(firstMs + index * DAY_MS)
    running += report.days[day] ?? 0
    const x = xOf(index)
    const y = yOf(running)
    if (index % every !== 0 && index !== count - 1) continue
    points.push(`${x},${y}`)
    const id = cards.add(
      { left: x, right: x, y },
      shortDay(day),
      `累計 ${formatTokens(running)}`,
      `<line x1="${x}" x2="${x}" y1="${PLOT.top}" y2="${baseline}"/>`,
    )
    hits.push(
      `<rect id="${id}" x="${x - slot / 2}" y="${PLOT.top}" width="${slot}" ` +
        `height="${PLOT.height}" fill="transparent"/>`,
    )
  }

  const line = points.join(' ')
  const endX = xOf(count - 1)
  const endY = yOf(running)
  parts.unshift(
    `<polygon fill="${LINE}" fill-opacity="0.15" ` +
      `points="${xOf(0)},${baseline} ${line} ${endX},${baseline}"/>`,
    `<polyline fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round" ` +
      `points="${line}"/>`,
  )
  parts.push(
    `<circle cx="${endX}" cy="${endY}" r="4" fill="${LINE}"/>`,
    label(endX, endY - 9, formatTokens(running), 'end'),
    label(PLOT.left, baseline + 16, report.firstDay ?? report.today),
    label(width - PLOT.right, baseline + 16, report.today, 'end'),
    ...hits,
  )

  return svg(width, baseline + PLOT.bottom, parts.join('') + cards.draw())
}

export const chartSvg = (report: Report, view: View, width: number) => {
  if (view === 'weekly') return weekly(report, width)
  if (view === 'cumulative') return cumulative(report, width)
  return heatmap(report, width)
}

export const chartAlt = (report: Report, view: View) => {
  const names = { daily: '每日', weekly: '每週', cumulative: '累計' }
  return `${names[view]} token 用量圖，累計 ${formatTokens(report.lifetime)}，單日最高 ${formatTokens(report.peak.tokens)}`
}
