import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ranked, Report, SharedScreen, View } from '../types'
import { FONT, chartAlt, chartSvg, formatDuration, formatTokens } from './draw'

const PANE = 'token-profile'
const TITLE = 'Token 用量'
const VIEWS: { view: View; label: string }[] = [
  { view: 'daily', label: '每日' },
  { view: 'weekly', label: '每週' },
  { view: 'cumulative', label: '累計' },
]

const report = atom({ plugin: 'token-profile', key: 'report' } as const, null, {
  shape: 'report-5',
})
const view = atom({ plugin: 'token-profile', key: 'view' } as const, 'daily', {
  shape: 'view-1',
})
const error = atom({ plugin: 'token-profile', key: 'error' } as const, null, {
  shape: 'error-1',
})

const isOpen = atom({ plugin: 'token-profile', key: 'isOpen' } as const, false, {
  shape: 'open-1',
})

// Each system names Python differently, so none is assumed.
const PYTHONS = [['python3'], ['python'], ['py', '-3']]

const collect = async ($: EngineInterface) => {
  const script = `${$.plugin.root}/scripts/collect.py`
  let failure = '找不到 Python，請先安裝 Python 3。'
  for (const python of PYTHONS) {
    try {
      const ran = await $.process.run([...python, script], { timeoutMs: 120_000 })
      if (ran.exitCode === 0) return ran.stdout
      failure = ran.stderr.trim().split('\n').pop() || failure
    } catch {
      continue // not installed under this name
    }
  }
  throw new Error(failure)
}

const FOLLOW_EVERY_MS = 5_000

// Rebuilt by session.start after a reload, so neither needs $.state.
let dataDir: string | undefined
let followedReportAt = 0
let isFollowing = false

const refresh = async ($: EngineInterface) => {
  try {
    const next = JSON.parse(await collect($)) as Report
    dataDir = next.dataDir
    await update($, report, () => next)
    await update($, error, () => null)
  } catch (failure) {
    await update($, error, () => String(failure))
  }
}

const shareScreen = async ($: EngineInterface) => {
  if (!dataDir) return
  const screen: SharedScreen = { view: await read($, view), isOpen: await read($, isOpen) }
  await $.fs.write(`${dataDir}/ui.json`, JSON.stringify(screen))
}

const showPage = async ($: EngineInterface) => {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isOpen, () => true)

  return opened
}

const hidePage = async ($: EngineInterface) => {
  await $.ui.close({ id: PANE })
  await update($, isOpen, () => false)
}

const openPage = async ($: EngineInterface) => {
  const opened = await showPage($)
  await shareScreen($)
  await refresh($)

  return opened
}

const closePage = async ($: EngineInterface) => {
  await hidePage($)
  await shareScreen($)
}

const chooseView = async ($: EngineInterface, chosen: View) => {
  await update($, view, () => chosen)
  await shareScreen($)
}

// Every conversation follows the same two files, so none shows its own numbers.
const follow = async ($: EngineInterface) => {
  if (!dataDir) return
  const reportFile = `${dataDir}/report.json`
  const screenFile = `${dataDir}/ui.json`

  if (await $.fs.exists(reportFile)) {
    const { mtimeMs } = await $.fs.stat(reportFile)
    if (mtimeMs !== followedReportAt) {
      followedReportAt = mtimeMs
      const next = JSON.parse(await $.fs.read(reportFile)) as Report
      await update($, report, () => next)
    }
  }

  if (await $.fs.exists(screenFile)) {
    const screen = JSON.parse(await $.fs.read(screenFile)) as SharedScreen
    if (screen.view !== (await read($, view))) await update($, view, () => screen.view)
    if (screen.isOpen !== (await read($, isOpen))) {
      await (screen.isOpen ? showPage($) : hidePage($))
    }
  }
}

const followQuietly = async ($: EngineInterface) => {
  try {
    await follow($)
  } catch {
    // A file another conversation is replacing; the next tick reads it.
  }
}

const avatarSvg = ({ avatar, name }: Report) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
  (avatar
    ? `<clipPath id="round"><circle cx="36" cy="36" r="36"/></clipPath>` +
      `<image href="data:image/webp;base64,${avatar}" width="72" height="72" ` +
      `clip-path="url(#round)"/>`
    : `<circle cx="36" cy="36" r="36" fill="#d97757"/>` +
      `<text x="36" y="47" text-anchor="middle" font-size="30" fill="#fff" ` +
      `font-family="${FONT}">${name.slice(0, 1)}</text>`) +
  `</svg>`

const percent = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-profile',
      description: '開啟 Token 用量頁面',
    })
    void refresh($).then(() => followQuietly($))
    if (!isFollowing) {
      isFollowing = true
      $.clock.every(FOLLOW_EVERY_MS, () => void followQuietly($))
    }

    return next(e)
  })

  on('command.run', { command: 'token-profile' }, async $ => {
    const opened = await openPage($)
    const data = await read($, report)
    const surfaces = await $.session.surfaces()
    // Text reaches every client, including one that draws no plugin page.
    const usage = data
      ? `今日 ${formatTokens(data.days[data.today] ?? 0)} · ` +
        `累計 ${formatTokens(data.lifetime)} · 連續 ${data.currentStreak} 天`
      : '還沒有用量資料。'
    const page = opened.isPlaced ? '頁面已開啟。' : `頁面無法顯示：${opened.reason}`

    return { text: `${usage}\n${page}\n連線畫面：${surfaces.join('、') || '無'}` }
  })

  // Keeps the entry and an open page current without a press.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)

    return done
  })

  // The pane's own close mark closes it everywhere; a session ending does not.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, isOpen, () => false)
      await shareScreen($)
    }

    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, report)
    if (!data || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, isOpen)
    const today = data.days[data.today] ?? 0

    return (
      <Box>
        <Button
          key="token-entry"
          plain
          onPress={() => void (shown ? closePage($) : openPage($))}
        >
          <Text color="#d97757">● </Text>
          <Text dimColor>今日 </Text>
          <Text weight="medium">{formatTokens(today)}</Text>
          <Text dimColor> · 累計 </Text>
          <Text weight="medium">{formatTokens(data.lifetime)}</Text>
          <Text dimColor>
            {' '}
            · 連續 {data.currentStreak} 天 · {shown ? '收起' : '查看'} ›
          </Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const data = await read($, report)
    const shown = await read($, view)
    const failure = await read($, error)

    if (!data) {
      return failure ? (
        <Text color="error">讀取用量失敗：{failure}</Text>
      ) : (
        <Text dimColor>正在統計用量…</Text>
      )
    }

    const stat = (value: string, name: string) => (
      <Box flexDirection="column" alignItems="center" minWidth={13} paddingY={1}>
        <Text weight="semibold" tabular>
          {value}
        </Text>
        <Text dimColor size="caption">
          {name}
        </Text>
      </Box>
    )
    const row = (name: string, value: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>{name}</Text>
        <Text dimColor tabular>
          {value}
        </Text>
      </Box>
    )
    const ranked = (heading: string, rows: Ranked[]) => (
      <Box flexDirection="column" marginTop={1}>
        <Text weight="semibold">{heading}</Text>
        {rows.map(one =>
          row(
            one.name,
            `${formatTokens(one.tokens)} · ${percent(one.tokens, data.lifetime)}`,
          ),
        )}
      </Box>
    )
    const { input, output, cacheWrite, cacheRead } = data.parts
    const width = Math.min(760, Math.max(320, e.props.bodyColumns * 8))

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          {'Svg' in ui && (
            <ui.Svg source={avatarSvg(data)} alt={data.name} width={72} height={72} />
          )}
          <Text size="title" weight="bold">
            {data.name}
          </Text>
          <Text dimColor size="footnote">
            Claude Code · 自 {data.firstDay ?? data.today} 起
          </Text>
        </Box>

        <Box
          flexDirection="row"
          flexWrap="wrap"
          justifyContent="space-around"
          borderStyle="round"
          borderDimColor
        >
          {stat(formatTokens(data.lifetime), '累計 tokens')}
          {stat(formatTokens(data.peak.tokens), '單日最高')}
          {stat(formatDuration(data.longestTask.ms), '最長任務')}
          {stat(`${data.longestStreak} 天`, '最長連續')}
          {stat(`${data.currentStreak} 天`, '目前連續')}
        </Box>

        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          marginTop={1}
        >
          <Text weight="semibold">Token 活動</Text>
          <Box flexDirection="row" gap={1}>
            {VIEWS.map(one => (
              <Button
                key={one.view}
                plain
                dimColor={one.view !== shown}
                onPress={() => void chooseView($, one.view)}
              >
                {one.label}
              </Button>
            ))}
          </Box>
        </Box>

        {'Svg' in ui && (
          <ui.Svg
            source={chartSvg(data, shown, width)}
            alt={chartAlt(data, shown)}
            isInteractive
          />
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text weight="semibold">Token 組成</Text>
          {row('讀取快取', `${formatTokens(cacheRead)} · ${percent(cacheRead, data.lifetime)}`)}
          {row('寫入快取', `${formatTokens(cacheWrite)} · ${percent(cacheWrite, data.lifetime)}`)}
          {row('輸出', `${formatTokens(output)} · ${percent(output, data.lifetime)}`)}
          {row('輸入', `${formatTokens(input)} · ${percent(input, data.lifetime)}`)}
        </Box>
        {ranked('模型', data.models)}
        {ranked('專案', data.projects)}
        {data.machines.length > 1 && ranked('電腦', data.machines)}

        <Box marginTop={1}>
          <Text dimColor size="caption">
            統計{data.machines.length > 1 ? ` ${data.machines.length} 台電腦` : '這台電腦'}
            上的 Claude Code 紀錄，不含 claude.ai 網頁與手機聊天。
          </Text>
        </Box>
        {failure && <Text color="error">更新失敗：{failure}</Text>}
        {data.syncError && <Text color="error">同步失敗：{data.syncError}</Text>}
        <Box marginTop={1}>
          <Button key="refresh" onPress={() => void refresh($)}>
            重新整理
          </Button>
        </Box>
      </Box>
    )
  })
}
