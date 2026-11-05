import { expect, mock, test } from 'claude-code/testing'

import { chartSvg } from '../hooks/draw'

const PANE = {
  plugin: 'token-profile',
  component: 'Pane',
  requestId: 'token-profile',
  props: {
    title: 'Token 用量',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const REPORT = {
  name: '範例使用者',
  avatar: null,
  today: '2026-11-05',
  firstDay: '2026-11-02',
  lifetime: 1_000_000_000,
  parts: { input: 1, output: 2, cacheWrite: 3, cacheRead: 999_999_994 },
  peak: { day: '2026-11-03', tokens: 600_000_000 },
  longestTask: { ms: 5_400_000, project: 'my-project' },
  longestStreak: 4,
  currentStreak: 2,
  days: { '2026-11-03': 600_000_000, '2026-11-05': 400_000_000 },
  models: [{ name: 'claude-opus-5-5', tokens: 1_000_000_000 }],
  projects: [{ name: 'my-project', tokens: 1_000_000_000 }],
  machines: [{ name: 'laptop', tokens: 1_000_000_000 }],
  syncError: null,
  dataDir: '/shared',
}

const start = async (
  $: any,
  on: any,
  stdout: string,
  exitCode = 0,
  missing: string[] = [],
  files: Record<string, string> = {},
) => {
  const clock = mock.clock(on)
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 7, isLink: false } }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[e.path]! }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'token-profile' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    if (missing.includes(e.argv[0]!)) throw new Error('cannot start')
    return { value: { exitCode, stdout, stderr: 'boom' } }
  })
  on('command.run', () => ({ text: '' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'token-profile', args: '' })
  return clock
}

test('the page shows the headline numbers on every surface', async ($, on) => {
  await start($, on, JSON.stringify(REPORT))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^1\.0B$/ }))?.text).toBe('1.0B')
    expect((await ui.find({ type: 'Text', text: /^600\.0M$/ }))?.text).toBe('600.0M')
    expect((await ui.find({ type: 'Text', text: /^1h 30m$/ }))?.text).toBe('1h 30m')
    await ui.unmount()
  }
})

test('the command answers in text for clients that draw no page', async ($, on) => {
  await start($, on, JSON.stringify(REPORT))

  const { text } = await $.command.run({ command: 'token-profile', args: '' })
  expect(text).toContain('今日 400.0M · 累計 1.0B · 連續 2 天')
  expect(text).toContain('連線畫面：desktop')
})

test('a failed scan says so instead of drawing numbers', async ($, on) => {
  await start($, on, '', 1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /讀取用量失敗/ })
  expect(line?.text).toContain('boom')
  await ui.unmount()
})

test('Python under another name still runs the scan', async ($, on) => {
  await start($, on, JSON.stringify(REPORT), 0, ['python3', 'python'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^1\.0B$/ }))?.text).toBe('1.0B')
  await ui.unmount()
})

test('no Python at all says how to fix it', async ($, on) => {
  await start($, on, '', 0, ['python3', 'python', 'py'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /請先安裝 Python/ })
  expect(line?.text).toContain('請先安裝 Python')
  await ui.unmount()
})

test('a second computer gets its own row, and a failed sync says so', async ($, on) => {
  const synced = {
    ...REPORT,
    machines: [
      { name: 'laptop', tokens: 900_000_000 },
      { name: 'desktop', tokens: 100_000_000 },
    ],
    syncError: 'push rejected',
  }
  await start($, on, JSON.stringify(synced))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^desktop$/ }))?.text).toBe('desktop')
  expect((await ui.find({ type: 'Text', text: /2 台電腦/ }))?.text).toContain('2 台電腦')
  expect((await ui.find({ type: 'Text', text: /同步失敗/ }))?.text).toContain('push rejected')
  await ui.unmount()
})

test('every conversation follows the same numbers and screen', async ($, on) => {
  const files: Record<string, string> = {}
  const closed: string[] = []
  on('ui.close', (_: unknown, e: { id: string }) => {
    closed.push(e.id)
    return { value: undefined }
  })
  const clock = await start($, on, JSON.stringify(REPORT), 0, [], files)

  // Opening the page here told the other conversations.
  expect(JSON.parse(files['/shared/ui.json']!)).toEqual({ view: 'daily', isOpen: true })

  const page = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await page.press({ key: 'weekly' })
  expect(JSON.parse(files['/shared/ui.json']!).view).toBe('weekly')
  await page.unmount()

  // Another conversation closed the page and counted more tokens.
  files['/shared/ui.json'] = JSON.stringify({ view: 'cumulative', isOpen: false })
  files['/shared/report.json'] = JSON.stringify({ ...REPORT, lifetime: 2_000_000_000 })
  await clock.advance(5_000)

  expect(closed).toEqual(['token-profile'])
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^2\.0B$/ }))?.text).toBe('2.0B')
  expect((await band.find({ type: 'Text', text: /查看/ }))?.text).toContain('查看')
  await band.unmount()
})

const BAND = {
  plugin: 'token-profile',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 70, scroll: { offset: 0, bodyRows: 5 } },
} as const

test('the entry shows today and closes an open page', async ($, on) => {
  const closed: string[] = []
  on('ui.close', (_: unknown, e: { id: string }) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await start($, on, JSON.stringify(REPORT))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^400\.0M$/ }))?.text).toBe('400.0M')
  expect((await ui.find({ type: 'Text', text: /收起/ }))?.text).toContain('收起')

  await ui.press({ key: 'token-entry' })
  expect(closed).toEqual(['token-profile'])
  expect((await ui.find({ type: 'Text', text: /查看/ }))?.text).toContain('查看')
  await ui.unmount()
})

test('every chart fits what an Svg may hold, hover cards included', () => {
  const longHistory = { ...REPORT, firstDay: '2023-11-05' }

  for (const view of ['daily', 'weekly', 'cumulative'] as const) {
    const source = chartSvg(longHistory, view, 760)
    expect(source.length).toBeLessThan(131_072)
    expect(source).toContain('#h0:hover~#c0{display:inline}')
  }
})
