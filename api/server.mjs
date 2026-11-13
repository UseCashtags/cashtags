/**
 * CASHTAGS API: plain node:http + node:sqlite. Also runs the @UseCashtags bot loop and the vanity grinder.
 * The keeper runs as its own timer (api/keeper-run.mjs); both sign for fee wallets, and the per-coin DB lock
 * (db.lockCoin) is what keeps them from signing for the same wallet at once.
 */
import { buybackConfig, ensureTables as ensureBuybackTables, totals as buybackTotals } from './buyback.mjs'
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { openDb, now, kvGet, kvSet, buckets, owedTo, owedAssets, upsertUser, launchingOpen, lockCoin, unlockCoin, LAUNCHING_CLOSED } from './db.mjs'
import { lamportsToUsd, refreshMarket, solUsd } from './market.mjs'
import { payCreator, readCoin, creditSurplus, keeperConfig, collectCoin } from './keeper.mjs'
import { parseSeed, seedFingerprint } from './feewallet.mjs'
import { freshCount, startGrinder } from './vanity.mjs'
import { pumpProgram } from '../lib/pump.mjs'
import { xProvider } from './providers/x.mjs'
import { stubProvider } from './providers/stub.mjs'
import { fomoProvider, isFomoWallet } from './providers/fomo.mjs'
import { xmoneyConfig, xmoneyView, baseKey } from './xmoney.mjs'
import { squareLogo } from './images.mjs'
import { TwitterApiIo, FixtureX } from './x.mjs'
import { createBot } from './bot.mjs'
import { guardConfig } from './guards.mjs'
import { createSiteLauncher, SiteError, isWalletUser, signedBy } from './sitelaunch.mjs'

export class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status } }

export function createApp({ env = process.env, db: dbIn = null, conn: connIn = null, x: xIn = null, keeper: keeperIn = null, launcher: launcherIn = null, platformLauncher: platformLauncherIn = null, pin = null } = {}) {
  const PUBLIC_URL = (env.PUBLIC_URL ?? 'http://localhost:5570').replace(/\/+$/, '')
  const SITE_ORIGIN = new URL(PUBLIC_URL).origin
  const DATA_DIR = env.DATA_DIR ?? './data'
  const LOGO_DIR = env.LOGO_DIR ?? join(DATA_DIR, 'logos')
  mkdirSync(LOGO_DIR, { recursive: true })
  const db = dbIn ?? openDb(env.DB_PATH ?? join(DATA_DIR, 'cashtags.db'))
  // A fresh store starts with launching CLOSED: it opens when the platform token lands (api/launch.mjs recordLaunch).
  if (!kvGet(db, 'initialised')) { kvSet(db, 'initialised', now()); if (env.START_OPEN !== '1') kvSet(db, LAUNCHING_CLOSED, 'until the project token launches') }

  const rpcCounts = new Map()
  const conn = connIn ?? new Connection(env.RPC_URL ?? 'http://127.0.0.1:8899', {
    commitment: 'confirmed',
    fetchMiddleware: (url, options, f) => { try { for (const r of [].concat(JSON.parse(options.body))) rpcCounts.set(r.method, (rpcCounts.get(r.method) ?? 0) + 1) } catch {} return f(url, options) },
  })
  const readKey = (p) => p && existsSync(p) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')))) : null
  const keeper = keeperIn ?? readKey(env.KEEPER_KEY)
  const launcher = launcherIn ?? readKey(env.LAUNCH_KEY)
  // the platform token's own launch + creator wallet (operator 10 Nov); absent = the launch wallet, fee-wallet creator
  const platformLauncher = platformLauncherIn ?? readKey(env.PLATFORM_LAUNCH_KEY)
  const seed = env.FEE_SEED ? parseSeed(env.FEE_SEED) : null
  const pump = pumpProgram(conn)
  const kcfg = keeperConfig(env)

  // ── X ──
  const X_HANDLE = env.X_HANDLE ?? 'UseCashtags'
  const x = xIn ?? (env.TWITTERAPI_IO_KEY ? new TwitterApiIo({ apiKey: env.TWITTERAPI_IO_KEY, handle: X_HANDLE, loginCookie: env.X_LOGIN_COOKIE ?? '', proxy: env.X_PROXY ?? '' }) : new FixtureX(X_HANDLE))
  const DEV = env.DEV_STUBS === '1'
  if (DEV && PUBLIC_URL.startsWith('https:')) throw new Error('DEV_STUBS=1 is refused on an https site')
  const signIn = env.X_CLIENT_ID ? xProvider(env.X_CLIENT_ID, env.X_CLIENT_SECRET, env.X_BEARER, env.TWITTERAPI_IO_KEY) : DEV ? stubProvider('x', 'X') : null
  const OAUTH_CALLBACK_BASE = env.OAUTH_CALLBACK_BASE || PUBLIC_URL
  const fomo = fomoProvider(env.FOMO_LOOKUP)
  const xcfg = xmoneyConfig(env), xmoneyOn = xcfg.enabled
  // ⭐ Float launches (11 Nov): on unless FLOAT_ENABLED=0 (then every request launches on pump.fun)
  const floatOn = env.FLOAT_ENABLED !== '0'

  const guards = guardConfig(env)
  const bot = launcher && seed ? createBot({ db, conn, pump, x, launcher, platformLauncher, seed, guards, env, publicUrl: PUBLIC_URL, logoDir: LOGO_DIR, ...(pin ? { pin } : {}) }) : null
  // ⭐ launching on the site (13 Nov): the same launch, from a form (api/sitelaunch.mjs)
  const site = createSiteLauncher({ db, conn, pump, launcher, seed, guards, env, publicUrl: PUBLIC_URL, logoDir: LOGO_DIR, x, ...(pin ? { pin } : {}) })

  // ── helpers ──
  const memoStore = new Map()
  async function memo(key, ttlMs, fn) {
    const hit = memoStore.get(key)
    if (hit && hit.until > Date.now()) return hit.value
    const value = await fn()
    memoStore.set(key, { value, until: Date.now() + ttlMs })
    if (memoStore.size > 5000) for (const [k, v] of memoStore) if (v.until < Date.now()) memoStore.delete(k)
    return value
  }
  // ⭐ Public reads are built at most once per few seconds and shared by every visitor (launch traffic, 11 Nov load test:
  // /api/stats and /api/tokens did ~150 req/s each, and this process also runs the bot). res.cacheKey marks a cacheable read.
  const respCache = new Map()
  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    if (status === 200 && res.cacheKey) {
      if (respCache.size > 5000) respCache.clear()
      respCache.set(res.cacheKey, { at: Date.now(), text })
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(text)
  }
  const readJson = (req, limit = 16 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError('Too large', 413)); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { reject(new HttpError('Bad JSON')) } })
    req.on('error', reject)
  })
  const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1] ?? null
  const secure = PUBLIC_URL.startsWith('https:')
  const cookies = []
  const setCookie = (res, name, value, maxAge) => {
    const all = [].concat(res.getHeader('set-cookie') ?? [])
    all.push(`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`)
    res.setHeader('set-cookie', all)
  }
  void cookies
  const hits = new Map()
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((h) => t - h < 3600_000)) hits.delete(k) }, 600_000).unref()
  function limited(req, bucket, perHour) {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').pop().trim()
    const k = `${bucket}:${ip}`, t = Date.now()
    const list = (hits.get(k) ?? []).filter((h) => t - h < 3600_000)
    list.push(t); hits.set(k, list)
    return list.length > perHour
  }
  const int = (q, name, dflt, max) => { const n = Number(q.get(name) ?? dflt); return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : dflt }

  const SESSION_DAYS = 14
  const SID = 'ct_sid'
  function sessionUser(req) {
    const id = cookie(req, SID)
    if (!id) return null
    const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now())
    return s ? db.prepare('SELECT * FROM users WHERE x_id = ?').get(s.x_id) : null
  }
  const pendingAuth = new Map()
  const safeReturnPath = (ret) => (/^\/(?![\/\\])[\x21-\x7e]*$/.test(ret ?? '') && !String(ret).includes('\\') ? ret : '/account')

  // `wallet`: the address of an account signed in with a Solana wallet (its handle is that address), else null
  const userView = (u) => u ? { id: u.x_id, handle: u.handle ?? '', name: u.name ?? u.handle ?? '', avatar: u.avatar ?? '', wallet: isWalletUser(u) ? u.x_id.slice(7) : null } : null
  const pendingWallet = new Map()
  const unitScale = (t) => 10 ** (t.quote_mint ? (t.quote_decimals ?? 0) : 9)
  /** Lifetime creator fees of a coin pump.fun pays out itself: collected (ext_in) + still waiting (ext_waiting). */
  const extEarned = (t) => (t.native_holders || t.own_creator) && !t.quote_mint ? (t.ext_in ?? 0) + (t.ext_waiting ?? 0) : 0
  function tokenView(t, price) {
    const b = buckets(db, t.mint)
    const sol = (units) => (t.quote_mint ? 0 : units / 1e9)
    const airdropped = db.prepare("SELECT COALESCE(SUM(lamports), 0) l, count(DISTINCT batch) n FROM outflows WHERE mint = ? AND kind = 'airdrop' AND state = 'landed'").get(t.mint)
    const paid = db.prepare("SELECT COALESCE(SUM(lamports), 0) l FROM outflows WHERE mint = ? AND kind = 'payout' AND state = 'landed'").get(t.mint).l
    const creator = db.prepare('SELECT * FROM users WHERE x_id = ?').get(t.creator_id)
    return {
      mint: t.mint, name: t.name, symbol: t.symbol, image: t.image ?? '', description: t.description ?? '',
      creator: userView(creator) ?? { id: t.creator_id, handle: t.creator_handle, name: t.creator_handle, avatar: '' },
      tweetUrl: t.tweet_url ?? '', launchTx: t.launch_sig ?? '', createdAt: t.created_at, platform: !!t.platform,
      // launched FOR its creator by someone else (12 Nov): who asked
      launchedBy: t.launched_by_id ? { id: t.launched_by_id, handle: t.launched_by_handle } : null,
      mode: t.mode, nativeHolders: !!t.native_holders, ownCreator: !!t.own_creator, feeWallet: t.fee_wallet, venue: t.venue ?? 'pump',
      // ⭐ a paired coin (11 Nov): fees are in its quote token. `unit` names the asset every amount below is in;
      // the *Sol fields are SOL coins only (0 for a paired coin).
      quote: t.quote_mint ? { mint: t.quote_mint, symbol: t.quote_symbol ?? '', decimals: t.quote_decimals ?? 0 } : null,
      unit: t.quote_mint ? (t.quote_symbol || 'tokens') : 'SOL',
      // ⭐ own-wallet (platform) coin: its creator rewards are read from the chain (api/feetrack.mjs), shown like any other coin's
      creatorEarned: (t.own_creator ? t.ext_in + t.ext_waiting : b.creatorIn) / unitScale(t),
      creatorPaid: (t.own_creator ? t.ext_out : paid) / unitScale(t), creatorOwed: (t.own_creator ? t.ext_waiting : b.creator) / unitScale(t),
      marketCapUsd: t.market_cap_usd ?? 0, graduated: !!t.graduated, curveProgress: t.curve_progress ?? 0,
      volume24hUsd: t.volume_24h_usd ?? 0, change24h: t.change_24h ?? null,
      feesUsd: t.quote_mint ? (t.fees_usd ?? 0) : lamportsToUsd(b.creatorIn + b.holdersIn + extEarned(t), price), feesSol: sol(b.creatorIn + b.holdersIn + extEarned(t)),
      creatorEarnedSol: sol(b.creatorIn), creatorPaidSol: sol(paid), creatorOwedSol: sol(b.creator),
      holdersEarnedSol: sol(b.holdersIn), holdersPaidSol: sol(airdropped.l + (t.native_holders ? t.ext_out : 0)),
      holdersPendingSol: sol(b.holders + (t.native_holders ? t.ext_in - t.ext_out + t.ext_waiting : 0)), airdrops: airdropped.n,
      links: {
        pump: `https://pump.fun/coin/${t.mint}`, float: `https://www.floatlaunch.xyz/tokens/${t.mint}`, fomo: `https://fomo.family/tokens/solana/${t.mint}`,
        dexscreener: `https://dexscreener.com/solana/${t.mint}`, x: `https://x.com/search?q=${encodeURIComponent('$' + t.symbol)}&f=live`,
        solscan: `https://solscan.io/token/${t.mint}`,
      },
    }
  }
  // our Base wallet (Peer deposits live there), derived from FEE_SEED like every fee wallet; computed once
  let baseAddr = null
  const baseWalletAddress = async () => {
    if (baseAddr || !seed) return baseAddr
    const { privateKeyToAccount } = await import('viem/accounts')
    baseAddr = privateKeyToAccount(baseKey(seed)).address
    return baseAddr
  }
  const outflowView = (o, price) => {
    const t = db.prepare('SELECT quote_mint, quote_symbol, quote_decimals FROM tokens WHERE mint = ?').get(o.mint) ?? {}
    const amount = o.lamports / unitScale(t)
    return { signature: o.signature, time: o.time, unit: t.quote_mint ? (t.quote_symbol || 'tokens') : 'SOL', amount,
      sol: t.quote_mint ? 0 : amount, usd: t.quote_mint ? null : lamportsToUsd(o.lamports, o.sol_usd ?? price), kind: o.kind, destination: o.destination, mint: o.mint, state: o.state,
    recipients: o.kind === 'airdrop' ? db.prepare('SELECT count(*) n FROM airdrop_items WHERE outflow_id = ?').get(o.id).n : undefined }
  }

  /**
   * Before a mode switch: collects everything the coin has earned so far (any amount) and books it to the CURRENT mode,
   * under the coin's lock, so fees earned before the switch stay where they were promised. Returns with the lock held:
   * the caller switches, then unlocks.
   */
  async function settleBeforeSwitch(t) {
    if (!lockCoin(db, t.mint, 120)) throw new HttpError('A payout for this coin is in progress. Try again in a minute.', 409)
    try {
      const { r } = keeper ? await collectCoin(db, conn, pump, keeper, t, { ...kcfg, minCollect: 1 }) : { r: await readCoin(conn, t) }
      creditSurplus(db, t, r.wallet, { solUsd: await solUsd().catch(() => null) })
    } catch (e) { unlockCoin(db, t.mint); throw e }
  }

  // ── routes ──
  async function route(req, res, url) {
    const path = url.pathname, q = url.searchParams
    let m
    if (path === '/api/health') return json(res, 200, { ok: true })
    if (req.method === 'GET') {
      // signed-in visitors always read their token / creator pages fresh (a setting they just saved must show at once)
      const ttl = path === '/api/stats' || path === '/api/tokens' || path === '/api/payments' || path === '/api/payments/top' ? 5000 : path === '/api/feed' ? 3000
        : /^\/api\/(token|creator)\/[^/]+$/.test(path) && !cookie(req, SID) ? 5000 : 0
      if (ttl) {
        const key = `${path}?${q.toString()}`, hit = respCache.get(key)
        if (hit && Date.now() - hit.at < ttl) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(hit.text) }
        res.cacheKey = key
      }
    }
    const price = await solUsd().catch(() => 0)

    if (path === '/api/stats') {
      const s = db.prepare('SELECT count(*) n, count(DISTINCT creator_id) c FROM tokens').get()
      // ⛔ SOL sums over SOL coins only; a paired coin's rows are in its own token (its USD is in tokens.fees_usd)
      // + fees pump.fun pays out itself (holder-reward coins, the platform coin), read from the chain (api/feetrack.mjs)
      const ext = db.prepare('SELECT COALESCE(SUM(ext_in + ext_waiting), 0) earned, COALESCE(SUM(CASE WHEN own_creator = 1 THEN ext_out ELSE 0 END), 0) toCreator, COALESCE(SUM(CASE WHEN native_holders = 1 THEN ext_out ELSE 0 END), 0) toHolders FROM tokens WHERE quote_mint IS NULL AND (native_holders = 1 OR own_creator = 1)').get()
      const fees = db.prepare('SELECT COALESCE(SUM(c.lamports), 0) l FROM credits c JOIN tokens t ON t.mint = c.mint WHERE t.quote_mint IS NULL').get().l + ext.earned
      const pairedUsd = db.prepare('SELECT COALESCE(SUM(fees_usd), 0) u FROM tokens WHERE quote_mint IS NOT NULL').get().u
      const paid = db.prepare("SELECT o.kind, COALESCE(SUM(o.lamports), 0) l FROM outflows o JOIN tokens t ON t.mint = o.mint WHERE o.state = 'landed' AND t.quote_mint IS NULL GROUP BY o.kind").all()
      const pm = kvGet(db, 'platform_mint')
      return json(res, 200, {
        launches: s.n, creators: s.c, feesSol: fees / 1e9, feesUsd: lamportsToUsd(fees, price) + pairedUsd, solUsd: price,
        paidToCreatorsSol: ((paid.find((r) => r.kind === 'payout')?.l ?? 0) + ext.toCreator) / 1e9, airdroppedSol: ((paid.find((r) => r.kind === 'airdrop')?.l ?? 0) + ext.toHolders) / 1e9,
        queued: db.prepare("SELECT count(*) n FROM mentions WHERE state IN ('queued', 'launching')").get().n,
        launchingOpen: launchingOpen(db), handle: X_HANDLE, platformMint: pm,
      })
    }
    if (path === '/api/tokens') {
      const sort = { new: 'created_at DESC', top: 'market_cap_usd DESC', fees: 'fees_usd DESC' }[q.get('sort') ?? 'new'] ?? 'created_at DESC'
      const search = String(q.get('q') ?? '').trim().replace(/^\$/, '')
      const limit = int(q, 'limit', 48, 100), offset = int(q, 'offset', 0, 100_000)
      const conds = [], args = []
      if (search) { conds.push('(upper(symbol) LIKE ? OR upper(name) LIKE ? OR mint = ? OR lower(creator_handle) = lower(?))'); args.push(`${search.toUpperCase()}%`, `%${search.toUpperCase()}%`, search, search.replace(/^@/, '')) }
      // ⭐ the explore boards (13 Nov): graduated=1 → off the curve (PumpSwap, or Raydium for a Float coin); graduated=0 → still on it
      if (q.get('graduated') === '1') conds.push('graduated = 1')
      if (q.get('graduated') === '0') conds.push('graduated = 0')
      // ⭐ sort=xmoney (13 Nov): only launches made FOR an X account, whose creator rewards go to that account's X Money; newest first
      if (q.get('sort') === 'xmoney') conds.push('launched_by_id IS NOT NULL')
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT * FROM tokens ${where} ORDER BY platform DESC, ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset)
      const total = db.prepare(`SELECT count(*) n FROM tokens ${where}`).get(...args).n
      return json(res, 200, { tokens: rows.map((t) => tokenView(t, price)), total })
    }
    if ((m = path.match(/^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
      const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m[1])
      if (!t) return json(res, 404, { error: 'Not a Cashtags coin' })
      // Market figures refresh in the background: the page never waits on pump.fun or DexScreener.
      if (now() - (t.market_at ?? 0) > 60) memo(`mkt:${t.mint}`, 60_000, () => refreshMarket(db, conn, t.mint, price)).catch(() => {})
      const fresh = t
      const outflows = db.prepare("SELECT * FROM outflows WHERE mint = ? AND state = 'landed' ORDER BY time DESC LIMIT 30").all(t.mint)
      // $CASHTAG buyback + burn rounds (api/buyback.mjs): every burn listed with its transaction
      let buybacks = null
      if (t.mint === buybackConfig(env).mint.toBase58()) {
        ensureBuybackTables(db)
        const rows = db.prepare("SELECT at, lamports, tokens, sig, burn_sig, status FROM buybacks WHERE kind = 'buy' ORDER BY at DESC LIMIT 200").all()
        const tot = buybackTotals(db)
        buybacks = { count: tot.rounds, solSpent: tot.solSpent, tokensBurned: tot.tokensBurned, rounds: rows.map((r) => ({ at: Math.floor(r.at / 1000), sol: Number(r.lamports) / 1e9, tokens: Number(r.tokens) / 1e6, buyTx: r.sig, burnTx: r.burn_sig, burned: r.status === 'burned' })) }
      }
      // X Money payouts that took this coin's creator rewards (12 Nov): every step with its transaction
      const xmoney = db.prepare('SELECT * FROM xmoney_payouts WHERE x_id = ? ORDER BY id DESC LIMIT 30').all(t.creator_id).map((r) => {
        const outs = db.prepare("SELECT signature, lamports, time FROM outflows WHERE x_id = ? AND mint = ? AND kind = 'payout' AND destination LIKE 'xmoney:%' AND state = 'landed' AND time >= ? AND time <= ?")
          .all(r.x_id, t.mint, r.created_at, r.done_at ?? r.updated_at ?? now())
        if (!outs.length) return null
        const v = xmoneyView(r)
        const status = r.state === 'done' ? (v.paidUsd > 0 ? (r.return_usdc > 0 ? 'Partly paid; the rest went back to their balance' : `Paid to @${r.handle}'s X Money`) : (r.returned_lamports > 0 ? 'Nobody paid in time: back in their balance' : 'Ended'))
          : r.state === 'failed' ? 'Delayed' : r.state === 'listed' ? (v.paidUsd > 0 ? 'Partly paid, waiting for the rest' : 'Listed on Peer, waiting for a payer')
          : r.state === 'returning' || r.state === 'crediting' ? 'Returning to their balance' : r.state === 'bridging' ? 'Bridging to Base' : 'Preparing'
        return { id: r.id, time: r.created_at, handle: r.handle, sol: outs.reduce((s, o) => s + o.lamports, 0) / 1e9, totalSol: r.lamports / 1e9, usd: r.usdc / 1e6, paidUsd: v.paidUsd,
          status, done: r.state === 'done', collectTxs: outs.map((o) => o.signature), bridgeTx: r.relay_sig ?? null, peerOrder: r.deposit_id ?? null, creditTx: r.credit_sig ?? null }
      }).filter(Boolean)
      return json(res, 200, { token: tokenView(fresh, price), activity: outflows.map((o) => outflowView(o, price)), buybacks, xmoney, xmoneyWallet: xmoney.length ? await baseWalletAddress() : null })
    }
    if ((m = path.match(/^\/api\/creator\/([A-Za-z0-9_]{1,15}|[1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
      // a wallet account's page is its address (exact match: addresses are case-sensitive)
      const u = m[1].length > 15 ? db.prepare('SELECT * FROM users WHERE x_id = ?').get(`wallet:${m[1]}`) : db.prepare('SELECT * FROM users WHERE lower(handle) = lower(?)').get(m[1])
      const tokens = u ? db.prepare('SELECT * FROM tokens WHERE creator_id = ? ORDER BY created_at DESC').all(u.x_id) : db.prepare('SELECT * FROM tokens WHERE lower(creator_handle) = lower(?) ORDER BY created_at DESC').all(m[1])
      if (!u && !tokens.length) return json(res, 404, { error: 'No coins from this account yet' })
      const views = tokens.map((t) => tokenView(t, price))
      return json(res, 200, { creator: userView(u) ?? { id: '', handle: m[1], name: m[1], avatar: '' }, tokens: views,
        earnedSol: views.reduce((s, v) => s + v.creatorEarnedSol, 0), paidSol: views.reduce((s, v) => s + v.creatorPaidSol, 0),
        earnedUsd: views.reduce((s, v) => s + (v.feesUsd ?? 0), 0) })
    }
    // ── every payment, public (13 Nov): creator payouts, holder airdrops and X Money sends, newest first ──
    if (path === '/api/payments') {
      const kind = q.get('kind') ?? 'all'
      const cond = { all: '', creators: "AND o.kind = 'payout' AND (o.destination IS NULL OR o.destination NOT LIKE 'xmoney:%')", holders: "AND o.kind = 'airdrop'", xmoney: "AND o.kind = 'payout' AND o.destination LIKE 'xmoney:%'" }[kind]
      if (cond === undefined) throw new HttpError('Unknown kind of payment')
      const limit = int(q, 'limit', 30, 100), offset = int(q, 'offset', 0, 1_000_000)
      const rows = db.prepare(`SELECT o.*, t.symbol, t.name, t.image, t.creator_handle FROM outflows o JOIN tokens t ON t.mint = o.mint WHERE o.state = 'landed' ${cond} ORDER BY o.time DESC, o.id DESC LIMIT ? OFFSET ?`).all(limit, offset)
      const total = db.prepare(`SELECT count(*) n FROM outflows o WHERE o.state = 'landed' ${cond}`).get().n
      // totals: SOL coins only (a paired coin's rows are in its own token), plus what Pumpfun paid holders itself
      const sums = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN o.kind = 'payout' AND (o.destination IS NULL OR o.destination NOT LIKE 'xmoney:%') THEN o.lamports END), 0) creators,
          COALESCE(SUM(CASE WHEN o.kind = 'airdrop' THEN o.lamports END), 0) holders,
          COALESCE(SUM(CASE WHEN o.kind = 'payout' AND o.destination LIKE 'xmoney:%' THEN o.lamports END), 0) xmoney,
          COALESCE(SUM(o.lamports * COALESCE(o.sol_usd, 0)), 0) / 1e9 usd,
          count(DISTINCT CASE WHEN o.kind = 'payout' THEN o.x_id END) accounts
        FROM outflows o JOIN tokens t ON t.mint = o.mint WHERE o.state = 'landed' AND t.quote_mint IS NULL`).get()
      const pumpHolders = db.prepare('SELECT COALESCE(SUM(ext_out), 0) l FROM tokens WHERE quote_mint IS NULL AND native_holders = 1').get().l
      const wallets = db.prepare("SELECT count(DISTINCT i.owner) n FROM airdrop_items i JOIN outflows o ON o.id = i.outflow_id WHERE o.state = 'landed'").get().n
      return json(res, 200, {
        items: rows.map((o) => ({ ...outflowView(o, price), token: { mint: o.mint, symbol: o.symbol, name: o.name, image: o.image ?? '' }, handle: o.creator_handle, xmoney: String(o.destination ?? '').startsWith('xmoney:') })),
        total,
        totals: { creatorsSol: sums.creators / 1e9, holdersSol: sums.holders / 1e9, xmoneySol: sums.xmoney / 1e9, pumpHoldersSol: pumpHolders / 1e9,
          allSol: (sums.creators + sums.holders + sums.xmoney + pumpHolders) / 1e9, allUsd: sums.usd + lamportsToUsd(pumpHolders, price), accountsPaid: sums.accounts, walletsPaid: wallets },
      })
    }
    if (path === '/api/payments/top') {
      const rows = db.prepare(`SELECT o.x_id, COALESCE(SUM(o.lamports), 0) l, count(*) n FROM outflows o JOIN tokens t ON t.mint = o.mint
        WHERE o.state = 'landed' AND o.kind = 'payout' AND o.x_id IS NOT NULL AND t.quote_mint IS NULL GROUP BY o.x_id ORDER BY l DESC LIMIT 20`).all()
      return json(res, 200, { items: rows.map((r) => {
        const u = db.prepare('SELECT * FROM users WHERE x_id = ?').get(r.x_id)
        return { creator: userView(u) ?? { id: r.x_id, handle: '', name: '', avatar: '' }, paidSol: r.l / 1e9, paidUsd: lamportsToUsd(r.l, price), payments: r.n, owedSol: owedTo(db, r.x_id).total / 1e9 }
      }).filter((r) => r.creator.handle) })
    }
    if (path === '/api/feed') {
      const rows = db.prepare("SELECT tweet_id, author_handle, symbol, name, state, mint, url, seen_at, launched_at FROM mentions WHERE state IN ('queued', 'launching', 'launched') ORDER BY seen_at DESC LIMIT 30").all()
      return json(res, 200, { feed: rows.map((r) => ({ tweetId: r.tweet_id, handle: r.author_handle, symbol: r.symbol, name: r.name, state: r.state === 'launching' ? 'queued' : r.state, mint: r.mint, url: r.url ?? `${PUBLIC_URL}/x/${r.author_handle}`, at: r.launched_at ?? r.seen_at })) })
    }
    if ((m = path.match(/^\/api\/logos\/([a-f0-9]{32}\.(png|jpg|gif|webp))$/))) {
      const file = join(LOGO_DIR, basename(m[1]))
      if (!existsSync(file)) return json(res, 404, { error: 'not found' })
      const sq = q.get('sq') === '0' ? null : squareLogo(LOGO_DIR, m[1])
      const type = sq ? 'image/webp' : { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[m[2]]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
      return createReadStream(sq ?? file).pipe(res)
    }

    // ── sign in with X ──
    if (path === '/api/auth/x/start') {
      if (!signIn) return json(res, 503, { error: 'X sign-in is not set up yet' })
      if (limited(req, 'auth', 60)) return json(res, 429, { error: 'Too many sign-in attempts' })
      const redirect = `${OAUTH_CALLBACK_BASE}/api/auth/x/callback`
      const { url: to, state, verifier } = signIn.begin(redirect, DEV ? q.get('as') : undefined)
      pendingAuth.set(state, { verifier, returnTo: safeReturnPath(q.get('return')), at: Date.now() })
      for (const [k, v] of pendingAuth) if (Date.now() - v.at > 600_000) pendingAuth.delete(k)
      setCookie(res, 'ct_auth', state, 600)
      res.writeHead(302, { location: to }); return res.end()
    }
    if (path === '/api/auth/x/callback') {
      const state = q.get('state'), code = q.get('code')
      const p = pendingAuth.get(state)
      if (!p || !code || cookie(req, 'ct_auth') !== state) { res.writeHead(302, { location: '/account?error=signin' }); return res.end() }
      pendingAuth.delete(state)
      try {
        const identity = await signIn.complete(code, p.verifier, `${OAUTH_CALLBACK_BASE}/api/auth/x/callback`)
        upsertUser(db, { id: identity.id, handle: identity.handle, name: identity.name, avatar: identity.avatar })
        const sid = randomBytes(24).toString('base64url')
        db.prepare('INSERT INTO sessions (id, x_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sid, String(identity.id), now(), now() + SESSION_DAYS * 86400)
        setCookie(res, SID, sid, SESSION_DAYS * 86400)
        setCookie(res, 'ct_auth', '', 0)
        res.writeHead(302, { location: p.returnTo }); return res.end()
      } catch (e) {
        res.writeHead(302, { location: `/account?error=${encodeURIComponent(e.message.slice(0, 120))}` }); return res.end()
      }
    }
    // ── sign in with a Solana wallet (13 Nov): the wallet signs a one-time message; the account is `wallet:<address>` ──
    if (path === '/api/auth/wallet/challenge') {
      if (limited(req, 'auth', 60)) return json(res, 429, { error: 'Too many sign-in attempts' })
      let pk
      try { pk = new PublicKey(String(q.get('address') ?? '')) } catch { throw new HttpError('That is not a Solana address') }
      if (!PublicKey.isOnCurve(pk.toBytes())) throw new HttpError('That address is a program account, not a wallet')
      const nonce = randomBytes(16).toString('hex')
      const message = `${new URL(PUBLIC_URL).host} wants you to sign in with your Solana wallet:\n${pk.toBase58()}\n\nSigning in is free and sends no transaction.\n\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`
      pendingWallet.set(nonce, { address: pk.toBase58(), message, at: Date.now() })
      for (const [k, v] of pendingWallet) if (Date.now() - v.at > 600_000) pendingWallet.delete(k)
      return json(res, 200, { nonce, message })
    }
    if (path === '/api/auth/wallet' && req.method === 'POST') {
      if (limited(req, 'auth', 60)) return json(res, 429, { error: 'Too many sign-in attempts' })
      const body = await readJson(req)
      const p = pendingWallet.get(String(body.nonce ?? ''))
      // one use, ten minutes, and only for the address it was issued to
      if (p) pendingWallet.delete(String(body.nonce))
      if (!p || Date.now() - p.at > 600_000 || p.address !== String(body.address ?? '')) throw new HttpError('That sign-in expired. Try again.')
      let sig
      try { sig = Buffer.from(String(body.signature ?? ''), 'base64') } catch { sig = null }
      if (!signedBy(new PublicKey(p.address), Buffer.from(p.message, 'utf8'), sig)) throw new HttpError('The wallet did not sign the sign-in message.', 401)
      upsertUser(db, { id: `wallet:${p.address}`, handle: p.address, name: `${p.address.slice(0, 4)}…${p.address.slice(-4)}` })
      const sid = randomBytes(24).toString('base64url')
      db.prepare('INSERT INTO sessions (id, x_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sid, `wallet:${p.address}`, now(), now() + SESSION_DAYS * 86400)
      setCookie(res, SID, sid, SESSION_DAYS * 86400)
      return json(res, 200, { ok: true })
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const id = cookie(req, SID)
      if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      setCookie(res, SID, '', 0)
      return json(res, 200, { ok: true })
    }

    // ── launching on the site ──
    if (path === '/api/launch/options') {
      const o = await memo(`launch-options:${sessionUser(req)?.default_mode ?? ''}`, 15_000, () => site.options(sessionUser(req)))
      // X Money on the form: paying your own rewards to your X Money, and launching for another account (always their X Money)
      return json(res, 200, { ...o, xmoney: { enabled: xmoneyOn, minSol: xcfg.minLamports / 1e9 } })
    }
    if (path === '/api/launch/check') {
      if (limited(req, 'launch-check', 600)) return json(res, 429, { error: 'Too many checks, slow down a little' })
      return json(res, 200, await site.check({ symbol: q.get('symbol') ?? '', pair: q.get('pair') ?? '' }))
    }
    // ⭐ the X Money handle on the form, looked up on X so the launcher sees WHO it is before launching (13 Nov).
    // ⛔ A billed read (twitterapi.io): signed-in accounts only, 60 an hour per IP, every answer kept for 10 minutes.
    if (path === '/api/launch/x-user') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Sign in to look up an X account' })
      const h = String(q.get('handle') ?? '').trim().replace(/^@/, '')
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new HttpError('That is not an X handle')
      if (!x?.userInfo) return json(res, 503, { error: 'X lookups are not available right now' })
      const key = `xuser:${h.toLowerCase()}`
      if (!memoStore.has(key) && limited(req, 'x-user', 60)) return json(res, 429, { error: 'Too many lookups, try again later' })
      let info
      try { info = await memo(key, 600_000, () => x.userInfo(h)) } catch { return json(res, 503, { error: 'X could not be reached just now. Try again in a moment.' }) }
      if (!info?.id) return json(res, 200, { found: false, handle: h })
      return json(res, 200, { found: true, id: String(info.id), handle: info.handle, name: info.name ?? info.handle, avatar: info.avatar ?? '', followers: info.followers ?? null, self: String(info.id) === String(u.x_id) })
    }
    if (path === '/api/launch' && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Sign in with X to launch' })
      if (limited(req, 'launch', 30)) return json(res, 429, { error: 'Too many launch attempts, try again later' })
      return json(res, 200, await site.submit(u, await readJson(req, 6 * 1024 * 1024)))
    }
    if (path === '/api/launch/sign' && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Sign in with X to launch' })
      if (limited(req, 'launch-sign', 60)) return json(res, 429, { error: 'Too many launch attempts, try again later' })
      return json(res, 200, await site.sign(u, await readJson(req, 8 * 1024)))
    }
    if ((m = path.match(/^\/api\/launch\/(site-[a-f0-9]{18})$/))) {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      return json(res, 200, site.status(u, m[1]))
    }

    if (path === '/api/me') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      const tokens = db.prepare('SELECT * FROM tokens WHERE creator_id = ? ORDER BY created_at DESC').all(u.x_id).map((t) => tokenView(t, price))
      const owed = owedTo(db, u.x_id)
      const payouts = db.prepare("SELECT * FROM outflows WHERE x_id = ? AND kind = 'payout' AND state != 'expired' ORDER BY time DESC LIMIT 50").all(u.x_id)
      return json(res, 200, {
        user: userView(u),
        settings: {
          defaultMode: u.default_mode, payoutKind: u.payout_kind, payoutWallet: u.payout_wallet ?? '', fomoHandle: u.fomo_handle ?? '',
          payoutConfirmed: !!u.payout_confirmed, autoMinSol: u.auto_min_lamports / 1e9, launchVenue: floatOn ? (u.launch_venue ?? 'pump') : 'pump',
        },
        options: { fomo: fomo.configured, float: floatOn, xmoney: xmoneyOn, xmoneyNote: xmoneyOn ? '' : 'X Money payouts are not switched on yet. Your fees wait safely and can be claimed to a wallet.', xmoneyMinSol: xcfg.minLamports / 1e9 },
        owedSol: owed.total / 1e9, owedUsd: lamportsToUsd(owed.total, price), minWithdrawSol: Number(env.MIN_WITHDRAW_LAMPORTS ?? 10_000_000) / 1e9,
        // every asset owed, SOL first: paired coins pay their creator in the pair token
        owed: owedAssets(db, u.x_id).map((a) => ({ asset: a.asset, symbol: a.symbol, decimals: a.decimals, amount: a.units / 10 ** a.decimals, coins: a.coins.length })),
        tokens, payouts: payouts.map((o) => outflowView(o, price)),
        xmoney: db.prepare('SELECT * FROM xmoney_payouts WHERE x_id = ? ORDER BY id DESC LIMIT 20').all(u.x_id).map(xmoneyView),
      })
    }
    if (path === '/api/settings' && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      if (limited(req, 'settings', 120)) return json(res, 429, { error: 'Too many changes, try again later' })
      const body = await readJson(req)
      const set = {}
      if (body.defaultMode !== undefined) {
        if (!['creator', 'holders'].includes(body.defaultMode)) throw new HttpError('Fee mode is creator or holders')
        set.default_mode = body.defaultMode
      }
      if (body.launchVenue !== undefined) {
        if (!['pump', 'float'].includes(body.launchVenue)) throw new HttpError('Launch venue is pump or float')
        if (body.launchVenue === 'float' && !floatOn) throw new HttpError('Float launches are not switched on')
        set.launch_venue = body.launchVenue
      }
      if (body.autoMinSol !== undefined) {
        const v = Math.round(Number(body.autoMinSol) * 1e9)
        if (!Number.isFinite(v) || v < 10_000_000 || v > 1000e9) throw new HttpError('Auto-pay threshold is 0.01 to 1000 SOL')
        set.auto_min_lamports = v
      }
      if (body.payoutKind !== undefined) {
        const kind = body.payoutKind
        if (kind === 'xmoney' && isWalletUser(u)) throw new HttpError('X Money pays an X account. Sign in with X to use it.')
        if (kind === 'xmoney' && !xmoneyOn) throw new HttpError('X Money payouts are not switched on yet. Pick a wallet or claim manually.')
        if (!['claim', 'wallet', 'fomo', 'xmoney'].includes(kind)) throw new HttpError('Unknown payout option')
        set.payout_kind = kind
        if (kind === 'claim') { set.payout_confirmed = 0 }
        if (kind === 'xmoney') {
          // Peer cannot check that X Money is on for the handle: the account says so, or nothing is sent
          if (body.xmoneyOn !== true) throw new HttpError(`Confirm that X Money is turned on for @${u.handle}`)
          set.payout_confirmed = 1; set.payout_wallet = null; set.fomo_handle = null
        }
        if (kind === 'wallet') {
          let pk
          try { pk = new PublicKey(String(body.payoutWallet ?? '').trim()) } catch { throw new HttpError('That is not a Solana address') }
          if (!PublicKey.isOnCurve(pk.toBytes())) throw new HttpError('That address is a program account, not a wallet')
          const info = await conn.getAccountInfo(pk).catch(() => null)
          if (info && !info.owner.equals(SystemProgram.programId)) throw new HttpError('That address is a token or program account, not a wallet')
          set.payout_wallet = pk.toBase58(); set.payout_confirmed = 1; set.fomo_handle = null
        }
        if (kind === 'fomo') {
          if (!fomo.configured) throw new HttpError('FOMO payouts are not set up yet')
          if (limited(req, 'fomo', 20)) return json(res, 429, { error: 'Too many lookups, try again later' })
          const h = String(body.fomoHandle ?? '').trim().replace(/^@/, '')
          if (!/^[A-Za-z0-9_.]{1,30}$/.test(h)) throw new HttpError('Enter your FOMO handle')
          const [found] = await fomo.lookup(h)
          if (!found?.wallet) throw new HttpError('No FOMO account with a Solana wallet under that handle')
          // ⭐ Confirmed on chain: a FOMO wallet's own transactions are co-signed by FOMO (api/providers/fomo.mjs).
          const ok = await isFomoWallet(conn, found.wallet).catch(() => false)
          set.fomo_handle = found.handle ?? h; set.payout_wallet = found.wallet; set.payout_confirmed = ok ? 1 : 0
        }
      }
      if (!Object.keys(set).length) throw new HttpError('Nothing to change')
      set.settings_at = now()
      set.payout_auto = 0 // the account chose for itself
      const cols = Object.keys(set)
      db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE x_id = ?`).run(...cols.map((c) => set[c]), u.x_id)
      const after = db.prepare('SELECT * FROM users WHERE x_id = ?').get(u.x_id)
      return json(res, 200, { ok: true, payoutConfirmed: !!after.payout_confirmed, payoutWallet: after.payout_wallet ?? '' })
    }
    if ((m = path.match(/^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})\/mode$/)) && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m[1])
      if (!t) return json(res, 404, { error: 'Not a Cashtags coin' })
      if (t.creator_id !== u.x_id) return json(res, 403, { error: 'Only the account that launched this coin can change it' })
      if (t.own_creator) return json(res, 409, { error: 'This coin\'s creator is its own wallet on pump.fun, so its fees are not managed here.' })
      if (t.native_holders) return json(res, 409, { error: 'This coin launched with Pumpfun holder rewards, which Pumpfun makes permanent. Its fees always go to holders.' })
      if (t.quote_mint) return json(res, 409, { error: `This coin is paired with $${t.quote_symbol || 'its pair token'}, so its creator rewards are paid in that token to its creator and cannot be switched to holders.` })
      const { mode } = await readJson(req)
      if (!['creator', 'holders'].includes(mode)) throw new HttpError('Fee mode is creator or holders')
      if (mode === t.mode) return json(res, 200, { ok: true, mode })
      if (limited(req, `mode:${t.mint}`, 12)) return json(res, 429, { error: 'Too many switches for this coin, try again later' })
      // Fees already in the coin's wallet belong to the mode they arrived under: book them before switching.
      await settleBeforeSwitch(t)
      try { db.prepare('UPDATE tokens SET mode = ?, mode_at = ? WHERE mint = ?').run(mode, now(), t.mint) } finally { unlockCoin(db, t.mint) }
      return json(res, 200, { ok: true, mode })
    }
    if (path === '/api/withdraw' && req.method === 'POST') {
      const u = sessionUser(req)
      if (!u) return json(res, 401, { error: 'Not signed in' })
      if (!keeper || !seed) return json(res, 503, { error: 'Payouts are not set up yet' })
      if (limited(req, 'withdraw', 10)) return json(res, 429, { error: 'Too many withdrawals, try again later' })
      const body = await readJson(req)
      let dest = String(body.destination ?? '').trim() || u.payout_wallet
      let pk
      try { pk = new PublicKey(dest) } catch { throw new HttpError('Enter a Solana wallet address') }
      if (!PublicKey.isOnCurve(pk.toBytes())) throw new HttpError('That address is a program account, not a wallet')
      const info = await conn.getAccountInfo(pk).catch(() => null)
      if (info && !info.owner.equals(SystemProgram.programId)) throw new HttpError('That address is a token or program account, not a wallet')
      // `asset`: 'SOL' (default) or the mint of a pair token owed from paired coins
      const asset = String(body.asset ?? 'SOL').trim() || 'SOL'
      if (asset !== 'SOL' && !db.prepare('SELECT 1 FROM tokens WHERE creator_id = ? AND quote_mint = ?').get(u.x_id, asset)) throw new HttpError('Nothing is owed to you in that token')
      const min = asset === 'SOL' ? Number(env.MIN_WITHDRAW_LAMPORTS ?? 10_000_000) : 1
      const r = await payCreator(db, conn, { keeper, seed, xId: u.x_id, destination: pk.toBase58(), minLamports: min, cfg: kcfg, solUsd: price, asset })
      if (!r.signatures.length) throw new HttpError(r.total <= 0 ? 'Nothing to withdraw yet' : r.total < min ? `The minimum withdrawal is ${min / 1e9} SOL` : 'A payout for your coins is already in progress. Try again in a minute.', 409)
      const dec = asset === 'SOL' ? 9 : (db.prepare('SELECT quote_decimals d FROM tokens WHERE quote_mint = ? LIMIT 1').get(asset)?.d ?? 0)
      return json(res, 200, { ok: true, asset, paid: r.paid / 10 ** dec, paidSol: asset === 'SOL' ? r.paid / 1e9 : 0, pending: r.pending, signatures: r.signatures })
    }
    return json(res, 404, { error: 'Not found' })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, PUBLIC_URL)
    if (req.method === 'POST') {
      // Every write is same-site only.
      const origin = req.headers.origin
      if ((origin && origin !== SITE_ORIGIN) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused' })
    } else if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' })
    try { await route(req, res, url) }
    catch (e) {
      const status = e instanceof HttpError || e instanceof SiteError ? e.status : 500
      // a SiteError is always a sentence written for the person at the form, whatever its status
      const shown = e instanceof SiteError || status < 500
      if (!shown) console.error(`${req.method} ${url.pathname}:`, e)
      if (!res.headersSent) json(res, status, { error: shown ? e.message : 'Something went wrong' })
    }
  })

  return { server, db, conn, bot, site, x, seed, keeper, launcher, platformLauncher, rpcCounts, publicUrl: PUBLIC_URL }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env
  const app = createApp({ env })
  const port = Number(env.PORT ?? 5570)
  app.server.listen(port, '127.0.0.1', () => console.log(`cashtags api on :${port}, bot ${!app.bot ? 'OFF (LAUNCH_KEY/FEE_SEED missing)' : env.BOT === '0' ? 'off (BOT=0)' : 'on'}, x ${app.x.kind}, seed ${app.seed ? seedFingerprint(app.seed) : 'none'}, launching ${launchingOpen(app.db) ? 'OPEN' : 'closed'}, platform launcher ${app.platformLauncher ? app.platformLauncher.publicKey.toBase58() : 'the launch wallet'}`))
  setInterval(() => { if (app.rpcCounts.size) { console.log('rpc calls last hour:', JSON.stringify(Object.fromEntries(app.rpcCounts))); app.rpcCounts.clear() } }, 3600_000).unref()
  if (env.VANITY_DIR) startGrinder(app.db, { workDir: env.VANITY_DIR, bin: env.GRIND_BIN ?? 'cashtags-grind', target: Number(env.VANITY_TARGET ?? 40), threads: Number(env.VANITY_THREADS ?? 1) })
  if (app.bot && env.BOT !== '0') app.bot.start()
  // Market data for the list pages, gently: the 20 newest coins every 2 minutes.
  setInterval(async () => {
    const price = await solUsd().catch(() => 0)
    if (!price) return
    // + every graduated coin, stalest first: they are the ones still trading, and nothing else would refresh an older one
    const rows = [...app.db.prepare('SELECT mint FROM tokens ORDER BY created_at DESC LIMIT 20').all(), ...app.db.prepare('SELECT mint FROM tokens WHERE graduated = 1 ORDER BY market_at LIMIT 15').all()]
    for (const mint of new Set(rows.map((r) => r.mint))) await refreshMarket(app.db, app.conn, mint, price).catch(() => {})
  }, 120_000).unref()
  void freshCount
}
