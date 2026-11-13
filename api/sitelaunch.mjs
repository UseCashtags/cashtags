/**
 * Launching on the site (13 Nov 2026): the same coin as tagging @UseCashtags, made from a form by an account signed in with
 * X or with a wallet. The coin belongs to that account exactly as a tagged one does (fee wallet, rewards, payouts).
 *
 * ⭐ A SITE LAUNCH IS PAID BY THE LAUNCHER'S OWN WALLET (operator 13 Nov): the connected wallet is the fee payer, pays
 * Pumpfun's creation cost (~0.01 SOL) and, if asked, its own dev buy, all in ONE transaction. Launches from X stay free
 * (the launch wallet pays those). Because the launcher pays, none of the free-launch limits apply here: no follower or
 * account-age rule, no cooldown, no ceilings. Only the 24 hour cashtag rule and the blocklists remain.
 *
 *   prepare  POST /api/launch: everything is checked, the metadata pinned, a …cash mint key reserved and the transaction
 *            built with the wallet as fee payer. It is simulated, then returned UNSIGNED and kept in `site_drafts`.
 *   sign     the wallet signs and hands the transaction BACK (it never sends it). The message must be the one we built
 *            (a wallet may only add its own Lighthouse guard instructions, never one that names the mint), the wallet's
 *            signature must verify, and only then does the mint key sign and the transaction go out.
 *            ⛔ The mint key signs LAST, at submit: a transaction carrying its signature never leaves this server unsent.
 *   The launch row is written 'launching' with its signature BEFORE the send, so bot.recover() settles it from the chain
 *   after a crash like any other launch. It is ONE attempt: the wallet signed that exact message, so a failure is final
 *   and the form is simply submitted again.
 *
 * ⛔ A dev buy needs the launch lookup table (create + buy is over 1,232 bytes without it): scripts/make-launch-lut.mjs
 * creates it once and stores its address (kv `launch_lut`, or env LAUNCH_LUT). Without it the form launches without one.
 * ⛔ Dev buys are SOL pairs only: a paired create + a buy in the pair token does not fit one transaction.
 */
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { bondingCurveAddress, loadGlobal } from '../lib/pump.mjs'
import { sendUntilFate, signatureOf } from '../lib/tx.mjs'
import { now, kvGet, launchingOpen, upsertUser, DEFAULT_MODE } from './db.mjs'
import { checkGuards } from './guards.mjs'
import { imageType, storeImage } from './images.mjs'
import { feeWallet } from './feewallet.mjs'
import { issueKey } from './vanity.mjs'
import { MAX_ATTEMPTS, buildLaunchIxs, pinMetadata, pinOnce, settleAttempt, siteFields } from './launch.mjs'
import { refreshPairList, resolvePair } from './pairs.mjs'
import { NAME_MAX, SYMBOL_MAX } from './parse.mjs'

/** An account signed in with a Solana wallet instead of X: its id is `wallet:<address>`, its handle the address. */
export const isWalletUser = (u) => String(u?.x_id ?? '').startsWith('wallet:')

export class SiteError extends Error { constructor(msg, status = 400) { super(msg); this.status = status } }

export const DESC_MAX = 500
export const LINK_MAX = 120
export const IMAGE_MAX = 4 * 1024 * 1024
/** How long a prepared dev-buy launch waits for the wallet (a blockhash lives ~60-90 s). */
export const DRAFT_SECONDS = 75
/** pump.fun's total fee on a buy at launch size, measured on a mainnet clone 13 Nov (1 SOL → 34,199,203 tokens): 1.25%. */
export const LAUNCH_BUY_FEE_BPS = 125
/** What a first buy costs the buyer on top of the buy: its token account and pump.fun's volume account (measured: 0.0048 SOL). */
export const BUYER_EXTRA_LAMPORTS = 5_000_000
/** What a launch costs the wallet that makes it (measured on a mainnet clone 13 Nov: 0.0091 SOL, 0.0082 with holder rewards), rounded up. */
export const LAUNCH_COST_LAMPORTS = 10_000_000
/** Phantom's guard program: the only instructions a wallet may add to the launch it signs. */
export const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'

/** Removes characters that render as nothing and every control character but a newline. */
const clean = (s) => String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim()
const bytes = (s) => new TextEncoder().encode(s).length

function link(raw, label, hosts = null, handleBase = null) {
  let v = clean(raw).replace(/\s+/g, '')
  if (!v) return ''
  if (handleBase && /^@?[A-Za-z0-9_]{1,32}$/.test(v)) v = `${handleBase}${v.replace(/^@/, '')}`
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`
  let u
  try { u = new URL(v) } catch { throw new SiteError(`The ${label} is not a web address.`) }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) throw new SiteError(`The ${label} must be an https web address.`)
  if (hosts && !hosts.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) throw new SiteError(`The ${label} must be on ${hosts[0]}.`)
  if (u.toString().length > LINK_MAX) throw new SiteError(`The ${label} is too long (up to ${LINK_MAX} characters).`)
  return u.toString()
}

/**
 * The form's fields → a clean request, or a SiteError with a sentence the form can show. Pure: no network, no chain.
 * Everything here is permanent on chain (pump.fun metadata has no update authority), so it is checked before anything is pinned.
 */
export function validateSiteLaunch(body, { devBuyMinLamports = 1_000_000, devBuyMaxLamports = 50e9 } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const symbol = clean(b.symbol).replace(/^\$/, '').toUpperCase()
  if (!symbol) throw new SiteError('Add a ticker.')
  if (symbol.length > SYMBOL_MAX) throw new SiteError(`A ticker can be up to ${SYMBOL_MAX} letters or numbers.`)
  // the same shape X reads as a cashtag: letters and numbers, starting with a letter
  if (!/^[A-Z][A-Z0-9]*$/.test(symbol)) throw new SiteError('A ticker is letters and numbers, starting with a letter.')
  const name = clean(b.name).replace(/\s+/g, ' ') || symbol
  if (bytes(name) > NAME_MAX) throw new SiteError(`A token name can be up to ${NAME_MAX} characters.`)
  const description = clean(b.description).replace(/\n{3,}/g, '\n\n')
  if (description.length > DESC_MAX) throw new SiteError(`The description can be up to ${DESC_MAX} characters.`)
  const mode = b.mode === undefined || b.mode === null ? null : String(b.mode)
  if (mode !== null && !['creator', 'holders'].includes(mode)) throw new SiteError('Creator rewards go to you or to holders.')
  const pair = clean(b.pair)
  if (pair && !/^\$?[A-Za-z0-9.]{1,12}$/.test(pair) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pair)) throw new SiteError('Pair with a $CASHTAG from Pumpfun\'s pair list or a contract address.')

  let image = null
  if (b.image) {
    const raw = String(b.image).replace(/^data:[^,]*,/, '')
    if (raw.length > Math.ceil(IMAGE_MAX / 3) * 4 + 16) throw new SiteError('That image is over 4 MB.')
    image = Buffer.from(raw, 'base64')
    if (image.length > IMAGE_MAX) throw new SiteError('That image is over 4 MB.')
    if (!imageType(image)) throw new SiteError('The image must be a PNG, JPG, GIF or WebP.')
  }

  // the wallet that pays for the launch (and for the dev buy, if any)
  let wallet
  try { wallet = new PublicKey(String(b.wallet ?? b.devBuy?.wallet ?? '').trim()) } catch { throw new SiteError('Connect the wallet that pays for the launch.') }
  if (!PublicKey.isOnCurve(wallet.toBytes())) throw new SiteError('That address is a program account, not a wallet.')
  let devBuy = null
  if (b.devBuy && b.devBuy.sol !== undefined && String(b.devBuy.sol).trim() !== '') {
    const sol = Number(String(b.devBuy.sol).trim())
    if (!Number.isFinite(sol) || sol < 0) throw new SiteError('The dev buy must be an amount of SOL.')
    const lamports = Math.round(sol * 1e9)
    if (lamports > 0) {
      if (lamports < devBuyMinLamports) throw new SiteError(`The smallest dev buy is ${devBuyMinLamports / 1e9} SOL.`)
      if (lamports > devBuyMaxLamports) throw new SiteError(`The largest dev buy is ${devBuyMaxLamports / 1e9} SOL.`)
      devBuy = { lamports }
    }
  }
  // launching FOR another X account (their coin, their rewards, paid to their X Money): "@bob" or "bob"
  const forRaw = clean(b.forHandle).replace(/^@/, '')
  if (forRaw && !/^[A-Za-z0-9_]{1,15}$/.test(forRaw)) throw new SiteError('That is not an X handle. Write it like @name.')
  return {
    symbol, name, description, mode: forRaw ? 'creator' : mode, pair: pair || null, image, devBuy, wallet: wallet.toBase58(), forHandle: forRaw || null,
    website: link(b.website, 'website'),
    twitter: link(b.twitter, 'X link', ['x.com', 'twitter.com'], 'https://x.com/'),
    telegram: link(b.telegram, 'Telegram link', ['t.me', 'telegram.me'], 'https://t.me/'),
  }
}

const decompile = (m, keys) => m.compiledInstructions.map((ix) => ({
  program: keys.get(ix.programIdIndex)?.toBase58() ?? '?', accounts: ix.accountKeyIndexes.map((i) => keys.get(i)?.toBase58() ?? '?'), data: Buffer.from(ix.data).toString('hex'),
}))
const sameIx = (a, b) => a.program === b.program && a.data === b.data && a.accounts.length === b.accounts.length && a.accounts.every((k, i) => k === b.accounts[i])

/**
 * Is `returned` (the message the wallet signed) the launch we built (`original`)? Byte-identical is the normal case.
 * Otherwise the wallet may only have ADDED instructions of its own guard program (Phantom's Lighthouse), none of which
 * may name the mint: every instruction of ours must still be there, in order and unchanged, with the same fee payer,
 * the same signers and blockhash, and no lookup table but ours. Pure. Returns { ok, changed } or { ok: false, reason }.
 */
export function sameLaunch(original, returned, { lut = null, mint }) {
  try {
    if (Buffer.from(original.serialize()).equals(Buffer.from(returned.serialize()))) return { ok: true, changed: false }
    if (returned.version !== 0) return { ok: false, reason: 'another transaction version' }
    if (returned.recentBlockhash !== original.recentBlockhash) return { ok: false, reason: 'another blockhash' }
    const signersOf = (m) => m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58())
    const want = signersOf(original), got = signersOf(returned)
    if (got.length !== want.length || got[0] !== want[0] || want.some((k) => !got.includes(k))) return { ok: false, reason: 'other signers' }
    if (returned.addressTableLookups.some((l) => !lut || !l.accountKey.equals(lut.key))) return { ok: false, reason: 'another lookup table' }
    const tables = lut ? [lut] : []
    const ours = decompile(original, original.getAccountKeys({ addressLookupTableAccounts: tables }))
    const theirs = decompile(returned, returned.getAccountKeys({ addressLookupTableAccounts: tables }))
    const mintKey = mint.toBase58()
    let i = 0, extras = 0
    for (const ix of theirs) {
      if (i < ours.length && sameIx(ix, ours[i])) { i++; continue }
      if (ix.program !== LIGHTHOUSE) return { ok: false, reason: 'an instruction that is not part of the launch' }
      if (ix.accounts.includes(mintKey)) return { ok: false, reason: 'an added instruction that names the mint' }
      if (++extras > 4) return { ok: false, reason: 'too many added instructions' }
    }
    if (i !== ours.length) return { ok: false, reason: 'a launch instruction is missing or altered' }
    return { ok: true, changed: true }
  } catch (e) {
    return { ok: false, reason: `unreadable (${String(e?.message ?? e).slice(0, 60)})` }
  }
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
/** True when `signature` is `pubkey`'s ed25519 signature over `message`. */
export function signedBy(pubkey, message, signature) {
  try {
    if (!signature || signature.length !== 64) return false
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pubkey.toBytes())]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(message), key, Buffer.from(signature))
  } catch { return false }
}

export function createSiteLauncher({ db, conn, pump, launcher, seed, guards, env = process.env, publicUrl, logoDir, pin = pinMetadata, x = null, log = console }) {
  const devBuyMinLamports = Number(env.DEV_BUY_MIN_LAMPORTS ?? 1_000_000)
  const devBuyMaxLamports = Math.round(Number(env.DEV_BUY_MAX_SOL ?? 50) * 1e9)
  const nativeHolders = env.NATIVE_HOLDER_REWARDS !== '0'
  // the launch wallet plays no part in a site launch: the launcher's own wallet pays
  const ready = () => !!seed

  let lutHit = { at: 0, value: null }
  /** The launch lookup table, or null when none is set up (then no dev buys). A found table is kept for 5 minutes. */
  async function launchLut() {
    if (lutHit.value && Date.now() - lutHit.at < 300_000) return lutHit.value
    const addr = env.LAUNCH_LUT || kvGet(db, 'launch_lut')
    if (!addr) return null
    let key
    try { key = new PublicKey(addr) } catch { return null }
    const value = (await conn.getAddressLookupTable(key)).value
    if (value) lutHit = { at: Date.now(), value }
    return value
  }

  let curveHit = { at: 0, value: { virtualSol: 30, virtualTokens: 1_073_000_000, supply: 1_000_000_000 } }
  async function curve() {
    if (Date.now() - curveHit.at < 600_000) return curveHit.value
    try {
      const g = await loadGlobal(conn)
      curveHit = { at: Date.now(), value: { virtualSol: Number(g.initial_virtual_sol_reserves) / 1e9, virtualTokens: Number(g.initial_virtual_token_reserves) / 1e6, supply: Number(g.token_total_supply) / 1e6 } }
    } catch { curveHit.at = Date.now() - 540_000 /* the last known figures, read again in a minute */ }
    return curveHit.value
  }

  /** What the form needs to draw itself. Public. */
  async function options(user = null) {
    await refreshPairList(db, conn).catch(() => 0)
    const lut = ready() ? await launchLut().catch(() => null) : null
    return {
      open: ready() && launchingOpen(db),
      defaultMode: user?.default_mode ?? DEFAULT_MODE,
      nameMax: NAME_MAX, symbolMax: SYMBOL_MAX, descMax: DESC_MAX, imageMax: IMAGE_MAX,
      launchCostSol: LAUNCH_COST_LAMPORTS / 1e9,
      devBuy: { enabled: !!lut, minSol: devBuyMinLamports / 1e9, maxSol: devBuyMaxLamports / 1e9, feeBps: LAUNCH_BUY_FEE_BPS, extraSol: BUYER_EXTRA_LAMPORTS / 1e9 },
      curve: await curve(),
      pairs: db.prepare("SELECT mint, symbol, name FROM pair_tokens WHERE symbol IS NOT NULL AND symbol != '' ORDER BY upper(replace(symbol, '$', ''))").all()
        .map((p) => ({ mint: p.mint, symbol: String(p.symbol).replace(/^\$/, ''), name: p.name ?? '' })),
      limits: { cooldownMinutes: Math.round(guards.perAuthorCooldownSeconds / 60), minFollowers: guards.minFollowers, minAccountAgeDays: guards.minAccountAgeDays, tickerHoldHours: Math.round(guards.tickerHoldSeconds / 3600) },
    }
  }

  /** As-you-type answers: is the ticker free, can pump.fun pair with that token. Never throws for a bad input. */
  async function check({ symbol = '', pair = '' } = {}) {
    const out = { ticker: null, pair: null }
    const sym = clean(symbol).replace(/^\$/, '').toUpperCase()
    if (/^[A-Z][A-Z0-9]{0,9}$/.test(sym)) {
      let taken = null
      if (guards.blockedSymbols.includes(sym)) taken = `$${sym} is not available to launch.`
      else if (guards.tickerHoldSeconds > 0) {
        const prev = db.prepare('SELECT MAX(created_at) t FROM tokens WHERE upper(symbol) = ? AND created_at > ?').get(sym, now() - guards.tickerHoldSeconds).t
        if (prev != null) {
          const hours = Math.max(1, Math.ceil((guards.tickerHoldSeconds - (now() - prev)) / 3600))
          taken = `$${sym} was launched in the last 24 hours. Pick another ticker, or try again in ${hours} ${hours === 1 ? 'hour' : 'hours'}.`
        }
      }
      out.ticker = { symbol: sym, free: !taken, reason: taken }
    }
    const p = clean(pair)
    if (p) {
      let r
      try { r = await resolvePair(db, conn, p) } catch { r = { ok: false, code: 'pair-wait', reason: 'That pair could not be checked just now. Try again in a moment.' } }
      out.pair = !r.ok ? { ok: false, reason: r.reason } : r.quote.kind === 'sol' ? { ok: true, sol: true, symbol: 'SOL' }
        : { ok: true, sol: false, mint: r.quote.mint, symbol: r.quote.symbol ?? '', name: r.quote.name ?? '', kind: r.quote.kind }
    }
    return out
  }

  /** What still binds a launch its own wallet pays for: launching open, the blocklists and the 24 hour cashtag rule. */
  function guard(user, symbol) {
    if (!launchingOpen(db)) throw new SiteError('Launching is closed right now.', 409)
    const v = checkGuards(db, guards, { authorId: user.x_id, authorHandle: user.handle ?? '', symbol, selfPaid: true })
    // capacity rules (hourly ceiling, spacing) pace what the launch wallet spends: not this launch
    if (!v.allowed && !v.defer) throw new SiteError(v.reason, 409)
  }

  /**
   * "For @bob": resolved to X's numeric id NOW (the coin's rewards are keyed on it for ever, so never a guess), exactly
   * as a post's "for @bob" is (api/bot.mjs resolveTarget). An account that never chose a payout gets X Money set up.
   * Returns { id, handle } or null when the handle is the launcher's own (an ordinary launch).
   */
  async function resolveFor(user, handle) {
    if (!isWalletUser(user) && handle.toLowerCase() === String(user.handle ?? '').toLowerCase()) {
      // ⭐ the form's X Money choice with the launcher's OWN handle (operator 13 Nov): an ordinary creator-mode launch, and
      // an account that never chose a payout gets X Money, exactly as an account a coin is launched for does
      db.prepare("UPDATE users SET payout_kind = 'xmoney', payout_auto = 1 WHERE x_id = ? AND settings_at IS NULL AND payout_kind = 'claim'").run(String(user.x_id))
      return null
    }
    if (!x?.userInfo) throw new SiteError('Launching for another account is not available right now.', 503)
    let info
    try { info = await x.userInfo(handle) } catch { throw new SiteError(`@${handle} could not be looked up on X just now. Try again in a minute.`, 503) }
    if (!info?.id || !/^[0-9]{1,25}$/.test(String(info.id))) throw new SiteError(`@${handle} was not found on X. Check the handle.`)
    if (String(info.id) === String(user.x_id)) return null
    if (env.PLATFORM_X_ID && String(info.id) === String(env.PLATFORM_X_ID)) throw new SiteError('Tokens cannot be launched for this account. Pick someone else.')
    upsertUser(db, { id: info.id, handle: info.handle, name: info.name, avatar: info.avatar, followers: info.followers, createdAt: info.createdAt })
    db.prepare("UPDATE users SET payout_kind = 'xmoney', payout_auto = 1 WHERE x_id = ? AND settings_at IS NULL AND payout_kind = 'claim'").run(String(info.id))
    return { id: String(info.id), handle: info.handle }
  }

  const newId = () => `site-${randomBytes(9).toString('hex')}`
  const inFlight = (xId) => db.prepare("SELECT tweet_id FROM mentions WHERE author_id = ? AND source = 'site' AND state IN ('queued', 'launching') LIMIT 1").get(String(xId))

  function insertMention({ id, user, req, opts, state, pairInput = null, extra = {} }) {
    db.prepare(`INSERT INTO mentions (tweet_id, author_id, author_handle, text, url, tweeted_at, seen_at, updated_at, state, symbol, name, mode, platform, pair_input, venue, source, opts,
      reply_state, author_followers, author_created_at, mint, signature, last_valid_height, attempts, payload, for_handle, for_id)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pump', 'site', ?, 'skipped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(user.x_id), user.handle ?? '', `site launch $${req.symbol} ${req.name}`, now(), now(), now(), state, req.symbol, req.name, req.mode, pairInput, JSON.stringify(opts),
        user.followers ?? null, user.x_created_at ?? null, extra.mint ?? null, extra.signature ?? null, extra.lastValidHeight ?? null, extra.attempts ?? 0, extra.payload ?? null,
        req.target?.handle ?? null, req.target?.id ?? null)
  }

  /**
   * The form's submit: checked, built with the launcher's wallet as fee payer, simulated, and returned for that wallet to
   * sign: { id, state: 'signing', transaction (base64, unsigned), mint, expiresAt }.
   */
  async function submit(user, body) {
    if (!ready()) throw new SiteError('Launching is not set up yet.', 503)
    const req = validateSiteLaunch(body, { devBuyMinLamports, devBuyMaxLamports })
    req.mode ??= user.default_mode ?? DEFAULT_MODE
    if (inFlight(user.x_id)) throw new SiteError('Your previous launch is still going through. Give it a moment.', 409)
    guard(user, req.symbol)

    // for another account: the coin is theirs, its rewards always go to them (never to holders)
    req.target = req.forHandle ? await resolveFor(user, req.forHandle) : null
    if (req.target) req.mode = 'creator'

    // the pair, checked against the chain now so a pair Pumpfun refuses is answered on the form
    let quote = null
    if (req.pair) {
      let r
      try { r = await resolvePair(db, conn, req.pair) } catch { r = { ok: false, code: 'pair-wait' } }
      if (!r.ok) throw new SiteError(r.code === 'pair-wait' ? 'That pair could not be checked just now. Try again in a minute.' : r.reason, r.code === 'pair-wait' ? 503 : 400)
      quote = r.quote.kind === 'sol' ? null : r.quote
    }
    if (quote && req.mode === 'holders' && !nativeHolders) throw new SiteError('Paired coins with fees to holders are paused right now. Choose X Money, or pair with SOL.', 409)
    if (quote && req.devBuy) throw new SiteError('A dev buy is available on SOL pairs. Remove the pair or the dev buy.', 400)

    const opts = { description: req.description, website: req.website, twitter: req.twitter, telegram: req.telegram, forHandle: req.target?.handle ?? null, imageFile: req.image ? storeImage({ logoDir, publicUrl }, req.image).split('/').pop() : null }
    const lut = await launchLut().catch(() => null)
    if (req.devBuy && !lut) throw new SiteError('Dev buys are switched off right now. Launch without one, and buy on Pumpfun or FOMO once it is live.', 503)
    const payer = new PublicKey(req.wallet)
    const payerInfo = await conn.getAccountInfo(payer, 'confirmed')
    if (payerInfo && !payerInfo.owner.equals(SystemProgram.programId)) throw new SiteError('That address is a token or program account, not a wallet.')
    const need = LAUNCH_COST_LAMPORTS + 2_000_000 + (req.devBuy ? req.devBuy.lamports + BUYER_EXTRA_LAMPORTS : 0)
    if ((payerInfo?.lamports ?? 0) < need) throw new SiteError(`That wallet holds ${((payerInfo?.lamports ?? 0) / 1e9).toFixed(4)} SOL. This launch needs about ${(need / 1e9).toFixed(4)} SOL.`)

    const row = { symbol: req.symbol, author_handle: user.handle, opts: JSON.stringify(opts) }
    const site = siteFields({ mention: row, publicUrl, logoDir })
    const image = storeImage({ logoDir, publicUrl }, site.img.bytes)
    const pinned = await pinOnce(db, pin, { image: site.img.bytes, imageType: site.img.type, name: req.name, symbol: req.symbol, description: site.description, website: site.website, twitter: site.twitter, telegram: site.telegram })
    const holderReward = req.mode === 'holders' && nativeHolders

    // one live draft per account: an earlier one can no longer be signed
    db.prepare("UPDATE site_drafts SET state = 'expired' WHERE x_id = ? AND state = 'open'").run(String(user.x_id))
    const mintKp = issueKey(db, `site:${user.x_id}`)
    if (!mintKp) throw new SiteError('No token addresses are ready right now. Try again in a minute.', 503)
    const mint = mintKp.publicKey.toBase58()
    if (await conn.getAccountInfo(bondingCurveAddress(mintKp.publicKey), 'confirmed')) {
      db.prepare("UPDATE vanity SET state = 'burned' WHERE pubkey = ? AND state != 'launched'").run(mint)
      throw new SiteError('That did not go through. Press Launch again.', 503)
    }
    const fw = feeWallet(seed, mint).publicKey
    // ⭐ `launcher` here is the launcher's OWN wallet: it pays the creation, the fee wallet's rent floor and the fee
    const ixs = await buildLaunchIxs({ conn, pump, launcher: payer, mint: mintKp.publicKey, feeWalletPk: fw, name: req.name, symbol: req.symbol, uri: pinned.uri, holderReward, quote,
      devBuy: req.devBuy ? { user: payer, lamports: req.devBuy.lamports } : null })
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lut ? [lut] : [])
    const tx = new VersionedTransaction(message)
    let raw
    try { raw = tx.serialize() } catch { raw = null }
    if (!raw || raw.length > 1232) {
      log.error?.(`site launch: transaction is ${raw?.length ?? 'over'} bytes (lookup table out of date? run scripts/make-launch-lut.mjs)`)
      throw new SiteError(req.devBuy ? 'Dev buys are switched off right now. Launch without one, and buy once it is live.' : 'That launch could not be built just now. Try again in a moment.', 503)
    }
    // Simulated before the wallet is asked: a launch that cannot land is never offered for signing.
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
    if (sim.value.err) {
      log.error?.(`site launch: simulation refused ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-4).join(' | ')}`)
      throw new SiteError('The launch could not be built just now. Nothing was sent. Try again in a moment.', 502)
    }
    const id = newId()
    const payload = { uri: pinned.uri, image, description: site.description, imageSource: site.img.source, holderReward, ownCreator: null, quote, devBuy: req.devBuy, payer: req.wallet }
    const expiresAt = now() + DRAFT_SECONDS
    db.prepare(`INSERT INTO site_drafts (id, x_id, state, mint, wallet, lamports, message, last_valid_height, request, payload, created_at, expires_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(user.x_id), mint, req.wallet, req.devBuy?.lamports ?? 0, Buffer.from(message.serialize()).toString('base64'), lastValidBlockHeight,
        JSON.stringify({ symbol: req.symbol, name: req.name, mode: req.mode, opts, target: req.target ?? null }), JSON.stringify(payload), now(), expiresAt)
    return { id, state: 'signing', mint, transaction: Buffer.from(raw).toString('base64'), wallet: req.wallet, devBuySol: (req.devBuy?.lamports ?? 0) / 1e9, expiresAt }
  }

  /**
   * The wallet's signed transaction comes back. Checked, co-signed by the launch wallet and the mint key, recorded, sent.
   * Returns at once with { id, state: 'launching', mint, signature }; `done` (not for the client) resolves when settled.
   */
  async function sign(user, body) {
    if (!ready()) throw new SiteError('Launching is not set up yet.', 503)
    const d = db.prepare('SELECT * FROM site_drafts WHERE id = ? AND x_id = ?').get(String(body?.id ?? ''), String(user.x_id))
    if (!d) throw new SiteError('That launch was not found. Press Launch again.', 404)
    if (d.state !== 'open' || now() > d.expires_at) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)
    let tx
    try {
      const bytes = Buffer.from(String(body.transaction ?? ''), 'base64')
      if (!bytes.length || bytes.length > 1232) throw new Error('size')
      tx = VersionedTransaction.deserialize(bytes)
    } catch { throw new SiteError('The wallet returned something that is not a transaction. Nothing was sent.') }
    const original = VersionedMessage.deserialize(Buffer.from(d.message, 'base64'))
    const mintPk = new PublicKey(d.mint), buyer = new PublicKey(d.wallet)
    const lut = await launchLut().catch(() => null)
    const same = sameLaunch(original, tx.message, { lut, mint: mintPk })
    if (!same.ok) {
      log.error?.(`site launch ${d.id}: wallet returned a different message (${same.reason})`)
      throw new SiteError('Your wallet changed the transaction, so it was not sent. Try again, or use another wallet.')
    }
    const message = tx.message.serialize()
    const at = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(buyer))
    const buyerSig = at >= 0 ? tx.signatures[at] : null
    if (!signedBy(buyer, message, buyerSig)) throw new SiteError('The transaction was not signed by the connected wallet. Nothing was sent.')

    const request = JSON.parse(d.request)
    user = db.prepare('SELECT * FROM users WHERE x_id = ?').get(user.x_id)
    // the rules again, at the moment of sending: someone may have launched the ticker while the wallet prompt was open
    guard(user, request.symbol)
    if (inFlight(user.x_id)) throw new SiteError('Your previous launch is still going through. Give it a moment.', 409)
    if (await conn.getBlockHeight('confirmed') > d.last_valid_height) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)
    const key = db.prepare("SELECT secret FROM vanity WHERE pubkey = ? AND state = 'issued'").get(d.mint)
    if (!key) throw new SiteError('That launch expired before it was signed. Press Launch again.', 409)

    // ⛔ Our signature LAST: only now does the mint key sign, and the next thing that happens is the send.
    const out = new VersionedTransaction(tx.message)
    out.sign([Keypair.fromSecretKey(Buffer.from(key.secret, 'base64'))])
    out.addSignature(buyer, buyerSig)
    const raw = out.serialize(), signature = signatureOf(out)

    // ⛔ The claim and the launch row in one transaction, BEFORE the send: a draft is signed once, and from here on
    // bot.recover() can always ask the chain what happened.
    db.exec('BEGIN IMMEDIATE')
    try {
      if (db.prepare("UPDATE site_drafts SET state = 'used' WHERE id = ? AND state = 'open'").run(d.id).changes !== 1) throw new SiteError('That launch was already sent.', 409)
      insertMention({ id: d.id, user, req: request, opts: request.opts, state: 'launching',
        extra: { mint: d.mint, signature, lastValidHeight: d.last_valid_height, attempts: MAX_ATTEMPTS, payload: d.payload } })
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }

    const done = (async () => {
      const fate = await sendUntilFate(conn, { raw, signature, lastValidBlockHeight: d.last_valid_height })
      const row = db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(d.id)
      if (row.state !== 'launching') return { outcome: row.state, mint: row.mint } // recover() got there first
      const res = await settleAttempt(db, conn, { mention: row, mint: d.mint, feeWalletPk: feeWallet(seed, d.mint).publicKey, signature, fate, payload: JSON.parse(d.payload), mode: request.mode, platform: false, log })
      log.info?.(`site launch ${d.id} $${request.symbol} paid by ${d.wallet}${d.lamports ? ` with a ${d.lamports / 1e9} SOL dev buy` : ''}: ${res.outcome}${res.error ? ` (${res.error})` : ''}`)
      return res
    })().catch((e) => { log.error?.(`site launch ${d.id}: ${e.message}`); return { outcome: 'unknown', error: e.message } })
    const result = { id: d.id, state: 'launching', mint: d.mint, signature }
    Object.defineProperty(result, 'done', { value: done, enumerable: false })
    return result
  }

  /** Where one of the account's own site launches stands. */
  function status(user, id) {
    const m = db.prepare("SELECT * FROM mentions WHERE tweet_id = ? AND author_id = ? AND source = 'site'").get(String(id), String(user.x_id))
    if (m) {
      const reason = m.state === 'rejected' ? (m.reason ?? 'That one cannot launch.')
        : m.state === 'failed' ? 'The launch did not go through. Try again.' : null
      return { id: m.tweet_id, state: m.state, symbol: m.symbol, mint: m.state === 'launched' || m.state === 'launching' ? m.mint : null, signature: m.signature ?? null, reason }
    }
    const d = db.prepare('SELECT id, state, mint, expires_at FROM site_drafts WHERE id = ? AND x_id = ?').get(String(id), String(user.x_id))
    if (!d) throw new SiteError('Not found', 404)
    return { id: d.id, state: d.state === 'open' && now() <= d.expires_at ? 'signing' : 'expired', mint: null, signature: null, reason: null }
  }

  return { options, check, submit, sign, status, launchLut }
}
