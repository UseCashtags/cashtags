/**
 * Launches one queued mention as a pump.fun coin, paid by the platform's launch wallet.
 *
 *   transfer   launch wallet → the coin's fee wallet: the rent floor, so pump.fun's small first collections land
 *              (a system account under 890,880 lamports refuses a deposit below that)
 *   create_v2  mint = a fresh `…cash` key from the vanity pool, creator = the coin's fee wallet (api/feewallet.mjs)
 *
 * Order of writes (crash safety): the mention row gets mint + signature + last valid height BEFORE the first send, so a
 * restart can always ask the chain what happened (api/bot.mjs recover). A coin is recorded only once its bonding curve
 * exists on chain AND names our fee wallet as creator.
 *
 * ⛔ pump.fun metadata has no update authority: name, ticker, image
 * and links are permanent. Only content-addressed IPFS links on a gateway wallets can read are written.
 * ⛔ A mint key is used for ONE attempt. Once a transaction carrying it has left this server, anyone could pre-create
 * the curve's token account and make that address unlaunchable, so a failed or expired attempt burns its key.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_2022, ata, bondingCurveAddress, buyExactSolInIx, createV2Ix, curveCreator, decodeBondingCurve, holderRewardsAddress, loadGlobal, resolveQuote } from '../lib/pump.mjs'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { buildTx, sendUntilFate, fateOf } from '../lib/tx.mjs'
import { feeWallet } from './feewallet.mjs'
import { issueKey, markLaunched } from './vanity.mjs'
import { now, kvDel, LAUNCHING_CLOSED, DEFAULT_MODE } from './db.mjs'
import { fetchImage, imageType, storeImage } from './images.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { F as FLOAT_PDA, TOKEN as SPL_TOKEN, WSOL as FLOAT_WSOL, floatLaunchIx, launchState } from '../lib/float.mjs'

export const RENT_FLOOR = 890_880
/** pump.fun create rent (~0.02 SOL) + the fee wallet's rent floor + fees: the launch wallet keeps this much spare. */
export const MIN_LAUNCH_BALANCE = 35_000_000

export class LaunchError extends Error { constructor(msg, { code = 'launch', retry = true } = {}) { super(msg); this.code = code; this.retry = retry } }

/** Only X's own media host is fetched for a coin image: nothing a tweet links to elsewhere. */
export function isAllowedImageHost(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'pbs.twimg.com') } catch { return false }
}

/** The Cashtags $ logo (api/assets/project-token.png): the picture of any coin launched without one. */
export const brandLogo = () => readFileSync(new URL('./assets/project-token.png', import.meta.url))

/** (Unused since 10 Nov: no-picture launches get brandLogo.) A tile with the ticker's first character, white on black. */
export function letterTile(symbol) {
  const ch = String(symbol || '?')[0].toUpperCase()
  const name = /[A-Z0-9]/.test(ch) ? ch : 'unknown'
  const p = new URL(`./assets/letters/${name}.png`, import.meta.url)
  return existsSync(p) ? readFileSync(p) : readFileSync(new URL('./assets/letters/unknown.png', import.meta.url))
}

/**
 * The coin's picture, in this order (operator 10 Nov), each tried until one downloads as a real image:
 *   1. the image attached to the launch post itself
 *   2. the image of the post it replies to (looked up only when 1 is missing or unusable: one billed read)
 *   3. the image of the post it quotes (already in the mention, free)
 *   4. the Cashtags logo (operator 10 Nov: no image anywhere = our logo)
 * Only X's own media host is fetched. Returns { bytes, type, source }.
 */
export async function chooseImage({ mention, x, fetchImpl = fetchImage }) {
  const tryUrl = async (url) => {
    if (!url || !isAllowedImageHost(url)) return null
    // X serves the original with ?name=large; a 4096px original is not needed for a 512px logo.
    const u = new URL(url); u.searchParams.set('name', 'medium')
    try { const bytes = await fetchImpl(u.toString(), 10_000); const type = imageType(bytes); return type ? { bytes, type } : null } catch { return null }
  }
  let got = await tryUrl(mention.mediaUrl)
  if (got) return { ...got, source: 'tweet' }
  if (mention.inReplyToId && x?.fetchTweet) {
    let parentUrl = null
    try { parentUrl = (await x.fetchTweet(mention.inReplyToId))?.mediaUrl ?? null } catch {}
    got = await tryUrl(parentUrl)
    if (got) return { ...got, source: 'parent' }
  }
  got = await tryUrl(mention.quotedMediaUrl)
  if (got) return { ...got, source: 'quoted' }
  return { bytes: brandLogo(), type: 'image/png', source: 'logo' }
}

/**
 * Pins the image, then pump.fun's metadata JSON, on Pinata (pump.fun closed its open uploader 19 Oct 2026). Links are
 * written on IPFS_GATEWAY (gateway.pinata.cloud): ipfs.io 403s wallets and indexers.
 */
export async function pinMetadata({ image, imageType: type, name, symbol, description, website, twitter, telegram }, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.PINATA_JWT) throw new LaunchError('PINATA_JWT is not set', { code: 'config', retry: true })
  const gateway = String(env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '')
  const pin = async (blob, fileName) => {
    const f = new FormData()
    f.append('file', blob, fileName); f.append('network', 'public'); f.append('name', fileName)
    const r = await fetchImpl('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { authorization: `Bearer ${env.PINATA_JWT}` }, body: f, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new LaunchError(`Pinata refused ${fileName} (${r.status})`)
    const cid = (await r.json().catch(() => ({})))?.data?.cid
    if (!/^[A-Za-z0-9]{40,100}$/.test(cid || '')) throw new LaunchError('Pinata returned no content hash')
    return cid
  }
  const ext = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[type] ?? '.jpg'
  const imageCid = await pin(new Blob([image], { type }), `${symbol}-image${ext}`)
  const metadata = { name, symbol, description, image: `${gateway}/${imageCid}`, showName: true, createdOn: 'https://pump.fun', twitter, website, ...(telegram ? { telegram } : {}) }
  const metaCid = await pin(new Blob([JSON.stringify(metadata)], { type: 'application/json' }), `${symbol}-metadata.json`)
  const uri = `${gateway}/${metaCid}`
  if (uri.length > 200) throw new LaunchError('metadata address too long', { retry: false })
  return { uri, imageUri: metadata.image }
}

/** The website every coin carries (operator 10 Nov): exactly this, trailing slash included. */
export const SITE_URL = 'https://cashtags.family/'

/** The coin's X link: the post that launched it, always as https://x.com/<handle>/status/<id>. */
export function tweetLink(mention) {
  const id = String(mention.tweet_id ?? mention.id ?? '')
  const handle = String(mention.author_handle ?? mention.authorHandle ?? '').replace(/^@/, '')
  if (/^\d+$/.test(id) && /^[A-Za-z0-9_]{1,15}$/.test(handle)) return `https://x.com/${handle}/status/${id}`
  return mention.url ?? ''
}

export function describe({ symbol, handle, publicUrl, forHandle = null }) {
  if (forHandle) return `$${symbol} was launched on X for @${forHandle} by @${handle} with @UseCashtags. Its creator rewards go to @${forHandle}: ${publicUrl.replace(/^https?:\/\//, '')}`
  return `$${symbol} was launched on X by @${handle} with @UseCashtags. Creator rewards and payouts: ${publicUrl.replace(/^https?:\/\//, '')}`
}

/**
 * The launch instructions: rent floor to the fee wallet, then create_v2, then (site launches only) a dev buy.
 * ⭐ `devBuy` { user, lamports } (13 Nov): the buyer's OWN wallet buys in the same transaction, right after the create,
 * so nobody can trade before it. The launch wallet still pays the creation; the buyer pays the buy, its own token
 * account and nothing else (every instruction is built here, the buyer only signs).
 */
export async function buildLaunchIxs({ conn, pump, launcher, mint, feeWalletPk, name, symbol, uri, holderReward = false, ownCreator = false, quote = null, devBuy = null, priorityMicroLamports = 150_000 }) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: devBuy ? 400_000 : 260_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
  ]
  // A native holder-reward coin's fees never reach our fee wallet (pump.fun makes its holder-rewards PDA the creator).
  // An own-wallet creator (the platform token) is a funded wallet already: no rent floor to prefund.
  // A paired coin's fees arrive in its quote token: the fee wallet needs no SOL (the keeper opens its token account).
  const paired = !!quote && quote.kind !== 'sol'
  if (!holderReward && !ownCreator && !paired) {
    const have = await conn.getBalance(feeWalletPk, 'confirmed')
    if (have < RENT_FLOOR) ixs.push(SystemProgram.transfer({ fromPubkey: launcher, toPubkey: feeWalletPk, lamports: RENT_FLOOR - have }))
  }
  ixs.push(await createV2Ix(pump, { mint, user: launcher, name, symbol, uri, creator: feeWalletPk, holderReward, quote: paired ? quote : null }))
  if (devBuy) {
    if (paired) throw new LaunchError('a dev buy needs a SOL pair', { code: 'dev-buy-pair', retry: false })
    const buyer = new PublicKey(devBuy.user)
    // pump.fun replaces a holder-reward coin's creator with its holder-rewards PDA: the buy must name that vault
    const creator = holderReward ? holderRewardsAddress(mint) : feeWalletPk
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(buyer, ata(buyer, mint, TOKEN_2022), buyer, mint, TOKEN_2022))
    ixs.push(await buyExactSolInIx(pump, await loadGlobal(conn), { mint, user: buyer, creator, lamports: BigInt(devBuy.lamports) }))
  }
  return ixs
}

/** The launch transaction, signed by the launch wallet and the mint. */
export async function buildLaunchTx({ conn, pump, launcher, mintKp, feeWalletPk, name, symbol, uri, holderReward = false, ownCreator = false, quote = null, lookupTables = [], priorityMicroLamports = 150_000 }) {
  const ixs = await buildLaunchIxs({ conn, pump, launcher: launcher.publicKey, mint: mintKp.publicKey, feeWalletPk, name, symbol, uri, holderReward, ownCreator, quote, priorityMicroLamports })
  return buildTx(conn, { payer: launcher.publicKey, ixs, signers: [launcher, mintKp], lookupTables })
}

/**
 * True when `mint`'s bonding curve exists as we built it: creator = our fee wallet, or for a native holder-reward launch
 * is_holder_reward set and creator = pump.fun's holder-rewards PDA (pump.fun replaces the creator we pass, proven 10 Nov).
 */
export async function curveIsOurs(conn, mint, feeWalletPk, holderReward = false, quoteMint = null) {
  const info = await conn.getAccountInfo(bondingCurveAddress(new PublicKey(mint)), 'confirmed')
  if (!info) return false
  const c = decodeBondingCurve(info.data)
  // a paired launch must have landed against the pair it was built for
  if (quoteMint && !c.quote_mint.equals(new PublicKey(quoteMint))) return false
  if (!holderReward) return !!curveCreator(info.data)?.equals(feeWalletPk)
  return JSON.stringify(c.is_holder_reward).includes('true') && c.creator.equals(holderRewardsAddress(new PublicKey(mint)))
}

/**
 * Records a landed launch (idempotent). `mode` is what the coin's fees do from its first trade.
 * The platform launch (the operator's project token) also opens launching, in the same transaction as its record.
 */
export function recordLaunch(db, { mention, mint, feeWalletPk, signature, uri, image, description, mode, platform = false, nativeHolders = false, ownCreator = false, quote = null, venue = 'pump' }) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT OR IGNORE INTO tokens (mint, name, symbol, image, metadata_uri, description, creator_id, creator_handle, tweet_id, tweet_url,
      fee_wallet, mode, mode_at, launch_sig, created_at, platform, native_holders, own_creator, quote_mint, quote_symbol, quote_decimals, quote_program, venue)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mint, mention.name, mention.symbol, image, uri, description, mention.for_id ?? mention.author_id, mention.for_id ? mention.for_handle : mention.author_handle, mention.tweet_id, mention.url,
        feeWalletPk.toBase58(), nativeHolders ? 'holders' : mode, now(), signature, now(), platform ? 1 : 0, nativeHolders ? 1 : 0, ownCreator ? 1 : 0,
        quote?.mint ?? null, quote?.mint ? (quote.symbol ?? null) : null, quote?.mint ? quote.decimals : null, quote?.mint ? quote.tokenProgram : null, venue)
    // launched FOR someone: the coin (and its rewards) is theirs; who asked is kept for the page
    if (mention.for_id) db.prepare('UPDATE tokens SET launched_by_id = ?, launched_by_handle = ? WHERE mint = ?').run(mention.author_id, mention.author_handle, mint)
    db.prepare(`UPDATE mentions SET state = 'launched', mint = ?, signature = ?, launched_at = COALESCE(launched_at, ?), reply_state = CASE WHEN reply_state = 'none' THEN 'pending' ELSE reply_state END, updated_at = ? WHERE tweet_id = ?`)
      .run(mint, signature, now(), now(), mention.tweet_id)
    markLaunched(db, mint)
    if (platform) {
      kvDel(db, LAUNCHING_CLOSED)
      db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('platform_mint', ?)").run(mint)
      // everyone who waited for the opening is eligible at once (still paced by the spacing rule and the ramp)
      db.prepare("UPDATE mentions SET next_try_at = 0 WHERE state = 'queued' AND code = 'launching-closed'").run()
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

export const MAX_ATTEMPTS = 3

/**
 * One attempt at launching a mention already claimed into state 'launching' (api/bot.mjs). Returns
 * { outcome: 'launched' | 'retry' | 'failed' | 'unknown', mint?, error? }. Never leaves the row ambiguous: 'unknown'
 * keeps mint + signature on it for recover().
 */
export async function launchMention({ db, conn, pump, launcher, platformLauncher = null, seed, mention, x, publicUrl, logoDir, lookupTables, pin = pinMetadata, log = console }) {
  const attempt = mention.attempts + 1
  db.prepare('UPDATE mentions SET attempts = ?, updated_at = ? WHERE tweet_id = ?').run(attempt, now(), mention.tweet_id)
  const user = db.prepare('SELECT default_mode FROM users WHERE x_id = ?').get(mention.author_id)
  // a coin launched FOR someone always pays its creator rewards to them (their X Money), never to holders
  const mode = mention.for_id ? 'creator' : mention.mode ?? user?.default_mode ?? DEFAULT_MODE
  const platform = !!mention.platform
  // ⭐ Operator 10 Nov: the platform token is launched FROM the operator's own wallet (PLATFORM_LAUNCH_KEY), which is also
  // its pump.fun creator: its creator fees go to that wallet (claimed on pump.fun), never to holders or a fee wallet.
  const own = platform && platformLauncher ? platformLauncher : null
  if (own) launcher = own

  const balance = await conn.getBalance(launcher.publicKey, 'confirmed')
  if (balance < MIN_LAUNCH_BALANCE) return { outcome: 'retry', error: `launch wallet holds ${balance / 1e9} SOL`, hold: true }

  // Image + metadata first (cheap to redo; nothing on chain yet). Stored payload makes a retry reuse the same pin.
  let payload = mention.payload ? JSON.parse(mention.payload) : null
  if (!payload?.uri) {
    // The platform token always carries the staged logo (api/assets/project-token.png) and its own description.
    const staged = platform ? new URL('./assets/project-token.png', import.meta.url) : null
    // ⭐ a launch made on the site (13 Nov) carries its own picture, description and links (api/sitelaunch.mjs)
    const site = mention.source === 'site' && !platform ? siteFields({ mention, publicUrl, logoDir }) : null
    const img = site ? site.img : staged && existsSync(staged)
      ? { bytes: readFileSync(staged), type: 'image/png', source: 'project' }
      : await chooseImage({ mention: { ...mention, mediaUrl: mention.image_url, inReplyToId: mention.in_reply_to_id, quotedMediaUrl: mention.quoted_image_url }, x })
    const image = storeImage({ logoDir, publicUrl }, img.bytes)
    const description = site ? site.description : platform
      ? `Launch tokens from X: tag @UseCashtags with a $CASHTAG. ${publicUrl.replace(/^https?:\/\//, '')}`
      : describe({ symbol: mention.symbol, handle: mention.author_handle, publicUrl, forHandle: mention.for_id ? mention.for_handle : null })
    const pinned = site
      ? await pinOnce(db, pin, { image: img.bytes, imageType: img.type, name: mention.name, symbol: mention.symbol, description, website: site.website, twitter: site.twitter, telegram: site.telegram })
      : await pin({ image: img.bytes, imageType: img.type, name: mention.name, symbol: mention.symbol, description, website: SITE_URL, twitter: tweetLink(mention) })
    payload = { uri: pinned.uri, image, description, imageSource: img.source }
    db.prepare('UPDATE mentions SET payload = ?, updated_at = ? WHERE tweet_id = ?').run(JSON.stringify(payload), now(), mention.tweet_id)
  }
  // ⭐ Float (operator 11 Nov): its own launch path (lib/float.mjs); the platform token is always a pump.fun coin
  if (mention.venue === 'float' && !platform) return launchFloat({ db, conn, launcher, seed, mention: { ...mention, attempts: attempt }, payload, mode, log })

  // Holders at launch = pump.fun's native holder rewards (operator 10 Nov): locked, paid by pump.fun. Decided once per
  // attempt and kept in the payload, so a recovery after a crash checks the curve the way it was built.
  const holderReward = !own && mode === 'holders' && process.env.NATIVE_HOLDER_REWARDS !== '0'
  // The pair, re-read from the chain now (a pump coin pair may have moved from its curve to its pool since the queue
  // checked it). The platform token is always SOL-paired.
  let quote = null
  if (!own && mention.pair) {
    const saved = JSON.parse(mention.pair)
    const listed = db.prepare('SELECT mint FROM pair_tokens').all().map((r) => r.mint)
    const fresh = await resolveQuote(conn, saved.mint, listed.length ? { listed } : {})
    if (!fresh.ok && fresh.code === 'pair-wait') return { outcome: 'retry', error: `pair ${saved.symbol ?? saved.mint}: ${fresh.reason}`, hold: true }
    if (!fresh.ok || fresh.kind === 'sol') {
      // nothing was sent: the request is answered with the reason instead of launched against a pair pump.fun refuses
      db.prepare("UPDATE mentions SET state = 'rejected', code = 'bad-pair', reason = ?, reply_state = 'pending', updated_at = ? WHERE tweet_id = ? AND state = 'launching' AND signature IS NULL")
        .run(fresh.reason ?? 'Pumpfun cannot pair with that token.', now(), mention.tweet_id)
      return { outcome: 'rejected', error: fresh.reason }
    }
    quote = { ...fresh, symbol: saved.symbol ?? null, name: saved.name ?? null }
  }
  if (quote && mode === 'holders' && !holderReward) {
    // holders of a paired coin can only be paid by pump.fun's holder rewards (we never airdrop a pair token)
    db.prepare("UPDATE mentions SET state = 'rejected', code = 'bad-pair', reason = ?, reply_state = 'pending', updated_at = ? WHERE tweet_id = ? AND state = 'launching' AND signature IS NULL")
      .run('Paired coins are paused right now. Post again without a pair to launch against SOL.', now(), mention.tweet_id)
    return { outcome: 'rejected', error: 'holder rewards off, paired holders coin refused' }
  }
  payload = { ...payload, holderReward, ownCreator: own ? own.publicKey.toBase58() : null, quote }
  db.prepare('UPDATE mentions SET payload = ? WHERE tweet_id = ?').run(JSON.stringify(payload), mention.tweet_id)
  const mintKp = issueKey(db, `tweet:${mention.tweet_id}:${attempt}`)
  if (!mintKp) return { outcome: 'retry', error: 'no …cash keys ready', hold: true }
  const mint = mintKp.publicKey.toBase58()
  const fw = own ? own.publicKey : feeWallet(seed, mint).publicKey
  // The curve could still be taken by someone who saw this key (it was never sent before, but check anyway).
  if (await conn.getAccountInfo(bondingCurveAddress(mintKp.publicKey), 'confirmed')) {
    db.prepare("UPDATE vanity SET state = 'burned' WHERE pubkey = ?").run(mint)
    return { outcome: 'retry', error: 'mint address already used' }
  }
  const built = await buildLaunchTx({ conn, pump, launcher, mintKp, feeWalletPk: fw, name: mention.name, symbol: mention.symbol, uri: payload.uri, holderReward, ownCreator: !!own, quote, lookupTables })
  // ⛔ Written BEFORE the send: from here on the chain may have it.
  db.prepare('UPDATE mentions SET mint = ?, signature = ?, last_valid_height = ?, updated_at = ? WHERE tweet_id = ?')
    .run(mint, built.signature, built.lastValidBlockHeight, now(), mention.tweet_id)
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  return settleAttempt(db, conn, { mention: { ...mention, attempts: attempt }, mint, feeWalletPk: fw, signature: built.signature, fate: f, payload, mode: own ? 'creator' : mode, platform, log })
}

/** Turns a chain answer into the mention's next state. Shared by launchMention and recover(). */
export async function settleAttempt(db, conn, { mention, mint, feeWalletPk: fw, signature, fate, payload, mode, platform, log = console }) {
  if (fate.fate === 'landed') {
    const holderReward = !!payload?.holderReward
    const ownCreator = payload?.ownCreator ?? null
    if (ownCreator) { fw = new PublicKey(ownCreator); mode = 'creator' }
    const quote = payload?.quote ?? null
    if (payload?.venue === 'float') {
      const st = await launchState(conn, mint).catch(() => null)
      if (!st || !st.fee_receiver.equals(fw)) {
        log.error?.(`float launch ${signature} landed but ${mint} does not name our fee wallet`)
        return failAttempt(db, mention, mint, 'landed without our Float launch')
      }
      // a token-paired Float coin can only pay its creator (we never airdrop a pair token)
      recordLaunch(db, { mention, mint, feeWalletPk: fw, signature, uri: payload?.uri, image: payload?.image, description: payload?.description, mode: quote?.mint ? 'creator' : mode, platform, quote, venue: 'float' })
      return { outcome: 'launched', mint }
    }
    if (!(await curveIsOurs(conn, mint, fw, holderReward, quote?.mint ?? null))) {
      // Landed, but no curve naming our wallet: never record a coin we cannot prove.
      log.error?.(`launch ${signature} landed but curve ${mint} is not ours`)
      return failAttempt(db, mention, mint, 'landed without our curve')
    }
    recordLaunch(db, { mention, mint, feeWalletPk: fw, signature, uri: payload?.uri, image: payload?.image, description: payload?.description, mode, platform, nativeHolders: holderReward, ownCreator: !!ownCreator, quote })
    return { outcome: 'launched', mint }
  }
  if (fate.fate === 'unknown') return { outcome: 'unknown', mint, error: fate.error }
  return failAttempt(db, mention, mint, fate.error ?? JSON.stringify(fate.err ?? fate.fate))
}

function failAttempt(db, mention, mint, error) {
  db.prepare("UPDATE vanity SET state = 'burned' WHERE pubkey = ? AND state != 'launched'").run(mint)
  const final = mention.attempts >= MAX_ATTEMPTS
  db.prepare(`UPDATE mentions SET state = ?, mint = NULL, signature = NULL, last_valid_height = NULL, code = ?, reason = ?,
    reply_state = CASE WHEN ? AND source = 'x' THEN 'pending' ELSE reply_state END, updated_at = ? WHERE tweet_id = ?`)
    .run(final ? 'failed' : 'queued', final ? 'launch-failed' : 'retrying', String(error).slice(0, 300), final ? 1 : 0, now(), mention.tweet_id)
  return { outcome: final ? 'failed' : 'retry', error }
}

export { fateOf }

/** What a site launch's metadata carries: the uploaded picture (else the Cashtags logo), the form's description and links. */
export function siteFields({ mention, publicUrl, logoDir }) {
  const o = mention.opts ? JSON.parse(mention.opts) : {}
  let img = null
  if (o.imageFile && /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(o.imageFile)) {
    const file = join(logoDir, o.imageFile)
    if (existsSync(file)) { const bytes = readFileSync(file); const type = imageType(bytes); if (type) img = { bytes, type, source: 'upload' } }
  }
  img ??= { bytes: brandLogo(), type: 'image/png', source: 'logo' }
  const handle = String(mention.author_handle ?? '').replace(/^@/, '')
  // a wallet account's handle is its address: shown short, and never as an X link
  const by = /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `@${handle}` : `${handle.slice(0, 4)}…${handle.slice(-4)}`
  return {
    img,
    description: o.description || (o.forHandle
      ? `$${mention.symbol} was launched for @${o.forHandle} by ${by} on ${publicUrl.replace(/^https?:\/\//, '')}. Its creator rewards go to @${o.forHandle}.`
      : `$${mention.symbol} was launched by ${by} on ${publicUrl.replace(/^https?:\/\//, '')}`),
    website: o.website || SITE_URL,
    twitter: o.twitter || (/^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : ''),
    telegram: o.telegram || '',
  }
}

/** Pins once per exact content: the same fields and picture again (a retry, a refused wallet prompt) reuse the stored link. */
export async function pinOnce(db, pin, fields) {
  const hash = createHash('sha256').update(JSON.stringify([fields.name, fields.symbol, fields.description, fields.website, fields.twitter, fields.telegram ?? '', createHash('sha256').update(fields.image).digest('hex')])).digest('hex')
  const hit = db.prepare('SELECT uri, image FROM pins WHERE hash = ?').get(hash)
  if (hit) return { uri: hit.uri, imageUri: hit.image }
  const pinned = await pin(fields)
  db.prepare('INSERT OR REPLACE INTO pins (hash, uri, image, at) VALUES (?, ?, ?, ?)').run(hash, pinned.uri, pinned.imageUri ?? '', now())
  return pinned
}

/**
 * ⭐ A Float launch (lib/float.mjs): Float's `launch` from the shared launch wallet. The mint is Float's PDA
 * ["mint", launcher, nonce]: the nonce is fixed per attempt and kept in the payload BEFORE the send, so a crash after the
 * send finds the same mint. The coin's fee wallet (derived like every fee wallet) is its fee receiver: Float sends it the
 * dev share (5% of the trading fee) in the pair token; for a SOL pair the keeper unwraps it into plain SOL.
 * ⛔ max_takeover 0: a ticker already on Float makes the launch fail (we never pay Float's 2..5 SOL takeover fee).
 */
async function launchFloat({ db, conn, launcher, seed, mention, payload, mode, log = console }) {
  const pair = mention.pair ? JSON.parse(mention.pair) : null
  const quoteMint = pair?.mint ? new PublicKey(pair.mint) : FLOAT_WSOL
  const attempt = mention.attempts
  let nonce = payload.floatNonce && payload.floatAttempt === attempt ? BigInt(payload.floatNonce) : null
  if (nonce == null) {
    const r = new BigUint64Array(1); crypto.getRandomValues(r); nonce = r[0]
    payload = { ...payload, venue: 'float', floatNonce: String(nonce), floatAttempt: attempt, quote: pair?.mint ? pair : null }
    db.prepare('UPDATE mentions SET payload = ? WHERE tweet_id = ?').run(JSON.stringify(payload), mention.tweet_id)
  }
  const mint = FLOAT_PDA.coinMint(launcher.publicKey, nonce)
  const fw = feeWallet(seed, mint.toBase58()).publicKey
  const { ix } = await floatLaunchIx(conn, { creator: launcher.publicKey, name: mention.name, ticker: mention.symbol, uri: payload.uri, feeReceiver: fw, quoteMint, tier: 0, nonce })
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }), ix]
  // a SOL coin's fee wallet receives unwrapped SOL later: it must already hold the rent floor
  if (!pair?.mint) ixs.push(SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: fw, lamports: RENT_FLOOR }))
  const built = await buildTx(conn, { payer: launcher.publicKey, ixs, signers: [launcher] })
  // ⛔ Written BEFORE the send: from here on the chain may have it.
  db.prepare('UPDATE mentions SET mint = ?, signature = ?, last_valid_height = ?, updated_at = ? WHERE tweet_id = ?')
    .run(mint.toBase58(), built.signature, built.lastValidBlockHeight, now(), mention.tweet_id)
  const f = await sendUntilFate(conn, { raw: built.raw, signature: built.signature, lastValidBlockHeight: built.lastValidBlockHeight })
  // the ticker was taken on Float between the queue's check and this send: answer it, never retry into a fee
  if (f.fate === 'rejected' && /0x1797|0x177b|TakeoverFeeTooHigh|TickerProtected/.test(`${f.error ?? ''} ${(f.logs ?? []).join(' ')}`)) {
    db.prepare(`UPDATE mentions SET state = 'rejected', code = 'float-ticker-taken', reason = ?, mint = NULL, signature = NULL, last_valid_height = NULL,
      reply_state = 'pending', updated_at = ? WHERE tweet_id = ? AND state = 'launching'`)
      .run(`$${mention.symbol.toUpperCase()} is already taken on Float. Pick another cashtag, or launch it on Pumpfun.`, now(), mention.tweet_id)
    return { outcome: 'rejected', error: 'ticker taken on Float' }
  }
  return settleAttempt(db, conn, { mention, mint: mint.toBase58(), feeWalletPk: fw, signature: built.signature, fate: f, payload, mode, platform: false, log })
}

