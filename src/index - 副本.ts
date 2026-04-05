import { Context, h, Schema } from 'koishi'

export const name = 'vocabili'
export const inject = {
  optional: ['puppeteer'],
}

export interface Config {
  refreshToken?: string
  enableQQNativeMarkdown?: boolean
  enableQQInlineCmd?: boolean
  debugMode?: boolean
}

export const Config: Schema<Config> = Schema.object({
  refreshToken: Schema.string().role('secret').description('Vocabili API Refresh Token').default(''),
  enableQQNativeMarkdown: Schema.boolean().description('是否在 QQ 平台启用原生 Markdown 格式发送报告').default(false),
  enableQQInlineCmd: Schema.boolean().description('是否在 QQ 平台搜索结果中启用 mqqapi 快捷点击指令（仅在开启原生 Markdown 时生效）').default(false),
  debugMode: Schema.boolean().description('是否开启调试模式（在控制台输出 API 请求与响应日志）').default(false),
})

const API_BASE = 'https://api.vocabili.top'
const AUTH_REFRESH_URL = 'https://api.vocabili.top/v2/auth/refresh'
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000

let cachedAccessToken: string | null = null
let cachedTokenType = 'Bearer'
let accessTokenExpiresAt = 0
let cachedRefreshToken: string | null = null

interface PuppeteerElementHandle {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>
}

interface PuppeteerPage {
  setViewport(options: { width: number; height: number; deviceScaleFactor: number }): Promise<void>
  goto(url: string, options: { waitUntil: 'networkidle2'; timeout: number }): Promise<unknown>
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>
  evaluateOnNewDocument(pageFunction: (access: string, refresh: string) => void, accessToken: string, refreshToken: string): Promise<void>
  evaluate(pageFunction: () => void): Promise<unknown>
  $(selector: string): Promise<PuppeteerElementHandle | null>
  viewport(): { width: number; height: number } | null
  screenshot(options: {
    type: 'jpeg'
    quality: number
    clip: { x: number; y: number; width: number; height: number }
    captureBeyondViewport: boolean
  }): Promise<Buffer | Uint8Array>
  close(): Promise<void>
}

interface PuppeteerService {
  page(): Promise<PuppeteerPage>
}

declare module 'koishi' {
  interface Context {
    puppeteer?: PuppeteerService
  }
}

interface ConfigurableSnapshot {
  view: number
  favorite: number
  coin: number
  like: number
  danmaku: number
  reply: number
  share: number
  copyright: number
}

interface SnapshotApiItem {
  bvid: string
  date: string
  view: number | null
  favorite: number | null
  coin: number | null
  like: number | null
  danmaku: number | null
  reply: number | null
  share: number | null
}

interface SnapshotApiResponse {
  data: SnapshotApiItem[]
  total: number
}

interface AuthRefreshResponse {
  access_token: string
  token_type?: string
  expires_in: number
  refresh_token?: string
}

interface SongSearchVideo {
  bvid?: string
  disabled?: boolean
  uploader?: {
    name?: string
  }
}

interface SongSearchItem {
  name?: string
  display_name?: string | null
  videos?: SongSearchVideo[]
}

interface SongSearchApiResponse {
  data: SongSearchItem[]
  total: number
}

interface FixCoefficients {
  a: number
  b: number
  c: number
  d: number
}

interface RateCoefficients {
  view: number
  favorite: number
  coin: number
  like: number
  danmaku: number
  reply: number
  share: number
}

enum RankingType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

type NormalizedSnapshot = {
  dateText: string
  dateValue: Date
  stats: ConfigurableSnapshot
}

function ceil2(value: number): number {
  return Math.ceil(value * 100) / 100
}

function normalizeCopyright(copyright: number): 1 | 2 {
  return copyright === 1 || copyright === 3 || copyright === 101 ? 1 : 2
}

function adjustCoin(stats: ConfigurableSnapshot): number {
  if (stats.coin === 0 && stats.view > 0 && stats.favorite > 0 && stats.like > 0) {
    return 1
  }
  return stats.coin
}

function computeFixCoefficients(stats: ConfigurableSnapshot): FixCoefficients {
  const copyright = normalizeCopyright(stats.copyright)
  const coin = adjustCoin(stats)

  let fixA = 0
  if (coin <= 0) {
    fixA = 0
  } else if (copyright === 1) {
    fixA = 1
  } else {
    const denominator = 150 * coin + 50 * Math.max(0, stats.danmaku)
    if (denominator <= 0) {
      fixA = 1
    } else {
      fixA = ceil2(Math.max(1, (stats.view + 40 * stats.favorite + 10 * stats.like) / denominator))
    }
  }

  const denominatorB = stats.view + 20 * stats.favorite
  const fixB = denominatorB <= 0
    ? 0
    : ceil2(Math.min(1, (3 * Math.max(0, 20 * coin * fixA + 10 * stats.like)) / denominatorB))

  const denominatorC = stats.like + stats.favorite
  const fixC = denominatorC <= 0
    ? 0
    : ceil2(Math.min(1, (stats.like + stats.favorite + 20 * coin * fixA) / (2 * denominatorC)))

  let fixD = 0
  if (stats.reply <= 0) {
    fixD = 0
  } else {
    const base = Math.max(1, stats.favorite + stats.like)
    fixD = ceil2(Math.min(1, base / (base + 0.1 * stats.reply)) ** 20)
  }

  return { a: fixA, b: fixB, c: fixC, d: fixD }
}

function calcViewRateShort(stats: ConfigurableSnapshot, fix: FixCoefficients, coin: number): number {
  if (stats.view <= 0) return 0
  return Math.max(ceil2(Math.min((Math.max(fix.a * coin + stats.favorite, 0) * 10) / stats.view, 1)), 0)
}

function calcViewRateLong(stats: ConfigurableSnapshot, fix: FixCoefficients, coin: number): number {
  if (stats.view <= 0) return 0
  return Math.max(ceil2(Math.min((Math.max(fix.a * coin + stats.favorite, 0) * 15) / stats.view, 1)), 0)
}

function calcFavoriteRate(stats: ConfigurableSnapshot, fix: FixCoefficients, coin: number): number {
  if (stats.favorite <= 0) return 0
  const value = ((stats.favorite + 2 * fix.a * coin) * 10 / (stats.favorite * 10 + stats.view)) * 20
  return Math.max(ceil2(Math.min(value, 20)), 0)
}

function calcCoinRate(stats: ConfigurableSnapshot, fix: FixCoefficients, coin: number): number {
  const denominator = fix.a * coin * 40 + stats.view
  if (denominator <= 0) return 0
  const value = (fix.a * coin * 40) / (fix.a * coin * 20 + stats.view) * 40
  return Math.max(ceil2(Math.min(value, 40)), 0)
}

function calcLikeRate(stats: ConfigurableSnapshot, fix: FixCoefficients, coin: number): number {
  if (stats.like <= 0) return 0
  const value = (Math.max(fix.a * coin + stats.favorite, 0) / (stats.like * 20 + stats.view)) * 100
  return Math.max(ceil2(Math.min(5, value)), 0)
}

function calcDanmakuRate(stats: ConfigurableSnapshot): number {
  if (stats.danmaku <= 0) return 0
  const denominator = Math.max(1, stats.danmaku, stats.danmaku + stats.reply)
  const value = Math.max(0, 20 * Math.max(0, stats.reply) + stats.favorite + stats.like) / denominator
  return Math.max(ceil2(Math.min(100, value)), 0)
}

function calcReplyRate(stats: ConfigurableSnapshot): number {
  if (stats.reply <= 0) return 0
  const value = ((400 * stats.reply + 10 * stats.like + 10 * stats.favorite) / (200 * stats.reply + stats.view)) * 20
  return Math.max(ceil2(Math.min(value, 40)), 0)
}

function calcShareRate(stats: ConfigurableSnapshot, fix: FixCoefficients, coin: number): number {
  if (stats.share <= 0) return 0
  const value = ((2 * fix.a * coin + stats.favorite) / (5 * stats.share + stats.like)) * 10
  return Math.max(ceil2(Math.min(value, 10)), 0)
}

function computeRateCoefficients(
  stats: ConfigurableSnapshot,
  fix: FixCoefficients,
  rankingType: RankingType,
): RateCoefficients {
  const coin = adjustCoin(stats)

  let viewRate = rankingType === RankingType.MONTHLY
    ? calcViewRateLong(stats, fix, coin)
    : calcViewRateShort(stats, fix, coin)

  const favoriteRate = calcFavoriteRate(stats, fix, coin)
  const coinRate = calcCoinRate(stats, fix, coin)
  const likeRate = calcLikeRate(stats, fix, coin)
  const danmakuRate = calcDanmakuRate(stats)
  const replyRate = calcReplyRate(stats)
  const shareRate = calcShareRate(stats, fix, coin)

  return {
    view: viewRate,
    favorite: favoriteRate,
    coin: coinRate,
    like: likeRate,
    danmaku: danmakuRate,
    reply: replyRate,
    share: shareRate,
  }
}

function computeTotalPoints(diff: ConfigurableSnapshot, rates: RateCoefficients, fix: FixCoefficients): number {
  const coin = adjustCoin(diff)
  const viewPoints = diff.view * rates.view
  const favoritePoints = diff.favorite * rates.favorite
  const coinPoints = coin * rates.coin * fix.a
  const likePoints = diff.like * rates.like
  const danmakuPoints = diff.danmaku * rates.danmaku
  const replyPoints = diff.reply * rates.reply * fix.d
  const sharePoints = diff.share * rates.share
  return viewPoints + favoritePoints + coinPoints + likePoints + danmakuPoints + replyPoints + sharePoints
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction < 0.5) return floor
  if (fraction > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

interface ScoreComputation {
  diff: ConfigurableSnapshot
  rates: RateCoefficients
  fix: FixCoefficients
  point: number
}

function calculateScore(newStats: ConfigurableSnapshot, oldStats: ConfigurableSnapshot | null, rankingType: RankingType): ScoreComputation {
  const diff: ConfigurableSnapshot = oldStats == null
    ? newStats
    : {
      view: newStats.view - oldStats.view,
      favorite: newStats.favorite - oldStats.favorite,
      coin: newStats.coin - oldStats.coin,
      like: newStats.like - oldStats.like,
      danmaku: newStats.danmaku - oldStats.danmaku,
      reply: newStats.reply - oldStats.reply,
      share: newStats.share - oldStats.share,
      copyright: newStats.copyright,
    }

  const fix = computeFixCoefficients(diff)
  const rates = computeRateCoefficients(diff, fix, rankingType)
  const rawPoints = computeTotalPoints(diff, rates, fix)
  return {
    diff,
    rates,
    fix,
    point: roundHalfEven(fix.b * fix.c * rawPoints),
  }
}

function parseIsoDate(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + amount)
  return next
}

function startOfWeekMonday(date: Date): Date {
  const weekday = date.getUTCDay()
  const distanceToMonday = (weekday + 6) % 7
  return addDays(date, -distanceToMonday)
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function toStats(snapshot: SnapshotApiItem): ConfigurableSnapshot {
  return {
    view: snapshot.view ?? 0,
    favorite: snapshot.favorite ?? 0,
    coin: snapshot.coin ?? 0,
    like: snapshot.like ?? 0,
    danmaku: snapshot.danmaku ?? 0,
    reply: snapshot.reply ?? 0,
    share: snapshot.share ?? 0,
    copyright: 2,
  }
}

function findSnapshotOnOrBefore(snapshots: NormalizedSnapshot[], target: Date): NormalizedSnapshot | null {
  for (const item of snapshots) {
    if (item.dateValue.getTime() <= target.getTime()) {
      return item
    }
  }
  return null
}

function formatRateValue(value: number): string {
  return value.toFixed(2)
}

function formatAlgorithmBlock(
  label: string,
  increment: ScoreComputation | null,
  total: ScoreComputation,
  md: boolean = false
): string {
  if (!increment) {
    return [
      md ? `**——${label}算法——**` : `——${label}算法——`,
      '数据不足，无法计算该周期增量。'
    ].join('\n')
  }

  if (md) {
    return [
      `**——${label}算法——**`,
      '| 播 | 藏 | 币 | 赞 | 弹 | 评 | 享 |',
      '| :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
      `| ${formatRateValue(increment.rates.view)} | ${formatRateValue(increment.rates.favorite)} | ${formatRateValue(increment.rates.coin)} | ${formatRateValue(increment.rates.like)} | ${formatRateValue(increment.rates.danmaku)} | ${formatRateValue(increment.rates.reply)} | ${formatRateValue(increment.rates.share)} |`,
      '',
      `> **修正**: A=${formatRateValue(increment.fix.a)} B=${formatRateValue(increment.fix.b)} C=${formatRateValue(increment.fix.c)} D=${formatRateValue(increment.fix.d)}`,
      `> **增量分**: ${increment.point.toLocaleString('zh-CN')} &nbsp;&nbsp;|&nbsp;&nbsp; **总分**: ${total.point.toLocaleString('zh-CN')}`
    ].join('\n')
  }

  return [
    `——${label}算法——`,
    `R值: 播=${formatRateValue(increment.rates.view)} 藏=${formatRateValue(increment.rates.favorite)} 币=${formatRateValue(increment.rates.coin)} 赞=${formatRateValue(increment.rates.like)} 弹=${formatRateValue(increment.rates.danmaku)} 评=${formatRateValue(increment.rates.reply)} 享=${formatRateValue(increment.rates.share)}`,
    `修正: A=${formatRateValue(increment.fix.a)} B=${formatRateValue(increment.fix.b)} C=${formatRateValue(increment.fix.c)} D=${formatRateValue(increment.fix.d)}`,
    `增量分: ${increment.point.toLocaleString('zh-CN')}`,
    `总分: ${total.point.toLocaleString('zh-CN')}`
  ].join('\n')
}

function resolveRefreshToken(config: Config): string | null {
  if (cachedRefreshToken) return cachedRefreshToken
  const token = (config.refreshToken || '').trim()
  if (!token) return null
  cachedRefreshToken = token
  return token
}

async function ensureAccessToken(ctx: Context, config: Config): Promise<{
  accessToken: string
  refreshToken: string
  authorization: string
}> {
  const refreshToken = resolveRefreshToken(config)
  if (!refreshToken) {
    throw new Error('未配置 refreshToken')
  }

  if (cachedAccessToken && Date.now() < (accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS)) {
    return {
      accessToken: cachedAccessToken,
      refreshToken,
      authorization: `${cachedTokenType} ${cachedAccessToken}`,
    }
  }

  const response = await ctx.http.post<AuthRefreshResponse>(
    AUTH_REFRESH_URL,
    { refresh_token: refreshToken },
    { headers: { 'Content-Type': 'application/json' } },
  )
  if (config.debugMode) ctx.logger('vocabili').info('[API/Auth] POST /v2/auth/refresh\n%O', response)

  cachedAccessToken = response.access_token
  cachedTokenType = response.token_type || 'Bearer'
  accessTokenExpiresAt = Date.now() + response.expires_in * 1000

  if (response.refresh_token && response.refresh_token !== refreshToken) {
    cachedRefreshToken = response.refresh_token
  }

  return {
    accessToken: cachedAccessToken,
    refreshToken: cachedRefreshToken || refreshToken,
    authorization: `${cachedTokenType} ${cachedAccessToken}`,
  }
}

async function buildScoreReport(ctx: Context, config: Config, bvid: string): Promise<string> {
  if (!resolveRefreshToken(config)) {
    return '未配置 refreshToken，请在插件配置中填写后重试。'
  }

  const url = new URL('/v2/select/video/snapshot', API_BASE)
  url.searchParams.set('bvid', bvid)
  url.searchParams.set('page', '1')
  url.searchParams.set('page_size', '64')

  let payload: SnapshotApiResponse
  try {
    const auth = await ensureAccessToken(ctx, config)
    payload = await ctx.http.get<SnapshotApiResponse>(url.toString(), {
      headers: { Authorization: auth.authorization },
    })
    if (config.debugMode) ctx.logger('vocabili').info(`[API/Snapshot] GET ${url.pathname}${url.search}\n%O`, payload)
  } catch (error) {
    ctx.logger('vocabili').warn(error)
    return '鉴权失败或请求快照接口失败，请确认 refreshToken 是否有效。'
  }

  if (!payload.data?.length) {
    return `未查到 ${bvid} 的快照数据。`
  }

  const snapshots = payload.data
    .map<NormalizedSnapshot>((item) => ({
      dateText: item.date,
      dateValue: parseIsoDate(item.date),
      stats: toStats(item),
    }))
    .sort((a, b) => b.dateValue.getTime() - a.dateValue.getTime())

  const latest = snapshots[0]
  const oldest = snapshots[snapshots.length - 1]

  const prevDay = snapshots[1] ?? null
  const dailyIncrement = prevDay ? calculateScore(latest.stats, prevDay.stats, RankingType.DAILY) : null
  const dailyTotal = calculateScore(latest.stats, null, RankingType.DAILY)

  const weekStart = startOfWeekMonday(latest.dateValue)
  const weekBase = findSnapshotOnOrBefore(snapshots, addDays(weekStart, -1))
  const weeklyIncrement = weekBase ? calculateScore(latest.stats, weekBase.stats, RankingType.WEEKLY) : null
  const weeklyTotal = calculateScore(latest.stats, null, RankingType.WEEKLY)

  const monthStart = startOfMonth(latest.dateValue)
  const monthBase = findSnapshotOnOrBefore(snapshots, addDays(monthStart, -1))
  const monthlyIncrement = monthBase ? calculateScore(latest.stats, monthBase.stats, RankingType.MONTHLY) : null
  const monthlyTotal = calculateScore(latest.stats, null, RankingType.MONTHLY)

  const md = config.enableQQNativeMarkdown === true

  const lines: string[] = []
  if (md) {
    lines.push(
      `### 📊 算分结果（${bvid}）`,
      `> 数据范围：${oldest.dateText} ~ ${latest.dateText}`,
      '',
      '**【当前数据】**',
      '| 播放 | 收藏 | 硬币 | 点赞 | 弹幕 | 评论 | 分享 |',
      '| :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
      `| ${latest.stats.view} | ${latest.stats.favorite} | ${latest.stats.coin} | ${latest.stats.like} | ${latest.stats.danmaku} | ${latest.stats.reply} | ${latest.stats.share} |`,
      '',
      formatAlgorithmBlock('上一日', dailyIncrement, dailyTotal, md),
      '',
      formatAlgorithmBlock('一周榜', weeklyIncrement, weeklyTotal, md),
      '',
      formatAlgorithmBlock('一月榜', monthlyIncrement, monthlyTotal, md),
    )
  } else {
    lines.push(
      `算分结果（${bvid}）`,
      `数据范围：${oldest.dateText} ~ ${latest.dateText}`,
      '',
      '【当前数据】',
      `播放: ${latest.stats.view.toLocaleString('zh-CN')}`,
      `收藏: ${latest.stats.favorite.toLocaleString('zh-CN')}`,
      `硬币: ${latest.stats.coin.toLocaleString('zh-CN')}`,
      `点赞: ${latest.stats.like.toLocaleString('zh-CN')}`,
      `弹幕: ${latest.stats.danmaku.toLocaleString('zh-CN')}`,
      `评论: ${latest.stats.reply.toLocaleString('zh-CN')}`,
      `分享: ${latest.stats.share.toLocaleString('zh-CN')}`,
      '',
      formatAlgorithmBlock('上一日', dailyIncrement, dailyTotal, md),
      '',
      formatAlgorithmBlock('一周榜', weeklyIncrement, weeklyTotal, md),
      '',
      formatAlgorithmBlock('一月榜', monthlyIncrement, monthlyTotal, md),
    )
  }

  return lines.join('\n')
}

function extractSearchCandidates(items: SongSearchItem[]) {
  return items
    .map((item) => {
      const video = item.videos?.find((entry) => Boolean(entry.bvid) && !entry.disabled)
      if (!video?.bvid) return null
      return {
        name: item.display_name || item.name || '未知曲目',
        uploader: video.uploader?.name || '未知UP',
        bvid: video.bvid,
      }
    })
    .filter((item): item is { name: string; uploader: string; bvid: string } => Boolean(item))
}

type BoardKind = 'daily' | 'weekly' | 'monthly'

function parsePositiveInteger(input: number | undefined, fallback: number): number {
  if (!input || Number.isNaN(input) || input < 1) return fallback
  return Math.floor(input)
}

function parseChineseMonthToken(input: string): number | null {
  const text = input.trim()
  const mapping: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
  }
  if (mapping[text]) return mapping[text]
  if (/^\d{1,2}$/.test(text)) {
    const month = Number.parseInt(text, 10)
    return month >= 1 && month <= 12 ? month : null
  }
  return null
}

function toDateAtStart(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function parseFlexibleDateInput(input: string): Date | null {
  const text = input.trim()
  const now = new Date()
  now.setHours(0, 0, 0, 0)

  const fullYmd = text.match(/^(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/)
  if (fullYmd) {
    return toDateAtStart(Number(fullYmd[1]), Number(fullYmd[2]), Number(fullYmd[3]))
  }

  const md = text.match(/^(\d{1,2})[.\-/月](\d{1,2})日?$/)
  if (md) {
    const month = Number(md[1])
    const day = Number(md[2])
    const thisYear = toDateAtStart(now.getFullYear(), month, day)
    if (!thisYear) return null
    if (thisYear.getTime() > now.getTime()) {
      return toDateAtStart(now.getFullYear() - 1, month, day)
    }
    return thisYear
  }

  return null
}

function parseMonthInput(input: string): { year: number; month: number } | null {
  const text = input.trim()
  const numeric = text.match(/^(\d{4})[.\-/年](\d{1,2})月?$/)
  if (numeric) {
    const year = Number(numeric[1])
    const month = Number(numeric[2])
    if (month >= 1 && month <= 12) return { year, month }
    return null
  }

  const chinese = text.match(/^(\d{4})年([一二三四五六七八九十]{1,3})月$/)
  if (chinese) {
    const year = Number(chinese[1])
    const month = parseChineseMonthToken(chinese[2])
    if (!month) return null
    return { year, month }
  }

  return null
}

function startOfSaturdayWeek(date: Date): Date {
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const weekday = target.getDay()
  const distanceToSaturday = (weekday + 1) % 7
  target.setDate(target.getDate() - distanceToSaturday)
  return target
}

function addLocalDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function addLocalMonths(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(1)
  next.setMonth(next.getMonth() + amount)
  return next
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1)
}

function getLatestAnchor(kind: BoardKind): Date {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  if (kind === 'daily') return addLocalDays(now, -1)
  if (kind === 'weekly') return addLocalDays(startOfSaturdayWeek(now), -7)
  return addLocalMonths(now, -1)
}

async function resolveLatestIssue(ctx: Context, config: Config, board: string): Promise<number | null> {
  if (!resolveRefreshToken(config)) return null
  const latestUrl = new URL('/v2/select/latest_ranking', API_BASE)
  latestUrl.searchParams.set('board', board)
  try {
    const auth = await ensureAccessToken(ctx, config)
    const latest = await ctx.http.get<number | string>(latestUrl.toString(), {
      headers: { Authorization: auth.authorization },
    })
    if (config.debugMode) ctx.logger('vocabili').info(`[API/LatestRanking] GET ${latestUrl.pathname}${latestUrl.search}\n%O`, latest)
    const parsed = typeof latest === 'number' ? latest : Number.parseInt(String(latest), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch (error) {
    ctx.logger('vocabili').warn(error)
    return null
  }
}

async function resolveBoardIssueByQuery(
  ctx: Context,
  config: Config,
  board: string,
  kind: BoardKind,
  query?: string,
): Promise<{ issue: number; latestIssue: number } | null> {
  const latestIssue = await resolveLatestIssue(ctx, config, board)
  if (!latestIssue) return null

  const normalized = (query || '').trim()
  if (!normalized) return { issue: latestIssue, latestIssue }

  if (/^\d+$/.test(normalized)) {
    const issue = Number.parseInt(normalized, 10)
    return issue > 0 ? { issue, latestIssue } : null
  }

  const anchor = getLatestAnchor(kind)
  if (kind === 'daily') {
    const target = parseFlexibleDateInput(normalized)
    if (!target) return null
    const diff = Math.floor((anchor.getTime() - target.getTime()) / 86400000)
    if (diff < 0) return null
    return { issue: latestIssue - diff, latestIssue }
  }

  if (kind === 'weekly') {
    const target = parseFlexibleDateInput(normalized)
    if (!target) return null
    const targetWeekStart = startOfSaturdayWeek(target)
    const diff = Math.floor((anchor.getTime() - targetWeekStart.getTime()) / (86400000 * 7))
    if (diff < 0) return null
    return { issue: latestIssue - diff, latestIssue }
  }

  const targetMonth = parseMonthInput(normalized)
  if (!targetMonth) return null
  const anchorMonthIdx = monthIndex(anchor.getFullYear(), anchor.getMonth() + 1)
  const targetMonthIdx = monthIndex(targetMonth.year, targetMonth.month)
  const diff = anchorMonthIdx - targetMonthIdx
  if (diff < 0) return null
  return { issue: latestIssue - diff, latestIssue }
}

function formatDateYmd(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function buildBoardMetaText(kind: BoardKind, title: string, issue: number, latestIssue: number, page: number): string {
  const anchor = getLatestAnchor(kind)
  const diff = latestIssue - issue
  if (diff < 0) {
    return `${title}：第 ${issue} 期（第 ${page} 页）\n日期：该期数晚于最新期 ${latestIssue}，无法自动推算日期。`
  }

  if (kind === 'daily') {
    const date = addLocalDays(anchor, -diff)
    return `${title}：第 ${issue} 期（第 ${page} 页）\n日期：${formatDateYmd(date)}`
  }

  if (kind === 'weekly') {
    const start = addLocalDays(anchor, -7 * diff)
    const end = addLocalDays(start, 7)
    return `${title}：第 ${issue} 期（第 ${page} 页）\n范围：${formatDateYmd(start)} 00:00 ~ ${formatDateYmd(end)} 00:00（UTC+8，周六切分）`
  }

  const month = addLocalMonths(anchor, -diff)
  return `${title}：第 ${issue} 期（第 ${page} 页）\n月份：${month.getFullYear()}-${month.getMonth() + 1}`
}

async function captureBoardCards(
  puppeteer: PuppeteerService,
  accessToken: string,
  refreshToken: string,
  board: string,
  issue: number,
  pageNumber: number,
  isNewPart: boolean,
): Promise<Buffer | null> {
  const page = await puppeteer.page()
  try {
    await page.setViewport({ width: 1200, height: 4096, deviceScaleFactor: 1 })
    const url = new URL(`https://vocabili.top/board/${board}/${issue}`)
    if (pageNumber > 1) url.searchParams.set('page', String(pageNumber))
    if (isNewPart) url.searchParams.set('part', 'new')

    await page.evaluateOnNewDocument((access, refresh) => {
      localStorage.setItem('vbs_access_token', access)
      localStorage.setItem('vbs_refresh_token', refresh)
    }, accessToken, refreshToken)

    await page.goto(url.toString(), { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.grid.gap-5.md\\:grid-cols-2', { timeout: 30000 })

    await page.evaluate(() => {
      document.querySelectorAll('.mt-3.flex.gap-1\\.5.xs\\:mt-4.xs\\:gap-2').forEach((node) => {
        node.remove()
      })
      document.querySelectorAll<HTMLElement>('header,nav,div').forEach((node) => {
        const className = node.className || ''
        if (typeof className !== 'string') return
        const classes = [
          'fixed', 'inset-x-0', 'top-0', 'z-50', 'border-b',
          'bg-background/90', 'backdrop-blur', 'supports-backdrop-filter:bg-background/70',
        ]
        if (classes.every(token => className.includes(token))) node.remove()
      })
    })

    const target = await page.$('.grid.gap-5.md\\:grid-cols-2')
    if (!target) return null

    const box = await target.boundingBox()
    if (!box) return null
    const viewport = page.viewport() || { width: 1200, height: 1800 }
    const horizontalPadding = 16
    const verticalPadding = 16
    const clipLeft = Math.max(0, box.x - horizontalPadding)
    const clipRight = Math.min(viewport.width, box.x + box.width + horizontalPadding)
    const clipTop = Math.max(0, box.y - verticalPadding)
    const clipBottom = box.y + box.height + verticalPadding
    const clipWidth = Math.max(1, clipRight - clipLeft)
    const clipHeight = Math.max(1, clipBottom - clipTop)

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 78,
      clip: {
        x: clipLeft,
        y: clipTop,
        width: clipWidth,
        height: clipHeight,
      },
      captureBeyondViewport: true,
    })
    return Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot)
  } finally {
    await page.close()
  }
}

interface QQSendMessageRequest {
  content: string
  msg_type: 2
  msg_id?: string
  markdown: { content: string }
}

interface QQSessionBridge {
  sendMessage(channelId: string, data: QQSendMessageRequest): Promise<unknown>
  sendPrivateMessage(openid: string, data: QQSendMessageRequest): Promise<unknown>
}

async function sendTextOrMarkdown(session: any, config: Config, text: string): Promise<string> {
  if (config.enableQQNativeMarkdown && session.platform === 'qq') {
    const internal = session.bot?.internal as QQSessionBridge | undefined
    if (internal) {
      const payload: QQSendMessageRequest = {
        content: 'Vocabili 报告',
        msg_type: 2,
        msg_id: session.messageId,
        markdown: { content: text },
      }
      try {
        if (session.isDirect) {
          await internal.sendPrivateMessage(session.channelId, payload)
        } else {
          await internal.sendMessage(session.channelId, payload)
        }
        return ''
      } catch (error) {
        session.app.logger('vocabili').warn('QQ native markdown send failed, fallback to text', error)
      }
    }
  }
  return text
}

export function apply(ctx: Context, config: Config) {
  ctx.command('算分 <bvid:string>', '计算上一日、本周、本月分数')
    .action(async ({ session }, bvid) => {
      if (!resolveRefreshToken(config)) {
        return '未配置 refreshToken，请在插件配置中填写后重试。'
      }
      if (!bvid) {
        return '请提供 bvid，例如：/算分 BV1qDUPYKEzf'
      }

      const normalizedBvid = bvid.trim()
      if (!/^BV[0-9A-Za-z]{10}$/.test(normalizedBvid)) {
        return 'bvid 格式不正确，请检查后重试。'
      }

      const report = await buildScoreReport(ctx, config, normalizedBvid)
      return sendTextOrMarkdown(session, config, report)
    })

  ctx.command('搜索 [...keyword:string]', '搜索歌曲并回复序号后自动算分')
    .option('page', '-p <page:number> 指定页码')
    .action(async ({ session, options }, ...keywordList) => {
      if (!resolveRefreshToken(config)) {
        return '未配置 refreshToken，请在插件配置中填写后重试。'
      }
      const normalizedKeyword = keywordList.join(' ').trim()
      if (!normalizedKeyword) {
        return '请提供搜索关键词，例如：/搜索 never'
      }

      const pageNumber = parsePositiveInteger(options.page, 1)
      const searchUrl = new URL('/v2/search/song', API_BASE)
      searchUrl.searchParams.set('keyword', normalizedKeyword)
      searchUrl.searchParams.set('page', String(pageNumber))
      searchUrl.searchParams.set('page_size', '10')
      searchUrl.searchParams.set('includeEmpty', 'false')
      searchUrl.searchParams.set('includeOutdated', 'false')

      let payload: SongSearchApiResponse | SongSearchItem[]
      try {
        const auth = await ensureAccessToken(ctx, config)
        payload = await ctx.http.get<SongSearchApiResponse | SongSearchItem[]>(searchUrl.toString(), {
          headers: { Authorization: auth.authorization },
        })
        if (config.debugMode) ctx.logger('vocabili').info(`[API/Search] GET ${searchUrl.pathname}${searchUrl.search}\n%O`, payload)
      } catch (error) {
        ctx.logger('vocabili').warn(error)
        return '鉴权失败或搜索接口请求失败，请确认 refreshToken 是否有效。'
      }

      const items = Array.isArray(payload) ? payload : (payload.data || [])
      const candidates = extractSearchCandidates(items)
      if (!candidates.length) {
        return `未找到与“${normalizedKeyword}”相关的可用歌曲。`
      }

      const md = config.enableQQNativeMarkdown === true
      const inlineCmd = md && config.enableQQInlineCmd === true
      const shown = candidates.slice(0, 10)
      
      const nextCmd = `/搜索 ${normalizedKeyword} -p ${pageNumber + 1}`
      const listText = [
        md ? `### 🔍 搜索“${normalizedKeyword}”结果如下(第${pageNumber}页):` : `搜索“${normalizedKeyword}”结果如下(第${pageNumber}页):`,
        ...shown.map((item, index) => {
          const num = index + 1
          const text = `${num}. ${item.name} (${item.uploader})`
          if (inlineCmd && item.bvid) {
            const cmd = `/算分 ${item.bvid}`
            return `[${text}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(cmd)}&enter=true&reply=false)`
          }
          return text
        }),
        '',
        md ? '**请在30秒内回复序号(1-10)进行数据分析**' : '请在30秒内回复序号(1-10)进行数据分析',
        inlineCmd
          ? `> 要查看下一页，请点击：[${nextCmd}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(nextCmd)}&enter=true&reply=false)`
          : (md ? `> 要查看下一页，请使用：\`${nextCmd}\`` : `要查看下一页，请使用：${nextCmd}`),
      ].join('\n')
      
      const sentText = await sendTextOrMarkdown(session, config, listText)
      if (sentText) {
        await session.send(sentText)
      }

      const replySession = await new Promise<any>((resolve) => {
        const dispose = ctx.middleware((s, next) => {
          if (s.userId !== session.userId || s.channelId !== session.channelId) return next()
          
          const clean = s.content.replace(/<at[^>]*>/g, '').replace(/@\S+/g, '').trim()
          if (/^\d+$/.test(clean)) {
            dispose()
            clearTimeout(timer)
            resolve(s)
            return
          }
          
          if (clean.startsWith('/')) {
            dispose()
            clearTimeout(timer)
            resolve('aborted')
            return next()
          }

          return next()
        }, true)
        const timer = setTimeout(() => {
          dispose()
          resolve(null)
        }, 30000)
      })

      if (replySession === 'aborted') {
        return
      }

      if (!replySession || !replySession.content) {
        return '超时未收到序号，已取消本次搜索。'
      }

      const answer = replySession.content.replace(/<at[^>]*>/g, '').replace(/@\S+/g, '').trim()
      const match = answer.match(/^\d+/)
      const selectedIndex = match ? Number.parseInt(match[0], 10) : NaN
      
      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > shown.length) {
        await replySession.send(`输入无效，请回复 1-${shown.length} 的数字序号。`)
        return
      }

      const selected = shown[selectedIndex - 1]
      const report = await buildScoreReport(ctx, config, selected.bvid)
      const finalText = [
        md ? `**已选择**：${selected.name} (${selected.uploader})` : `已选择：${selected.name}(${selected.uploader})`,
        md ? `**BV号**：${selected.bvid}` : `BV号：${selected.bvid}`,
        '',
        report,
      ].join('\n')
      
      const fallbackText = await sendTextOrMarkdown(replySession, config, finalText)
      if (fallbackText) {
        await replySession.send(fallbackText)
      }
    })

  const registerBoardCommand = (command: string, board: string, title: string, kind: BoardKind) => {
    const cmd = ctx.command(`${command} [query:string]`, `${title}截图`)
      .option('new', '-n 查询新曲榜')
      .option('page', '-p <page:number> 指定页码')
      .example(`${command}`)
      .example(`${command} 78`)
      .example(`${command} -n`)

    if (kind === 'monthly') {
      cmd.example(`${command} 2026.3 -p 2`)
    } else {
      cmd.example(`${command} 2026.3.8 -p 2`)
    }

    cmd.action(async ({ options }, query) => {
        if (!resolveRefreshToken(config)) {
          return '未配置 refreshToken，请在插件配置中填写后重试。'
        }
        const puppeteer = ctx.puppeteer
        if (!puppeteer) {
          return '未检测到 puppeteer 服务，请先启用 koishi-plugin-puppeteer。'
        }

        const hasPageOption = options.page !== undefined && options.page !== null && String(options.page).trim() !== ''
        const parsedPage = typeof options.page === 'number'
          ? options.page
          : Number.parseInt(String(options.page || ''), 10)
        if (hasPageOption && (!Number.isInteger(parsedPage) || parsedPage < 1)) {
          return '参数不合法，请使用 -h 查看帮助。'
        }

        const resolved = await resolveBoardIssueByQuery(ctx, config, board, kind, query)
        if (!resolved || resolved.issue < 1) {
          if (kind === 'monthly') {
            return `${title}参数无效，请使用 -h 查看帮助。`
          }
          return `${title}参数无效，请使用 -h 查看帮助。`
        }

        const pageNumber = parsePositiveInteger(parsedPage, 1)
        const isNewPart = Boolean(options.new)
        let screenshot: Buffer | null
        try {
          const tokens = await ensureAccessToken(ctx, config)
          screenshot = await captureBoardCards(
            puppeteer,
            tokens.accessToken,
            tokens.refreshToken,
            board,
            resolved.issue,
            pageNumber,
            isNewPart,
          )
        } catch (error) {
          ctx.logger('vocabili').warn(error)
          return `${title}截图失败，请稍后重试。`
        }

        if (!screenshot) {
          return `${title}截图失败，未找到目标区域（.grid.gap-5.md:grid-cols-2）。`
        }

        const displayTitle = isNewPart ? `${title}-新曲榜` : title
        const meta = buildBoardMetaText(kind, displayTitle, resolved.issue, resolved.latestIssue, pageNumber)
        return `${h.image(screenshot, 'image/jpeg')}\n${meta}`
      })
  }

  registerBoardCommand('日榜', 'vocaloid-daily', '日榜', 'daily')
  registerBoardCommand('周榜', 'vocaloid-weekly', '周榜', 'weekly')
  registerBoardCommand('月榜', 'vocaloid-monthly', '月榜', 'monthly')
}
