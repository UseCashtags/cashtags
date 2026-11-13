// End to end on a local validator with pump.fun cloned from mainnet (./validator.sh, port 8891):
// tweet → launch (real create_v2, creator = derived fee wallet) → reply → trades → keeper collects + credits →
// creator withdraws through the API → creator switches the coin to holders → more trades → keeper airdrops pro rata.
// Every number is checked against what the chain says.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { openDb, buckets, owedTo, now, kvSet, launchingOpen, LAUNCHING_CLOSED } from '../api/db.mjs'
import { readFileSync } from 'node:fs'
import { createHash as hash } from 'node:crypto'
import { createApp } from '../api/server.mjs'
import { FixtureX } from '../api/x.mjs'
import { feeWallet } from '../api/feewallet.mjs'
import { keeperPass, keeperConfig, holdersOf } from '../api/keeper.mjs'
import { RENT_FLOOR, buildLaunchTx } from '../api/launch.mjs'
import { TOKEN_2022, TOKEN_PROGRAM_ID, resolveQuote, ata, bondingCurveAddress, buyExactQuoteInV2Ix, buyExactSolInIx, creatorVaultAddress, curveCreator, decodeBondingCurve, holderRewardsAddress, loadGlobal, pumpProgram, tokenAccountAmount } from '../lib/pump.mjs'
import { createMintToInstruction } from '@solana/spl-token'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
import { xmoneyPass, xmoneyConfig } from '../api/xmoney.mjs'
import { SystemProgram } from '@solana/web3.js'
import { F as FLOAT_F, WSOL as FLOAT_WSOL, floatBuyIx, floatLaunchIx, launchState, readFloat, ataOf as floatAta } from '../lib/float.mjs'
import { createSyncNativeInstruction } from '@solana/spl-token'

const RPC = `http://127.0.0.1:${process.env.LOCAL_RPC_PORT ?? 8891}`
const conn = new Connection(RPC, 'confirmed')
const pump = pumpProgram(conn)
const SEED = 'ab'.repeat(32)
const PORT = 5591
const BASE = `http://127.0.0.1:${PORT}`
const launcher = Keypair.generate(), keeper = Keypair.generate(), platformWallet = Keypair.generate()
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
const payee = Keypair.generate()
// the DEV stub signs `alice` in as this id (api/providers/stub.mjs)
const ALICE = BigInt('0x' + createHash('sha256').update('x:alice').digest('hex').slice(0, 12)).toString()

async function fund(to, sol) { const s = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
async function buy(trader, mint, creator, sol) {
  const global = await loadGlobal(conn)
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, mint, TOKEN_2022), trader.publicKey, mint, TOKEN_2022),
    await buyExactSolInIx(pump, global, { mint, user: trader.publicKey, creator, lamports: BigInt(Math.round(sol * 1e9)) })]
  const b = await buildTx(conn, { payer: trader.publicKey, ixs, signers: [trader] })
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  assert.equal(f.fate, 'landed', JSON.stringify(f))
}

let app, db, x, mint, fw, cookie = ''
const pins = []
const pin = async ({ name, symbol, description, twitter, website }) => {
  pins.push({ name, symbol, description, twitter, website })
  // a worst-case-length gateway link
  return { uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, imageUri: 'https://gateway.pinata.cloud/ipfs/bafkreiimage' }
}
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, { redirect: 'manual', ...opts, headers: { origin: BASE, cookie, 'content-type': 'application/json', ...(opts.headers ?? {}) } })
  const sc = r.headers.getSetCookie?.() ?? []
  for (const c of sc) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (k === 'ct_sid' || k === 'ct_auth') cookie = [...cookie.split('; ').filter((p) => p && !p.startsWith(k + '=')), `${k}=${v}`].join('; ') }
  return r
}

test.before(async () => {
  for (const k of [launcher, keeper, platformWallet, ...traders]) await fund(k.publicKey, 20)
  db = openDb(':memory:')
  // a test mint key in the vanity pool (real ones end in `cash`; the grinder is exercised separately)
  const k = Keypair.generate()
  db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now())
  x = new FixtureX('UseCashtags')
  app = createApp({
    env: { PUBLIC_URL: BASE, DEV_STUBS: '1', PLATFORM_X_ID: '2120180575294099456', PROJECT_TICKER: 'CASHTAG', PROJECT_NAME: 'Cashtag', PER_AUTHOR_COOLDOWN_SECONDS: '0', FEE_SEED: SEED, START_OPEN: '1', LAUNCH_RAMP: '0', MIN_SPACING_SECONDS: '0', REPLY_SPACING_SECONDS: '0',
      XMONEY_ENABLED: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'ct-')), HOLDERS_MIN_LAMPORTS: '1000000', MIN_COLLECT_LAMPORTS: '1', HOLDER_MIN_TOKENS: '1000', MIN_WITHDRAW_LAMPORTS: '1000000' },
    db, conn, x, keeper, launcher, platformLauncher: platformWallet, pin,
  })
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r))
})
test.after(() => app?.server.close())

test('a tweet becomes a pump.fun coin whose creator is its derived fee wallet, and the bot replies with the CA', async () => {
  // alice chose "Fees to me" on the site before posting (the default is holders: tested at the end)
  db.prepare("INSERT INTO users (x_id, handle, seen_at, default_mode, settings_at) VALUES (?, 'alice', 0, 'creator', 1)").run(ALICE)
  x.mentions.push({ id: '9001', text: '@UseCashtags launch $DOGE Doge Coin', createdAt: now(), authorHandle: 'alice', authorId: ALICE, authorName: 'Alice',
    authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'https://x.com/alice/status/9001' })
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  mint = new PublicKey(out.queue.mint)
  fw = feeWallet(Buffer.from(SEED, 'hex'), mint).publicKey
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint.toBase58())
  assert.equal(t.fee_wallet, fw.toBase58())
  assert.equal(t.creator_id, ALICE)
  assert.equal(t.mode, 'creator')
  const curve = await conn.getAccountInfo(bondingCurveAddress(mint))
  assert.ok(curveCreator(curve.data).equals(fw), 'pump.fun creator is the fee wallet')
  assert.equal(await conn.getBalance(fw), RENT_FLOOR, 'fee wallet prefunded to the rent floor')
  assert.equal(pins[0].twitter, 'https://x.com/alice/status/9001')
  assert.equal(pins[0].website, 'https://cashtags.family/')
  assert.match(pins[0].description, /@alice/)
  assert.equal(x.replies.length, 1)
  assert.equal(x.replies[0].to, '9001')
  assert.ok(x.replies[0].text.includes(mint.toBase58()))
  // the same tweet again is not a second launch
  assert.equal((await app.bot.tick()).queue.idle, 'queue empty')
})

test('trades pay creator fees; the keeper collects them into the fee wallet and credits the creator bucket exactly', async () => {
  await buy(traders[0], mint, fw, 2)
  await buy(traders[1], mint, fw, 1)
  const before = await conn.getBalance(fw)
  const r = await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000' }), log: { info() {}, error: console.error } })
  const after = await conn.getBalance(fw)
  const b = buckets(db, mint.toBase58())
  assert.ok(after > before, 'fees collected')
  assert.equal(b.creator, after - RENT_FLOOR, JSON.stringify(r))
  assert.equal(b.holders, 0)
  console.log(`creator fees on 3 SOL of buys: ${b.creator / 1e9} SOL`)
})

test('the creator signs in with X, sees what is owed, and withdraws it to a wallet', async () => {
  let r = await api('/api/auth/x/start?as=alice&return=/account')
  assert.equal(r.status, 302)
  r = await api(new URL(r.headers.get('location')).pathname + new URL(r.headers.get('location')).search)
  assert.equal(r.status, 302)
  const me = await (await api('/api/me')).json()
  assert.equal(me.user.handle, 'alice')
  const owed = buckets(db, mint.toBase58()).creator
  assert.equal(Math.round(me.owedSol * 1e9), owed)
  // a stranger's withdrawal: not signed in
  const anon = await fetch(`${BASE}/api/withdraw`, { method: 'POST', headers: { origin: BASE }, body: '{}' })
  assert.equal(anon.status, 401)
  // cross-site POST refused
  const xs = await fetch(`${BASE}/api/withdraw`, { method: 'POST', headers: { origin: 'https://evil.example', cookie }, body: '{}' })
  assert.equal(xs.status, 403)
  r = await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ destination: payee.publicKey.toBase58() }) })
  const body = await r.json()
  assert.equal(r.status, 200, JSON.stringify(body))
  assert.equal(await conn.getBalance(payee.publicKey), owed)
  assert.equal(buckets(db, mint.toBase58()).creator, 0)
  assert.equal(await conn.getBalance(fw), RENT_FLOOR, 'the fee wallet keeps exactly its floor')
  // nothing left: a second withdrawal is refused, not sent
  r = await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ destination: payee.publicKey.toBase58() }) })
  assert.equal(r.status, 409)
})

test('settings: X Money is refused with a reason, a wallet is saved, a program address is refused', async () => {
  let r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'xmoney' }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /X Money/)
  r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'wallet', payoutWallet: bondingCurveAddress(mint).toBase58() }) })
  assert.equal(r.status, 400)
  r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'wallet', payoutWallet: payee.publicKey.toBase58(), autoMinSol: 0.01 }) })
  assert.equal(r.status, 200)
  // saved means stored: a fresh read returns exactly what was sent, and a switch to manual and back sticks too
  let me = (await (await api('/api/me')).json()).settings
  assert.equal(me.payoutKind, 'wallet'); assert.equal(me.payoutWallet, payee.publicKey.toBase58()); assert.equal(me.autoMinSol, 0.01); assert.equal(me.payoutConfirmed, true)
  assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'claim' }) })).status, 200)
  assert.equal((await (await api('/api/me')).json()).settings.payoutKind, 'claim')
  assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'wallet', payoutWallet: payee.publicKey.toBase58(), autoMinSol: 0.25 }) })).status, 200)
  me = (await (await api('/api/me')).json()).settings
  assert.equal(me.payoutKind, 'wallet'); assert.equal(me.autoMinSol, 0.25)
  assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'wallet', payoutWallet: payee.publicKey.toBase58(), autoMinSol: 0.01 }) })).status, 200)
  r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ defaultMode: 'holders' }) })
  assert.equal(r.status, 200)
  assert.equal(db.prepare('SELECT default_mode FROM users WHERE x_id = ?').get(ALICE).default_mode, 'holders')
})

let preSwitch = 0
test('switching the coin to holders: fees before the switch stay the creator s, fees after go to holders, airdropped pro rata', async () => {
  // fees that arrive before the switch (uncollected) — then a trade, then the switch books what the wallet holds
  await buy(traders[2], mint, fw, 0.5)
  // someone else cannot switch it
  const other = await fetch(`${BASE}/api/token/${mint.toBase58()}/mode`, { method: 'POST', headers: { origin: BASE }, body: JSON.stringify({ mode: 'holders' }) })
  assert.equal(other.status, 401)
  const creatorInBefore = buckets(db, mint.toBase58()).creatorIn
  const r = await api(`/api/token/${mint.toBase58()}/mode`, { method: 'POST', body: JSON.stringify({ mode: 'holders' }) })
  assert.equal(r.status, 200, await r.text())
  // the 0.5 SOL trade's fee (made before the switch, not yet collected) was collected and booked to the creator
  preSwitch = buckets(db, mint.toBase58()).creatorIn - creatorInBefore
  assert.ok(preSwitch > 1_000_000, `pre-switch fees credited to the creator: ${preSwitch}`)
  assert.equal(buckets(db, mint.toBase58()).holdersIn, 0)
  assert.equal(db.prepare('SELECT mode FROM tokens WHERE mint = ?').get(mint.toBase58()).mode, 'holders')
  // more trades: these fees are the holders'
  await buy(traders[0], mint, fw, 3)
  await buy(traders[1], mint, fw, 3)
  const tokensBefore = new Map((await holdersOf(conn, mint.toBase58())).map((h) => [h.owner, h.amount]))
  const solBefore = new Map(await Promise.all(traders.map(async (t) => [t.publicKey.toBase58(), await conn.getBalance(t.publicKey)])))
  const payeeBefore = await conn.getBalance(payee.publicKey)
  const paidBefore = db.prepare("SELECT COALESCE(SUM(lamports), 0) l FROM outflows WHERE kind = 'payout' AND state = 'landed'").get().l
  const res = await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000', HOLDER_MIN_TOKENS: '1000' }), log: { info() {}, error: console.error } })
  const b = buckets(db, mint.toBase58())
  const air = res.find((x) => x.airdrop)?.airdrop
  assert.ok(air && air.sent > 0, JSON.stringify(res))
  assert.equal(b.holders, b.holdersIn - air.sent)
  // the curve's own token account (a PDA owner) got nothing; the three traders got their pro-rata shares
  const eligible = [...tokensBefore].filter(([o]) => PublicKey.isOnCurve(new PublicKey(o).toBytes()))
  const sum = eligible.reduce((s, [, a]) => s + a, 0n)
  for (const t of traders) {
    const want = Number((BigInt(air.sent) * tokensBefore.get(t.publicKey.toBase58())) / sum)
    const got = (await conn.getBalance(t.publicKey)) - solBefore.get(t.publicKey.toBase58())
    assert.ok(Math.abs(got - want) <= eligible.length, `${t.publicKey.toBase58().slice(0, 6)} got ${got} want ${want}`)
  }
  // the creator's pre-switch fees stay theirs; below the 0.01 SOL auto-pay minimum they wait (not paid, not lost)
  const creatorAfter = buckets(db, mint.toBase58())
  assert.equal(creatorAfter.creator, preSwitch)
  const paidAfter = db.prepare("SELECT COALESCE(SUM(lamports), 0) l FROM outflows WHERE kind = 'payout' AND state = 'landed'").get().l
  assert.equal((await conn.getBalance(payee.publicKey)) - payeeBefore, paidAfter - paidBefore)
  // the books balance to the lamport: wallet = floor + both buckets
  assert.equal(await conn.getBalance(fw), RENT_FLOOR + creatorAfter.creator + creatorAfter.holders)
  console.log(`holders airdrop: ${air.sent / 1e9} SOL to ${air.recipients} wallets`)
})

test('public pages: token view, creator view, feed, stats', async () => {
  const t = await (await fetch(`${BASE}/api/token/${mint.toBase58()}`)).json()
  assert.equal(t.token.symbol, 'DOGE')
  assert.equal(t.token.mode, 'holders')
  assert.ok(t.token.holdersPaidSol > 0 && t.token.creatorPaidSol > 0)
  assert.equal(t.token.links.fomo, `https://fomo.family/tokens/solana/${mint.toBase58()}`)
  const c = await (await fetch(`${BASE}/api/creator/alice`)).json()
  assert.equal(c.tokens.length, 1)
  const f = await (await fetch(`${BASE}/api/feed`)).json()
  assert.equal(f.feed[0].symbol, 'DOGE')
  const s = await (await fetch(`${BASE}/api/stats`)).json()
  assert.equal(s.launches, 1)
  assert.ok(s.launchingOpen)
})

test('auto-pay: once the creator fees pass their threshold the keeper pays the saved wallet', async () => {
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ autoMinSol: 0.01 }) })
  await api(`/api/token/${mint.toBase58()}/mode`, { method: 'POST', body: JSON.stringify({ mode: 'creator' }) })
  for (let i = 0; i < 2; i++) await buy(traders[i], mint, fw, 3)
  const before = await conn.getBalance(payee.publicKey)
  const owedBefore = buckets(db, mint.toBase58()).creator
  await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000000' }), log: { info() {}, error: console.error } })
  const b = buckets(db, mint.toBase58())
  assert.equal(b.creator, 0, 'paid out')
  const got = (await conn.getBalance(payee.publicKey)) - before
  assert.ok(got > owedBefore && got >= 10_000_000, `auto-paid ${got}`)
  assert.equal(await conn.getBalance(fw), RENT_FLOOR + b.holders)
})

test('worst-case launch fits one transaction, and a crash after the send is recovered from the chain', async () => {
  for (let i = 0; i < 2; i++) {
    const k = Keypair.generate()
    db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now())
  }
  x.mentions.push({ id: '9002', text: '@UseCashtags launch $ABCDEFGHIJ "' + 'W'.repeat(32) + '"', createdAt: now(), authorHandle: 'bob_' + 'b'.repeat(11), authorId: '424242', authorName: 'Bob',
    authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'https://x.com/bob/status/9002' })
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'ABCDEFGHIJ'").get()
  assert.equal(t.name, 'W'.repeat(32))

  // crash recovery: a row left 'launching' with a landed signature is settled by recover(), not relaunched
  const row = db.prepare("SELECT * FROM mentions WHERE tweet_id = '9002'").get()
  db.prepare("DELETE FROM tokens WHERE mint = ?").run(t.mint)
  db.prepare("UPDATE mentions SET state = 'launching' WHERE tweet_id = '9002'").run()
  await app.bot.recover()
  assert.equal(db.prepare("SELECT state FROM mentions WHERE tweet_id = '9002'").get().state, 'launched')
  assert.ok(db.prepare('SELECT 1 FROM tokens WHERE mint = ?').get(row.mint))
  // and one whose blockhash expired without landing goes back to the queue with its key burned
  const ghost = Keypair.generate()
  db.prepare("INSERT INTO vanity (pubkey, secret, created_at, state) VALUES (?, ?, ?, 'issued')").run(ghost.publicKey.toBase58(), Buffer.from(ghost.secretKey).toString('base64'), now())
  db.prepare(`INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, symbol, name, mint, signature, last_valid_height, attempts, updated_at)
    VALUES ('9003', '5', 'carol', '@UseCashtags $GHOST', 0, 0, 'launching', 'GHOST', 'GHOST', ?, ?, 1, 1, 0)`).run(ghost.publicKey.toBase58(), '5'.repeat(88))
  await app.bot.recover()
  const g = db.prepare("SELECT state, mint FROM mentions WHERE tweet_id = '9003'").get()
  assert.equal(g.state, 'queued')
  assert.equal(g.mint, null)
  assert.equal(db.prepare('SELECT state FROM vanity WHERE pubkey = ?').get(ghost.publicKey.toBase58()).state, 'burned')
})

test('the platform launch: closed launching queues strangers; @UseCashtags posting $CASHTAG launches "Cashtag" with the staged logo and opens launching', async () => {
  for (let i = 0; i < 2; i++) {
    const k = Keypair.generate()
    db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now())
  }
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE state = 'queued'").run() // leftovers from the recovery test
  kvSet(db, LAUNCHING_CLOSED, 'until the project token launches')
  const base = { createdAt: now(), authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false }
  x.mentions.push({ ...base, id: '9101', text: '@UseCashtags $EARLY', authorHandle: 'dave', authorId: '777', authorName: 'Dave', url: 'https://x.com/dave/status/9101' })
  let out = await app.bot.tick()
  assert.equal(out.queue.deferred, 'launching-closed', JSON.stringify(out))
  x.mentions.push({ ...base, id: '9102', text: '@UseCashtags launch $CASHTAG the official one, lfg', authorHandle: 'UseCashtags', authorId: '2120180575294099456', authorName: 'Cashtags', authorFollowers: 0, authorCreatedAt: now(), url: 'https://x.com/UseCashtags/status/9102' })
  // ⛔ posted twice before the first launches: only ONE may ever launch from the platform wallet
  x.mentions.push({ ...base, id: '9103', text: '@UseCashtags $CASHTAG', authorHandle: 'UseCashtags', authorId: '2120180575294099456', authorName: 'Cashtags', authorFollowers: 0, authorCreatedAt: now(), url: 'https://x.com/UseCashtags/status/9103' })
  const launcherBefore = await conn.getBalance(launcher.publicKey), platformBefore = await conn.getBalance(platformWallet.publicKey)
  out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', 'platform: ' + JSON.stringify(out))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'CASHTAG'").get()
  // operator 10 Nov: launched FROM the platform wallet, which is also its pump.fun creator (creator fees to that wallet)
  assert.equal(await conn.getBalance(launcher.publicKey), launcherBefore, 'the shared launch wallet paid nothing')
  assert.ok(await conn.getBalance(platformWallet.publicKey) < platformBefore, 'the platform wallet paid')
  const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(new PublicKey(t.mint)))).data)
  assert.ok(curve.creator.equals(platformWallet.publicKey), 'creator = the platform wallet')
  assert.ok(!JSON.stringify(curve.is_holder_reward ?? null).includes('true'), 'not a holder-reward coin')
  assert.equal(t.own_creator, 1); assert.equal(t.native_holders, 0); assert.equal(t.mode, 'creator')
  assert.equal(t.fee_wallet, platformWallet.publicKey.toBase58())
  const sig = db.prepare('SELECT signature FROM mentions WHERE tweet_id = ?').get('9102').signature
  const ltx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  assert.equal(ltx.transaction.message.staticAccountKeys[0].toBase58(), platformWallet.publicKey.toBase58(), 'fee payer = the platform wallet')
  await buy(traders[0], new PublicKey(t.mint), platformWallet.publicKey, 0.5)
  const kp = await keeperPass({ db, conn, pump: pumpProgram(conn), keeper, seed: app.seed, cfg: keeperConfig({}), log: { info() {}, error() {} } })
  assert.ok(!kp.some((r) => r.mint === t.mint), 'the keeper leaves the platform coin alone')
  const tok = await (await api(`/api/token/${t.mint}`)).json()
  assert.equal(tok.token.ownCreator, true)
  const sw = await api(`/api/token/${t.mint}/mode`, { method: 'POST', body: JSON.stringify({ mode: 'holders' }) })
  assert.ok(sw.status >= 400, 'its fee setting cannot be switched on the site')
  assert.equal(t.name, 'Cashtag')
  assert.equal(t.platform, 1)
  assert.equal(t.creator_id, '2120180575294099456')
  assert.ok(launchingOpen(db), 'launching opened by the platform launch')
  assert.equal(db.prepare('SELECT count(*) n FROM mentions WHERE platform = 1').get().n, 1, 'one platform request, not two')
  assert.equal(db.prepare("SELECT count(*) n FROM tokens WHERE own_creator = 1").get().n, 1, 'one token from the platform wallet')
  // even a platform row that slipped into the queue is refused once the platform token exists
  db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, symbol, name, platform, updated_at) VALUES ('9104', '2120180575294099456', 'UseCashtags', '@UseCashtags $CASHTAG', 0, 0, 'queued', 'CASHTAG', 'Cashtag', 1, 0)").run()
  const pBefore = await conn.getBalance(platformWallet.publicKey)
  const again = await app.bot.tick()
  assert.equal(again.queue.rejected, 'platform-done', JSON.stringify(again))
  assert.equal(await conn.getBalance(platformWallet.publicKey), pBefore, 'the platform wallet paid nothing more')
  const pinned = pins.at(-1)
  assert.equal(pinned.name, 'Cashtag')
  assert.match(pinned.description, /tag @UseCashtags/)
  const want = hash('sha256').update(readFileSync(new URL('../api/assets/project-token.png', import.meta.url))).digest('hex').slice(0, 32)
  assert.ok(t.image.includes(want), 'the staged logo, not a letter tile')
  // a second $CASHTAG post from the account is an ordinary request now (one-shot), and the stranger goes next
  out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  assert.equal(db.prepare("SELECT state FROM mentions WHERE tweet_id = '9101'").get().state, 'launched')
})

test('holders (the default for anyone who never chose, and the saved choice of alice here): pump.fun native holder rewards, locked, keeper leaves it', async () => {
  const k = Keypair.generate()
  db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now())
  // alice (signed in earlier) made holders her default in the settings test
  assert.equal(db.prepare('SELECT default_mode FROM users WHERE x_id = ?').get(ALICE).default_mode, 'holders')
  db.prepare("UPDATE mentions SET launched_at = launched_at - 7200 WHERE author_id = ?").run(ALICE)
  x.mentions.push({ id: '9201', text: '@UseCashtags $HODL Holders Only', createdAt: now(), authorHandle: 'alice', authorId: ALICE, authorName: 'Alice',
    authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'https://x.com/alice/status/9201' })
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const m = new PublicKey(out.queue.mint)
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m.toBase58())
  assert.equal(t.native_holders, 1)
  assert.equal(t.mode, 'holders')
  const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(m))).data)
  assert.equal(curve.is_holder_reward, true)
  assert.ok(curve.creator.equals(holderRewardsAddress(m)), 'pump.fun holder-rewards PDA is the creator')
  assert.equal(await conn.getBalance(new PublicKey(t.fee_wallet)), 0, 'no rent wasted on an unused fee wallet')
  // a trade pays pump.fun's holder-rewards vault
  const vault = creatorVaultAddress(holderRewardsAddress(m))
  const before = await conn.getBalance(vault)
  await buy(traders[2], m, holderRewardsAddress(m), 1)
  assert.ok((await conn.getBalance(vault)) > before)
  // locked: the creator cannot switch it
  const r = await api(`/api/token/${m.toBase58()}/mode`, { method: 'POST', body: JSON.stringify({ mode: 'creator' }) })
  assert.equal(r.status, 409)
  // the keeper does not touch it
  const res = await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1' }), log: { info() {}, error: console.error } })
  assert.ok(!res.some((x) => x.mint === m.toBase58()))
  const view = await (await fetch(`${BASE}/api/token/${m.toBase58()}`)).json()
  assert.equal(view.token.nativeHolders, true)
  // the reply says holders
  assert.match(x.replies.at(-1).text, /^\$HODL [a-zA-Z ]+\.\n\nCA: [1-9A-HJ-NP-Za-km-z]{32,44}$/)
})

test('an account that never chose gets the default: holders, via pump.fun holder rewards', async () => {
  const k = Keypair.generate()
  db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now())
  x.mentions.push({ id: '9301', text: '@UseCashtags $NEWB', createdAt: now(), authorHandle: 'newbie', authorId: '880088', authorName: 'Newbie',
    authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'https://x.com/newbie/status/9301' })
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(out.queue.mint)
  assert.equal(t.native_holders, 1)
  assert.equal(db.prepare("SELECT default_mode FROM users WHERE x_id = '880088'").get().default_mode, 'holders')
})


/* ── custom pairs (11 Nov) ── BONK is on pump.fun's pair list; its local fixture has a mint authority we hold. */
const BONK = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
const bonkAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('./fixtures/bonk-authority.json', import.meta.url)))))
const bonkOf = async (owner) => { const i = await conn.getAccountInfo(ata(owner, BONK, TOKEN_PROGRAM_ID)); return i ? Number(tokenAccountAmount(i.data)) : 0 }
async function sendIxs(ixs, signers) {
  const b = await buildTx(conn, { payer: signers[0].publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs], signers })
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  assert.equal(f.fate, 'landed', JSON.stringify(f))
}
async function buyWithBonk(trader, mint, creator, units) {
  const global = await loadGlobal(conn)
  const tAta = ata(trader.publicKey, BONK, TOKEN_PROGRAM_ID)
  await sendIxs([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, tAta, trader.publicKey, BONK, TOKEN_PROGRAM_ID), createMintToInstruction(BONK, tAta, bonkAuthority.publicKey, BigInt(units))], [trader, bonkAuthority])
  await sendIxs([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, mint, TOKEN_2022), trader.publicKey, mint, TOKEN_2022),
    await buyExactQuoteInV2Ix(pump, global, { mint, user: trader.publicKey, creator, quoteMint: BONK, quoteProgram: TOKEN_PROGRAM_ID, amountIn: BigInt(units) })], [trader])
}
const addVanity = () => { const k = Keypair.generate(); db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now()) }
const mention = (id, text, handle, authorId) => ({ id, text, createdAt: now(), authorHandle: handle, authorId, authorName: handle, authorFollowers: 900, authorCreatedAt: now() - 900 * 86400,
  authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: `https://x.com/${handle}/status/${id}` })
const quietKeeper = (extra = {}) => keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: { ...keeperConfig({ MIN_COLLECT_LAMPORTS: '1' }), collectQSeconds: 0, ...extra }, log: { info() {}, error: console.error } })

test('a pair, Fees to me: "paired with $BONK" launches against BONK; fees are collected, credited and paid out IN BONK, never mixed with SOL', async () => {
  // the pair list as the daily refresh would store it (locally the mints' metadata accounts are not cloned)
  db.prepare("INSERT OR REPLACE INTO pair_tokens (mint, symbol, name, decimals, program, updated_at) VALUES (?, 'Bonk', 'Bonk', 5, ?, ?)").run(BONK.toBase58(), TOKEN_PROGRAM_ID.toBase58(), now())
  kvSet(db, 'pair_list_at', now())
  addVanity()
  db.prepare("UPDATE users SET default_mode = 'creator' WHERE x_id = ?").run(ALICE)
  db.prepare('UPDATE mentions SET launched_at = launched_at - 3 * 86400 WHERE author_id = ?').run(ALICE) // past the daily limit window
  const statsBefore = await (await fetch(`${BASE}/api/stats`)).json()
  x.mentions.push(mention('9401', '@UseCashtags launch $FROG Frog Club paired with $BONK', 'alice', ALICE))
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const m = new PublicKey(out.queue.mint)
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m.toBase58())
  assert.equal(t.quote_mint, BONK.toBase58()); assert.equal(t.quote_symbol, 'Bonk'); assert.equal(t.quote_decimals, 5); assert.equal(t.name, 'Frog Club')
  assert.equal(t.mode, 'creator'); assert.equal(t.native_holders, 0)
  const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(m))).data)
  assert.ok(curve.quote_mint.equals(BONK), 'the curve trades against BONK')
  assert.ok(curve.creator.equals(new PublicKey(t.fee_wallet)), 'the fee wallet is its creator')
  assert.equal(await conn.getBalance(new PublicKey(t.fee_wallet)), 0, 'a paired coin\'s fee wallet needs no SOL')
  assert.match(x.replies.at(-1).text, /^\$FROG is live paired with \$BONK\n\nCA: [1-9A-HJ-NP-Za-km-z]{32,44}$/)
  assert.ok(x.replies.at(-1).text.includes(m.toBase58()))

  // trades in BONK → the keeper opens the fee wallet's BONK account, collects, credits BONK units; alice's saved wallet is
  // paid automatically (once a day per token)
  await buyWithBonk(traders[0], m, new PublicKey(t.fee_wallet), 1_000_000_000_00000)
  const res = await quietKeeper()
  const credited = res.find((r) => r.mint === m.toBase58() && r.credited)
  assert.ok(credited?.credited > 0, JSON.stringify(res))
  assert.equal(credited.asset, BONK.toBase58())
  const auto = res.find((r) => r.autopay === 'alice' && r.asset === 'Bonk')
  assert.ok(auto?.paid === credited.credited, 'auto-pay sent exactly the credited BONK: ' + JSON.stringify(res))
  assert.equal(await bonkOf(payee.publicKey), credited.credited, 'BONK arrived in the saved wallet')
  assert.equal(buckets(db, m.toBase58()).creator, 0)
  // SOL figures are untouched by BONK units
  const statsAfter = await (await fetch(`${BASE}/api/stats`)).json()
  assert.equal(statsAfter.feesSol, statsBefore.feesSol)
  assert.equal(statsAfter.paidToCreatorsSol, statsBefore.paidToCreatorsSol)

  // more trades: auto-pay waits a day, so the site's withdraw (asset = BONK) pays it to any wallet
  await buyWithBonk(traders[1], m, new PublicKey(t.fee_wallet), 500_000_000_00000)
  const res2 = await quietKeeper()
  assert.ok(!res2.some((r) => r.autopay === 'alice' && r.asset === 'Bonk'), 'no second BONK auto-pay within a day')
  const owed = buckets(db, m.toBase58()).creator
  assert.ok(owed > 0)
  const me = await (await api('/api/me')).json()
  const row = me.owed.find((a) => a.asset === BONK.toBase58())
  assert.equal(row.amount, owed / 1e5); assert.equal(row.symbol, 'Bonk')
  const dest = Keypair.generate().publicKey
  const w = await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ destination: dest.toBase58(), asset: BONK.toBase58() }) })
  const wj = await w.json()
  assert.equal(w.status, 200, JSON.stringify(wj))
  assert.equal(await bonkOf(dest), owed)
  assert.equal(buckets(db, m.toBase58()).creator, 0)
  // a SOL withdraw never touches the BONK coin
  const sw = await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ destination: dest.toBase58() }) })
  assert.equal(sw.status, 409)
  // a paired coin cannot be switched to holders (there is no BONK airdrop)
  const ms = await api(`/api/token/${m.toBase58()}/mode`, { method: 'POST', body: JSON.stringify({ mode: 'holders' }) })
  assert.equal(ms.status, 409)
  assert.match((await ms.json()).error, /paired with \$Bonk/)
  const view = (await (await fetch(`${BASE}/api/token/${m.toBase58()}`)).json()).token
  assert.equal(view.unit, 'Bonk'); assert.equal(view.quote.mint, BONK.toBase58()); assert.equal(view.creatorOwedSol, 0)
  assert.equal(view.creatorPaid, (credited.credited + owed) / 1e5)
})

test('a pair, holders (the default): launches with pump.fun holder rewards against BONK; the keeper leaves it', async () => {
  addVanity()
  x.mentions.push(mention('9402', '@UseCashtags $HFROG pair with $bonk', 'holdy', '880099'))
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const m = new PublicKey(out.queue.mint)
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m.toBase58())
  assert.equal(t.native_holders, 1); assert.equal(t.quote_mint, BONK.toBase58())
  const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(m))).data)
  assert.ok(curve.quote_mint.equals(BONK)); assert.ok(curve.creator.equals(holderRewardsAddress(m)))
  await buyWithBonk(traders[2], m, holderRewardsAddress(m), 100_000_000_00000)
  assert.ok((await bonkOf(creatorVaultAddress(holderRewardsAddress(m)))) > 0, 'BONK fees reach pump.fun\'s holder-rewards vault')
  const res = await quietKeeper()
  assert.ok(!res.some((r) => r.mint === m.toBase58()))
})

test('a pair pump.fun refuses is answered, never launched; a pump coin pair by address launches', async () => {
  addVanity()
  x.mentions.push(mention('9403', '@UseCashtags $ZZZ paired with $NOPENOPE', 'zed', '880100'))
  let out = await app.bot.tick()
  assert.equal(out.queue.rejected, 'bad-pair', JSON.stringify(out))
  const r = db.prepare("SELECT * FROM mentions WHERE tweet_id = '9403'").get()
  assert.equal(r.reply_state, 'sent')
  assert.match(x.replies.at(-1).text, /\$NOPENOPE is not on Pumpfun's pair list/)
  // a pump.fun coin still on its curve, by contract address
  const Q = '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump'
  x.mentions.push(mention('9404', `@UseCashtags launch $CRV pair with ${Q}`, 'curvy', '880101'))
  out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(out.queue.mint)
  assert.equal(t.quote_mint, Q)
  assert.ok(decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(new PublicKey(out.queue.mint)))).data).quote_mint.equals(new PublicKey(Q)))
})

test('worst case with a pair: a coin paired with a GRADUATED pump coin (8 extra accounts), 32-byte name, longest link, fits one transaction', async () => {
  const quote = await resolveQuote(conn, 'Goh59QCfoX53RgJa615vzXx4swR3mv51VgvAN6ZCpump')
  assert.equal(quote.kind, 'pool')
  for (const holderReward of [false, true]) {
    const b = await buildLaunchTx({ conn, pump, launcher, mintKp: Keypair.generate(), feeWalletPk: Keypair.generate().publicKey, name: 'N'.repeat(32), symbol: 'ABCDEFGHIJ',
      uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, holderReward, quote })
    assert.ok(b.raw.length <= 1232, `${b.raw.length} B`)
    const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
    assert.equal(f.fate, 'landed', JSON.stringify(f))
  }
})

/**
 * Stand-in rails for Relay / Base / Peer (none of them run locally). The SOLANA side is real: the bridge deposit is a
 * real transfer from the keeper to a "Relay depository" wallet on the validator, and the way back is a real transfer
 * from it to the keeper, so the fee wallets, buckets and keeper balance are all checked against the chain.
 */
function fakeRails() {
  const depository = Keypair.generate()
  const st = { quotes: 0, requests: new Map(), deposits: new Map(), baseSends: 0, usdc: 0n, lostOrder: null }
  const usdPerSol = 150n
  const rails = {
    depository, st, baseAddress: '0x00000000000000000000000000000000000ba5e0',
    relay: {
      async quote(b) {
        const requestId = `req-${++st.quotes}`
        if (b.originChainId === 792703809) {
          const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(b.user), toPubkey: depository.publicKey, lamports: Number(b.amount) })
          st.requests.set(requestId, { dir: 'out', lamports: BigInt(b.amount) })
          return { steps: [{ id: 'deposit', kind: 'transaction', requestId, items: [{ data: { addressLookupTableAddresses: [],
            instructions: [{ programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString('hex'), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) }] } }] }] }
        }
        st.requests.set(requestId, { dir: 'back', usdc: BigInt(b.amount), recipient: b.recipient })
        return { steps: [{ id: 'approve', kind: 'transaction', items: [{ data: { chainId: 8453, to: '0xusdc' } }] },
          { id: 'deposit', kind: 'transaction', requestId, items: [{ data: { chainId: 8453, to: '0xrelay' } }] }] }
      },
      async status(id) {
        const r = st.requests.get(id)
        if (!r) return { status: 'unknown' }
        if (r.dir === 'out') return { status: 'success', txHashes: [`0xfill-${id}`] }
        if (!r.sent) return { status: 'waiting' }
        if (!r.fill) {
          // Relay's solver pays the keeper on Solana: 1 USDC buys 1/150 SOL
          const lamports = Number(r.usdc * 1_000_000_000n / (usdPerSol * 1_000_000n))
          const b = await buildTx(conn, { payer: depository.publicKey, signers: [depository], ixs: [SystemProgram.transfer({ fromPubkey: depository.publicKey, toPubkey: new PublicKey(r.recipient), lamports })] })
          const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
          assert.equal(f.fate, 'landed')
          r.fill = b.signature; r.lamports = lamports
        }
        return { status: 'success', txHashes: [r.fill] }
      },
    },
    base: {
      ethBalance: async () => 10n ** 17n,
      usdcBalance: async () => st.usdc,
      async send(d) { st.baseSends++; if (d.to === '0xrelay') { for (const r of st.requests.values()) if (r.dir === 'back' && !r.sent) { r.sent = true; st.usdc -= r.usdc } } return '0xsent' },
      async usdcIn(hash) {
        const r = st.requests.get(hash.replace('0xfill-', ''))
        const usdc = r.lamports * usdPerSol * 1_000_000n / 1_000_000_000n
        st.usdc += usdc
        return usdc
      },
    },
    peer: {
      async cashout({ amount, payee }) {
        const depositId = `escrow_${st.deposits.size + 1}`
        st.deposits.set(depositId, { depositId, payee, totalAmount: amount, filledAmount: 0n, pendingAmount: 0n, returnedAmount: 0n, state: 'awaiting-buyer', fills: [], withdrawn: false })
        st.usdc -= amount
        return { depositId }
      },
      async order(id) { return { ...st.deposits.get(id) } },
      async orders() { return [...st.deposits.values()].map((d) => ({ ...d })) },
      async withdraw(id) {
        const d = st.deposits.get(id)
        const open = d.totalAmount - d.filledAmount - d.pendingAmount - d.returnedAmount
        d.returnedAmount += open; d.withdrawn = true; d.state = 'returned'
        st.usdc += open
        return { depositId: id, withdrawTxHash: '0xw' }
      },
    },
    // a buyer pays `usd` of the order to the X Money handle and proves it
    fill(id, usdc) { const d = st.deposits.get(id); d.filledAmount += usdc; d.fills.push({ fiatPaid: Number(usdc) / 1e6 }); if (d.filledAmount === d.totalAmount) d.state = 'delivered' },
  }
  return rails
}

test('X Money: fees go out through Relay and Peer to the X handle; a sub-$1 remainder carries to the next payout, an abandoned buyer leaves the order live, a lost cashout is adopted, and leaving X Money brings the rest home', async () => {
  const seed = Buffer.from(SEED, 'hex')
  const rails = fakeRails()
  await fund(rails.depository.publicKey, 1)
  const cfg = { ...xmoneyConfig({ XMONEY_ENABLED: '1' }), minLamports: 1_000_000, adoptSeconds: 0 }
  const pass = () => xmoneyPass({ db, conn, keeper, seed, rails, cfg, solUsd: 150, log: { info() {}, error: console.error } })
  const row = () => db.prepare('SELECT * FROM xmoney_payouts ORDER BY id DESC LIMIT 1').get()
  const m = mint.toBase58()

  // settings: X Money needs the "it is turned on" tick, then sticks
  let r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'xmoney' }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /Confirm that X Money is turned on for @alice/)
  r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'xmoney', xmoneyOn: true, autoMinSol: 0.01 }) })
  assert.equal(r.status, 200, await r.text())
  let me = await (await api('/api/me')).json()
  assert.equal(me.settings.payoutKind, 'xmoney'); assert.equal(me.settings.payoutConfirmed, true); assert.equal(me.options.xmoney, true)

  // fees in alice's creator bucket (her coin is on Fees to me)
  await api(`/api/token/${m}/mode`, { method: 'POST', body: JSON.stringify({ mode: 'creator' }) })
  await buy(traders[0], mint, fw, 3); await buy(traders[2], mint, fw, 3)
  await quietKeeper()
  const owed = buckets(db, m).creator
  assert.ok(owed > 1_000_000, `owed ${owed}`)
  const depoBefore = await conn.getBalance(rails.depository.publicKey)

  // pass 1: the creator bucket is paid out to the keeper (an ordinary payout outflow, labelled X Money)
  await pass()
  assert.equal(buckets(db, m).creator, 0)
  assert.equal(row().state, 'bridging'); assert.equal(row().lamports, owed); assert.equal(row().refund_mint, m)
  assert.equal(db.prepare("SELECT destination FROM outflows WHERE x_id = ? ORDER BY id DESC LIMIT 1").get(ALICE).destination, '@alice'.replace('@', 'xmoney:@'))
  // ⛔ one live payout per account, enforced by the database
  assert.throws(() => db.prepare("INSERT INTO xmoney_payouts (x_id, handle, state, created_at, updated_at) VALUES (?, 'alice', 'collecting', 0, 0)").run(ALICE))
  // pass 2: the keeper's Solana deposit to Relay lands; pass 3: Relay filled on Base, the USDC is read from the fill
  await pass()
  assert.equal((await conn.getBalance(rails.depository.publicKey)) - depoBefore, owed, 'exactly the collected SOL went into the bridge')
  await pass()
  assert.equal(row().state, 'listing')
  const usdc = BigInt(row().usdc)
  assert.equal(usdc, BigInt(owed) * 150n * 1_000_000n / 1_000_000_000n)
  // pass 4: listed on Peer for alice's X Money
  await pass()
  assert.equal(row().state, 'listed')
  const d1 = rails.st.deposits.get(row().deposit_id)
  assert.equal(d1.payee, 'alice'); assert.equal(d1.totalAmount, usdc)
  // nobody pays yet: nothing moves
  assert.deepEqual(await pass(), [])
  me = await (await api('/api/me')).json()
  assert.equal(me.xmoney[0].status, 'Waiting for a payer')
  // a buyer pays half, then the rest: done, paid in dollars
  rails.fill(row().deposit_id, usdc / 2n)
  await pass()
  assert.equal(row().state, 'listed')
  me = await (await api('/api/me')).json()
  assert.equal(me.xmoney[0].status, 'Partly paid, waiting for the rest')
  // buyers pay whole dollars (as on BagsPay's orders): $0.47 is left, under Peer's 1 USDC minimum fill. Like BagsPay,
  // it is withdrawn; unlike a lost remainder, it rides along with alice's next payout
  rails.fill(row().deposit_id, usdc - usdc / 2n - 470_000n)
  await pass()
  assert.equal(row().state, 'done'); assert.equal(row().carry_usdc, 470_000)
  assert.ok(Math.abs(row().paid_usd - Number(usdc - 470_000n) / 1e6) < 0.011, `${row().paid_usd}`)
  me = await (await api('/api/me')).json()
  assert.equal(me.xmoney[0].status, 'Paid · $0.47 carried to your next payout')
  assert.match(me.payouts[0].destination, /^xmoney:@alice$/)

  // ── a second payout: carries the $0.47, a buyer abandons (the order stays live), a crash loses the cashout (adopted),
  //    then alice leaves X Money ──
  await buy(traders[1], mint, fw, 3); await buy(traders[2], mint, fw, 3)
  await quietKeeper()
  const owed2 = buckets(db, m).creator
  for (let i = 0; i < 3; i++) await pass()
  assert.equal(row().state, 'listing')
  const bridged2 = row().usdc
  await pass()
  assert.equal(row().state, 'listed'); assert.equal(row().usdc, bridged2 + 470_000, 'the carried $0.47 is in this order')
  assert.equal(db.prepare('SELECT carry_used FROM xmoney_payouts WHERE carry_usdc > 0').get().carry_used, 1)
  const first = row().deposit_id
  assert.equal(rails.st.deposits.get(first).totalAmount, BigInt(bridged2 + 470_000))
  rails.st.deposits.get(first).state = 'returned' // a buyer signalled and never paid; Peer pruned the intent
  assert.deepEqual(await pass(), [])
  assert.equal(row().state, 'listed'); assert.equal(row().deposit_id, first, 'an abandoned buyer leaves the order live')
  // a crash after Peer's cashout, before the row was written: the next pass adopts that order instead of listing twice
  db.prepare("UPDATE xmoney_payouts SET state = 'listing', deposit_id = NULL, list_started_at = ? WHERE id = ?").run(now() - 5, row().id)
  await pass()
  assert.equal(row().state, 'listed'); assert.equal(row().deposit_id, first)
  assert.equal(rails.st.deposits.size, 2, 'no second listing')
  // alice switches to manual payments: the unfilled USDC comes home as SOL into her creator bucket
  assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ payoutKind: 'claim' }) })).status, 200)
  await pass() // listed → withdrawn → returning
  assert.equal(row().state, 'returning')
  const back = BigInt(row().return_usdc)
  assert.equal(back, BigInt(row().usdc))
  await pass() // the bridge back is sent on Base
  await pass() // Relay paid the keeper on Solana → crediting
  assert.equal(row().state, 'crediting')
  const lamportsBack = row().returned_lamports
  assert.equal(lamportsBack, Number(back * 1_000_000_000n / (150n * 1_000_000n)))
  await pass() // keeper → alice's fee wallet, booked to her creator bucket
  await pass() // the transfer's fate: landed → done
  assert.equal(row().state, 'done')
  assert.equal(buckets(db, m).creator, lamportsBack)
  // the ledger still adds up to the lamport, and a keeper pass does not book the returned SOL a second time
  const b = buckets(db, m)
  assert.equal(await conn.getBalance(fw), RENT_FLOOR + b.creator + b.holders)
  await quietKeeper()
  assert.equal(buckets(db, m).creator, lamportsBack)
  me = await (await api('/api/me')).json()
  assert.equal(me.xmoney[0].status, 'Back in your balance')
  console.log(`X Money: paid $${(Number(usdc) / 1e6).toFixed(2)} for ${owed / 1e9} SOL; a second ${owed2 / 1e9} SOL came back as ${lamportsBack / 1e9} SOL`)
})

test('Float: "on Float" launches through Float from the launch wallet; trades pay the 5% dev share to the fee wallet, the keeper claims + unwraps it into SOL and books it exactly once', async () => {
  const fl = async (ixs, signers) => {
    const b = await buildTx(conn, { payer: signers[0].publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs], signers })
    const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
    assert.equal(f.fate, 'landed', JSON.stringify(f))
  }
  const ticker = `FLT${Math.floor(Math.random() * 1e6)}`
  x.mentions.push(mention('9601', `@UseCashtags launch $${ticker} Float Frogs on Float`, 'flo', '880601'))
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(out.queue.mint)
  assert.equal(t.venue, 'float'); assert.equal(t.name, 'Float Frogs'); assert.equal(t.quote_mint, null)
  const mint = new PublicKey(t.mint)
  const st = await launchState(conn, mint)
  assert.ok(st.fee_receiver.equals(new PublicKey(t.fee_wallet)), 'Float pays the dev share to the coin\'s own fee wallet')
  assert.ok(st.creator.equals(launcher.publicKey), 'launched from the shared launch wallet')
  assert.equal(await conn.getBalance(new PublicKey(t.fee_wallet)), RENT_FLOOR, 'the fee wallet holds exactly its rent floor')
  // the bot says where it is
  await app.bot.tick({ doPoll: false })
  const reply = x.replies.find((r) => r.to === '9601')
  assert.match(reply.text, new RegExp(`^\\$${ticker} is live on Float\\.\\n\\nCA: ${t.mint}$`))
  // a trader buys 10 SOL on the curve
  const trader = Keypair.generate(); await fund(trader.publicKey, 20)
  const tq = floatAta(trader.publicKey, FLOAT_WSOL)
  await fl([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, tq, trader.publicKey, FLOAT_WSOL), SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: tq, lamports: 10e9 }), createSyncNativeInstruction(tq),
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, floatAta(trader.publicKey, mint), trader.publicKey, mint)], [trader])
  const { quote } = await readFloat(conn, FLOAT_WSOL)
  for (let i = 0; i < 2; i++) await fl([floatBuyIx({ buyer: trader.publicKey, mint, globalConfig: quote.global_config, amountIn: 5_000_000_000n })], [trader])
  // the keeper: claim_coin_fees + claim_dev_fees → fee wallet WSOL → unwrapped → booked to the creator bucket
  db.prepare("UPDATE tokens SET mode = 'creator' WHERE mint = ?").run(t.mint)
  await quietKeeper()
  const st2 = await launchState(conn, mint)
  const devShare = Number(st2.coin_fees_claimed) / 4 // Float: dev 25% of the coin's share (5% of the whole fee)
  const b = buckets(db, t.mint)
  assert.ok(devShare > 0)
  assert.equal(b.creator, devShare, `creator bucket = Float's dev share exactly (${devShare} lamports)`)
  assert.equal(Number(st2.dev_owed), 0, 'nothing left owed')
  assert.equal(await conn.getBalance(new PublicKey(t.fee_wallet)), RENT_FLOOR + b.creator + b.holders, 'the fee wallet holds the floor + the books, to the lamport')
  const wsolLeft = await conn.getAccountInfo(floatAta(new PublicKey(t.fee_wallet), FLOAT_WSOL))
  assert.ok(wsolLeft, 'its WSOL account is reopened for the next payment')
  // another pass with nothing new books nothing twice
  await quietKeeper()
  assert.equal(buckets(db, t.mint).creator, devShare)
  console.log(`Float: 10 SOL of buys paid ${Number(st2.coin_fees_claimed) / 1e9} SOL of coin fees; the creator's 25% (${devShare / 1e9} SOL) is in the bucket as plain SOL`)
})

test('Float: a ticker already on Float is answered (we never pay Float\'s takeover fee); the worst-case launch fits one transaction', async () => {
  // someone else took the ticker on Float first
  const other = Keypair.generate(); await fund(other.publicKey, 2)
  const taken = `TKN${Math.floor(Math.random() * 1e6)}`
  const { ix } = await floatLaunchIx(conn, { creator: other.publicKey, name: 'Taken', ticker: taken, uri: 'https://gateway.pinata.cloud/ipfs/bafkreib' + 'a'.repeat(52), feeReceiver: other.publicKey })
  const bb = await buildTx(conn, { payer: other.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], signers: [other] })
  assert.equal((await sendUntilFate(conn, { raw: bb.raw, signature: bb.signature, lastValidBlockHeight: bb.lastValidBlockHeight })).fate, 'landed')
  x.mentions.push(mention('9602', `@UseCashtags launch $${taken} on Float`, 'late', '880602'))
  const before = await conn.getBalance(launcher.publicKey)
  let out = await app.bot.tick()
  assert.equal(out.queue.rejected, 'float-ticker-taken', JSON.stringify(out))
  assert.equal(await conn.getBalance(launcher.publicKey), before, 'nothing was sent')
  await app.bot.tick({ doPoll: false })
  assert.match(x.replies.find((r) => r.to === '9602').text, new RegExp(`\\$${taken} is already taken on Float\\. Pick another cashtag, or launch it on Pumpfun\\.`))
  // worst case: 32-byte name, 10-character ticker, the longest link, SOL pair + the fee wallet prefund
  const r = await floatLaunchIx(conn, { creator: launcher.publicKey, name: 'N'.repeat(32), ticker: 'ABCDEFGHIJ', uri: `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`, feeReceiver: Keypair.generate().publicKey })
  const w = await buildTx(conn, { payer: launcher.publicKey, signers: [launcher], ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }), r.ix,
    SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: Keypair.generate().publicKey, lamports: RENT_FLOOR })] })
  assert.ok(w.raw.length <= 1232, `${w.raw.length} B`)
  console.log(`Float worst-case launch: ${w.raw.length} of 1232 bytes`)
})


test('launching FOR @bob: carol posts it, the coin is bob\'s (his X id, creator mode), fees credit HIS bucket, and X Money pays bob without him ever signing in, to his CURRENT handle', async () => {
  addVanity()
  const BOB = '7777777777777777777'
  const CAROL = '8888888888888888888'
  x.users = new Map([['bob', { id: BOB, handle: 'Bob', name: 'Bob', avatar: null, followers: 3 }]])
  x.mentions.push({ id: '9701', text: '@UseCashtags launch $GM Good Morning for @bob', createdAt: now(), authorHandle: 'carol', authorId: CAROL, authorName: 'Carol',
    authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'https://x.com/carol/status/9701' })
  const pinsBefore = pins.length
  const out = await app.bot.tick()
  assert.equal(out.queue.outcome, 'launched', JSON.stringify(out))
  const m = out.queue.mint
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(m)
  assert.equal(t.creator_id, BOB, 'the coin is keyed on bob\'s X id')
  assert.equal(t.creator_handle, 'Bob')
  assert.deepEqual([t.launched_by_id, t.launched_by_handle], [CAROL, 'carol'])
  assert.equal(t.mode, 'creator', 'never holders: the rewards are bob\'s')
  assert.equal(t.native_holders, 0)
  assert.equal(t.name, 'Good Morning')
  assert.match(pins[pinsBefore].description, /launched on X for @Bob by @carol/)
  const reply = x.replies.find((r) => r.to === '9701')
  assert.ok(reply && reply.text.includes(m) && /Launched for @Bob: its creator rewards go to their X Money\./.test(reply.text), reply?.text)
  const bob = db.prepare('SELECT * FROM users WHERE x_id = ?').get(BOB)
  assert.deepEqual([bob.payout_kind, bob.payout_auto, bob.payout_confirmed, bob.settings_at], ['xmoney', 1, 0, null], 'X Money set up for bob, who never chose')
  // the public page says whose coin it is and who launched it
  const view = await (await api(`/api/token/${m}`)).json()
  assert.equal(view.token.creator.id, BOB)
  assert.deepEqual(view.token.launchedBy, { id: CAROL, handle: 'carol' })

  // trades pay the creator reward; the keeper books it to BOB's creator bucket (carol gets nothing)
  const mintPk = new PublicKey(m), fwPk = feeWallet(Buffer.from(SEED, 'hex'), mintPk).publicKey
  await buy(traders[0], mintPk, fwPk, 3); await buy(traders[1], mintPk, fwPk, 3)
  await quietKeeper()
  const owed = buckets(db, m).creator
  assert.ok(owed > 1_000_000, `owed ${owed}`)
  assert.equal(owedTo(db, BOB).total, owed, 'owed to bob')
  assert.equal(owedTo(db, CAROL).total, 0, 'nothing to carol')

  // X Money, fully automatic: collect → bridge → list on Peer. Bob renamed himself meanwhile: the CURRENT handle is paid.
  // 6 SOL of test trades earn ~0.02 SOL: under the default 0.05 SOL threshold (correctly not paid yet), so lower it here
  db.prepare('UPDATE users SET auto_min_lamports = 1000000 WHERE x_id = ?').run(BOB)
  const rails = fakeRails()
  rails.handleOf = async (id) => (id === BOB ? 'BobNewName' : null)
  await fund(rails.depository.publicKey, 1)
  const cfg = { ...xmoneyConfig({ XMONEY_ENABLED: '1' }), minLamports: 1_000_000, adoptSeconds: 0 }
  const pass = () => xmoneyPass({ db, conn, keeper, seed: Buffer.from(SEED, 'hex'), rails, cfg, solUsd: 150, log: { info() {}, error: console.error } })
  const row = () => db.prepare('SELECT * FROM xmoney_payouts WHERE x_id = ? ORDER BY id DESC LIMIT 1').get(BOB)
  for (let i = 0; i < 6 && row()?.state !== 'listed'; i++) await pass()
  assert.equal(row()?.state, 'listed', JSON.stringify(row() ?? null))
  assert.equal(row().lamports, owed, 'all of bob\'s fees went out')
  assert.equal(buckets(db, m).creator, 0)
  const dep = rails.st.deposits.get(row().deposit_id)
  assert.equal(dep.payee, 'BobNewName', 'paid to the handle bob holds NOW, looked up by his X id')
  assert.equal(db.prepare('SELECT handle FROM users WHERE x_id = ?').get(BOB).handle, 'BobNewName')
  // the coin page tracks it: this coin's share, the collect and bridge transactions, the Peer order, the status
  let page = await (await api(`/api/token/${m}`)).json()
  assert.equal(page.xmoney.length, 1)
  assert.equal(page.xmoney[0].status, 'Listed on Peer, waiting for a payer')
  assert.equal(page.xmoney[0].sol, owed / 1e9)
  assert.ok(page.xmoney[0].collectTxs.length >= 1 && page.xmoney[0].bridgeTx && page.xmoney[0].peerOrder, JSON.stringify(page.xmoney[0]))
  assert.match(page.xmoneyWallet, /^0x[0-9a-fA-F]{40}$/)
  assert.ok(page.activity.some((o) => o.destination === 'xmoney:@Bob' || o.destination?.startsWith('xmoney:@')), 'the collect shows in Payouts as an X Money send')
  // a buyer pays bob's X Money in full: done
  rails.fill(row().deposit_id, BigInt(row().usdc))
  await pass()
  assert.equal(row().state, 'done', JSON.stringify(row()))
  page = await (await api(`/api/token/${m}`)).json()
  assert.equal(page.xmoney[0].status, "Paid to @BobNewName's X Money")
  assert.ok(page.xmoney[0].paidUsd > 0)
  // bob signs in later and picks a wallet: his own choice clears the automatic X Money
  db.prepare("UPDATE users SET payout_kind = 'wallet', payout_wallet = ?, payout_confirmed = 1, settings_at = ?, payout_auto = 0 WHERE x_id = ?").run(payee.publicKey.toBase58(), now(), BOB)
  assert.equal(db.prepare("SELECT 1 FROM users WHERE payout_kind = 'xmoney' AND (payout_confirmed = 1 OR payout_auto = 1) AND x_id = ?").get(BOB), undefined)
})

// ── launching on the site (13 Nov): the launcher's OWN wallet pays and signs ─────────────────────────────────────────
import { TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const DAVE = BigInt('0x' + createHash('sha256').update('x:dave').digest('hex').slice(0, 12)).toString()
const buyer = Keypair.generate()
const post = async (path, body) => { const r = await api(path, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const settled = async (id) => { for (let i = 0; i < 180; i++) { const s = await (await api(`/api/launch/${id}`)).json(); if (!['queued', 'launching'].includes(s.state)) return s; await new Promise((r) => setTimeout(r, 500)) } throw new Error('launch never settled') }
const tokensOf = async (owner, m) => { const a = await conn.getAccountInfo(ata(owner, new PublicKey(m), TOKEN_2022)); return a ? tokenAccountAmount(a.data) : 0n }
const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64')
/** The whole form flow: prepare with `signer` as the paying wallet, sign as that wallet, hand it back, wait for the chain. */
const launchOnSite = async (body, signer = buyer) => {
  addVanity()
  const prep = await post('/api/launch', { wallet: signer.publicKey.toBase58(), ...body })
  if (prep.status !== 200) return { prep }
  const tx = VersionedTransaction.deserialize(Buffer.from(prep.body.transaction, 'base64')); tx.sign([signer])
  const sent = await post('/api/launch/sign', { id: prep.body.id, transaction: b64(tx) })
  if (sent.status !== 200) return { prep, sent }
  return { prep, sent, st: await settled(prep.body.id) }
}

test('site launch: the launcher\'s own wallet pays and signs (the launch wallet pays nothing), the coin carries the form\'s picture, description and links, and nothing is posted on X', async () => {
  const anon = await fetch(`${BASE}/api/launch`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(anon.status, 401)
  cookie = ''
  await fund(buyer.publicKey, 40)
  let r = await api('/api/auth/x/start?as=dave&return=/launch')
  r = await api(new URL(r.headers.get('location')).pathname + new URL(r.headers.get('location')).search)
  assert.equal(r.headers.get('location'), '/launch')
  const o = await (await api('/api/launch/options')).json()
  assert.deepEqual([o.open, o.devBuy.enabled, o.defaultMode, o.launchCostSol], [true, false, 'holders', 0.01])
  // no wallet named: nothing is built
  const noWallet = await post('/api/launch', { symbol: 'sitea', mode: 'creator' })
  assert.equal(noWallet.status, 400)
  assert.match(noWallet.body.error, /Connect the wallet/)

  const repliesBefore = x.replies.length, pinsBefore = pins.length
  const before = { launcher: await conn.getBalance(launcher.publicKey), buyer: await conn.getBalance(buyer.publicKey) }
  const a = await launchOnSite({ symbol: 'sitea', name: 'Site Alpha', description: 'Made on the site', website: 'sitea.example', twitter: '@sitea', mode: 'creator', image: PNG.toString('base64') })
  assert.equal(a.prep.status, 200, JSON.stringify(a.prep.body))
  assert.match(a.prep.body.id, /^site-[a-f0-9]{18}$/)
  const unsigned = VersionedTransaction.deserialize(Buffer.from(a.prep.body.transaction, 'base64'))
  assert.ok(unsigned.message.staticAccountKeys[0].equals(buyer.publicKey), 'the launcher\'s wallet is the fee payer')
  assert.equal(unsigned.message.header.numRequiredSignatures, 2, 'two signers: the wallet and the mint')
  assert.ok(unsigned.signatures.every((sg) => sg.every((b) => b === 0)), 'the mint key has not signed what the wallet is shown')
  assert.equal(a.st.state, 'launched', JSON.stringify(a))
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(a.st.mint)
  assert.deepEqual([t.symbol, t.name, t.creator_id, t.creator_handle, t.mode, t.native_holders, t.tweet_url], ['SITEA', 'Site Alpha', DAVE, 'dave', 'creator', 0, null])
  const f = feeWallet(Buffer.from(SEED, 'hex'), new PublicKey(a.st.mint)).publicKey
  assert.ok(curveCreator((await conn.getAccountInfo(bondingCurveAddress(new PublicKey(a.st.mint)))).data).equals(f), 'the coin pays its derived fee wallet, like a tagged one')
  assert.equal(await conn.getBalance(f), RENT_FLOOR)
  assert.deepEqual(pins[pinsBefore], { name: 'Site Alpha', symbol: 'SITEA', description: 'Made on the site', twitter: 'https://x.com/sitea', website: 'https://sitea.example/' })
  assert.match(t.image, /\/api\/logos\/[a-f0-9]{32}\.png$/)
  const paid = { launcher: before.launcher - await conn.getBalance(launcher.publicKey), buyer: before.buyer - await conn.getBalance(buyer.publicKey) }
  assert.equal(paid.launcher, 0, 'the launch wallet paid nothing')
  assert.ok(paid.buyer > 0.005e9 && paid.buyer <= 0.01e9, `the launcher's wallet paid ${paid.buyer / 1e9} SOL`)
  console.log(`site launch: the launcher's wallet paid ${paid.buyer / 1e9} SOL, the launch wallet ${paid.launcher / 1e9}`)
  await app.bot.tick()
  assert.equal(x.replies.length, repliesBefore, 'a site launch is never answered on X')
  assert.equal(db.prepare('SELECT followers FROM users WHERE x_id = ?').get(DAVE).followers, null, 'no follower rule: the profile is never read from X')
  // it shows on the public pages like any coin
  const page = await (await api(`/api/token/${a.st.mint}`)).json()
  assert.deepEqual([page.token.creator.handle, page.token.tweetUrl], ['dave', ''])
  const feed = await (await fetch(`${BASE}/api/feed`)).json()
  assert.equal(feed.feed.find((i) => i.tweetId === a.prep.body.id).url, `${BASE}/x/dave`)
  // the cashtag is held for 24 hours, on the form too
  const chk = await (await api('/api/launch/check?symbol=sitea&pair=BONK')).json()
  assert.deepEqual([chk.ticker.free, chk.pair.ok], [false, true])
  const again = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'SITEA', mode: 'creator' })
  assert.equal(again.status, 409)
  assert.match(again.body.error, /launched in the last 24 hours/)
  // no cooldown for a launch its own wallet pays: another one straight away (the app here runs a 0 s cooldown anyway;
  // the rule itself is in the unit tests)
  const b = await launchOnSite({ symbol: 'siteb', mode: 'holders' })
  assert.equal(b.st?.state, 'launched', JSON.stringify(b))
  assert.equal(db.prepare("SELECT native_holders FROM tokens WHERE symbol = 'SITEB'").get().native_holders, 1)
  // someone else's launch cannot be read
  const saved = cookie; cookie = ''
  assert.equal((await api(`/api/launch/${a.prep.body.id}`)).status, 401)
  cookie = saved
})

test('site launch with a dev buy: one transaction from the launcher\'s wallet creates the coin and buys first; a swapped message, a wrong signer and a replay are refused; worst case fits', async () => {
  const noLut = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'DEVA', mode: 'creator', devBuy: { sol: '1' } })
  assert.equal(noLut.status, 503)
  assert.match(noLut.body.error, /Dev buys are switched off/)
  const table = await createLaunchTable(conn, launcher, await staticLaunchAccounts(pump, await loadGlobal(conn)))
  kvSet(db, 'launch_lut', table.toBase58())
  assert.ok(await app.site.launchLut())
  // a table made seconds ago: the local validator only lands transactions that use it once its last extension is final
  // (measured 13 Nov: ~25 s to land before that, ~2 s after). On mainnet the table is made once, long before any launch.
  const extended = Number((await app.site.launchLut()).state.lastExtendedSlot)
  while (await conn.getSlot('finalized') <= extended) await new Promise((r) => setTimeout(r, 500))

  // worst case: 32-byte name, 10-letter cashtag, the longest metadata link, creator mode (the rent-floor transfer is in)
  addVanity()
  const before = { launcher: await conn.getBalance(launcher.publicKey), buyer: await conn.getBalance(buyer.publicKey) }
  const prep = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'ABCDEFGHIZ', name: 'W'.repeat(32), mode: 'creator', image: PNG.toString('base64'), devBuy: { sol: '1.5' } })
  assert.equal(prep.status, 200, JSON.stringify(prep.body))
  assert.equal(prep.body.state, 'signing')
  const unsigned = Buffer.from(prep.body.transaction, 'base64')
  assert.ok(unsigned.length <= 1232, `${unsigned.length} bytes`)
  console.log(`worst-case site launch with a dev buy: ${unsigned.length} bytes`)
  const tx = VersionedTransaction.deserialize(unsigned)
  assert.ok(tx.message.staticAccountKeys[0].equals(buyer.publicKey))
  assert.equal((await api(`/api/launch/${prep.body.id}`).then((r) => r.json())).state, 'signing')

  // ⛔ a message that is not the one we built (an added transfer): refused, the mint key never signs it
  const lut = await app.site.launchLut()
  const ixs = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [lut] }).instructions
  const evil = new VersionedTransaction(new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: tx.message.recentBlockhash,
    instructions: [...ixs, SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: launcher.publicKey, lamports: 5e9 })] }).compileToV0Message([lut]))
  evil.sign([buyer])
  const swapped = await post('/api/launch/sign', { id: prep.body.id, transaction: b64(evil) })
  assert.equal(swapped.status, 400)
  assert.match(swapped.body.error, /changed the transaction/)
  // signed by some other wallet
  const other = Keypair.generate()
  const stranger = VersionedTransaction.deserialize(unsigned)
  const fake = new VersionedTransaction(new TransactionMessage({ payerKey: other.publicKey, recentBlockhash: tx.message.recentBlockhash, instructions: [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: buyer.publicKey, lamports: 1 })] }).compileToV0Message())
  fake.sign([other])
  stranger.signatures[0] = fake.signatures[0]
  const wrong = await post('/api/launch/sign', { id: prep.body.id, transaction: b64(stranger) })
  assert.equal(wrong.status, 400)
  assert.match(wrong.body.error, /not signed by the connected wallet/)
  assert.equal(db.prepare('SELECT count(*) n FROM mentions WHERE tweet_id = ?').get(prep.body.id).n, 0, 'no launch row for a refused signature')

  // the real one
  tx.sign([buyer])
  const sentAt = Date.now()
  const sent = await post('/api/launch/sign', { id: prep.body.id, transaction: b64(tx) })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const st = await settled(prep.body.id)
  console.log(`dev-buy launch settled ${Date.now() - sentAt} ms after the wallet signed`)
  assert.equal(st.state, 'launched', JSON.stringify(st))
  assert.equal(st.mint, prep.body.mint)
  const mintPk = new PublicKey(st.mint)
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(st.mint)
  assert.deepEqual([t.symbol, t.name, t.creator_id, t.mode, t.launch_sig], ['ABCDEFGHIZ', 'W'.repeat(32), DAVE, 'creator', sent.body.signature])
  assert.ok(curveCreator((await conn.getAccountInfo(bondingCurveAddress(mintPk))).data).equals(feeWallet(Buffer.from(SEED, 'hex'), mintPk).publicKey))
  const held = await tokensOf(buyer.publicKey, st.mint)
  assert.ok(held > 49_000_000_000_000n && held < 52_000_000_000_000n, `1.5 SOL bought ${Number(held) / 1e6} tokens`)
  const paid = { launcher: before.launcher - await conn.getBalance(launcher.publicKey), buyer: before.buyer - await conn.getBalance(buyer.publicKey) }
  assert.equal(paid.launcher, 0, 'the launch wallet paid nothing')
  assert.ok(paid.buyer >= 1.5e9 + 0.005e9 && paid.buyer < 1.5e9 + 0.016e9, `the launcher's wallet paid ${paid.buyer / 1e9} SOL: the buy, the creation and its own accounts`)
  console.log(`site launch with a 1.5 SOL dev buy: the launcher's wallet paid ${paid.buyer / 1e9} SOL for ${Number(held) / 1e6} tokens`)
  const replay = await post('/api/launch/sign', { id: prep.body.id, transaction: b64(tx) })
  assert.equal(replay.status, 409)
  // the dev buy paid creator fees into the coin's own wallet: the keeper credits dave
  await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000' }), log: { info() {}, error: console.error } })
  assert.ok(buckets(db, st.mint).creator > 0, 'creator fees from the dev buy are dave\'s')
})

test('site launch with a dev buy and holder rewards; a pair launches against BONK; a pair with a dev buy, a wallet that cannot pay, an expired draft and closed launching are refused', async () => {
  const h = await launchOnSite({ symbol: 'DEVH', name: 'Holders Dev', devBuy: { sol: '0.25' } })
  assert.equal(h.st?.state, 'launched', JSON.stringify(h))
  const t = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(h.st.mint)
  assert.deepEqual([t.mode, t.native_holders], ['holders', 1])
  const c = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(new PublicKey(h.st.mint)))).data)
  assert.ok(c.is_holder_reward && c.creator.equals(holderRewardsAddress(new PublicKey(h.st.mint))))
  assert.ok(await tokensOf(buyer.publicKey, h.st.mint) > 8_000_000_000_000n)

  // a pair, no dev buy: built against BONK and paid by the launcher's wallet
  const p = await launchOnSite({ symbol: 'SITEP', name: 'Site Pair', mode: 'creator', pair: '$BONK' })
  assert.equal(p.st?.state, 'launched', JSON.stringify(p))
  const tp = db.prepare("SELECT * FROM tokens WHERE symbol = 'SITEP'").get()
  assert.deepEqual([tp.quote_symbol?.toUpperCase(), tp.creator_id], ['BONK', DAVE])

  const paired = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'DEVP', mode: 'creator', pair: 'BONK', devBuy: { sol: '0.25' } })
  assert.equal(paired.status, 400)
  assert.match(paired.body.error, /SOL pairs/)
  const poor = Keypair.generate()
  const broke = await post('/api/launch', { wallet: poor.publicKey.toBase58(), symbol: 'DEVQ', mode: 'creator' })
  assert.equal(broke.status, 400)
  assert.match(broke.body.error, /holds 0\.0000 SOL/)
  // a draft the wallet never signed in time
  addVanity()
  const late = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'DEVL', mode: 'creator', devBuy: { sol: '0.1' } })
  assert.equal(late.status, 200, JSON.stringify(late.body))
  db.prepare('UPDATE site_drafts SET expires_at = ? WHERE id = ?').run(now() - 1, late.body.id)
  const ltx = VersionedTransaction.deserialize(Buffer.from(late.body.transaction, 'base64')); ltx.sign([buyer])
  assert.equal((await post('/api/launch/sign', { id: late.body.id, transaction: b64(ltx) })).status, 409)
  assert.equal((await api(`/api/launch/${late.body.id}`).then((r) => r.json())).state, 'expired')
  assert.equal(db.prepare("SELECT 1 FROM tokens WHERE symbol = 'DEVL'").get(), undefined)
  kvSet(db, LAUNCHING_CLOSED, 'test')
  const closed = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'SITEC', mode: 'creator' })
  assert.equal(closed.status, 409)
  assert.match(closed.body.error, /closed/)
  db.prepare('DELETE FROM kv WHERE k = ?').run(LAUNCHING_CLOSED)
})

test('site launch with X Money: for another X account the coin is theirs (creator mode, X Money set up for them), with a dev buy too; your own handle pays your X Money; unknown handles refused', async () => {
  const ERIN = '9999999999999999991'
  x.users = new Map([['erin', { id: ERIN, handle: 'Erin', name: 'Erin', avatar: null, followers: 2, createdAt: now() - 30 * 86400 }]])
  const unknown = await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'FORX', forHandle: '@nobody_here' })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /was not found on X/)
  assert.equal((await post('/api/launch', { wallet: buyer.publicKey.toBase58(), symbol: 'FORX', forHandle: 'not a handle!' })).status, 400)
  // "holders" on the form is ignored: a coin for someone always pays them
  const pinsBefore = pins.length
  const a = await launchOnSite({ symbol: 'FORA', name: 'For Erin', mode: 'holders', forHandle: '@erin' })
  assert.equal(a.st?.state, 'launched', JSON.stringify(a))
  const t = db.prepare("SELECT * FROM tokens WHERE symbol = 'FORA'").get()
  assert.deepEqual([t.creator_id, t.creator_handle, t.launched_by_id, t.launched_by_handle, t.mode, t.native_holders], [ERIN, 'Erin', DAVE, 'dave', 'creator', 0])
  assert.match(pins[pinsBefore].description, /launched for @Erin by @dave/)
  const erin = db.prepare('SELECT * FROM users WHERE x_id = ?').get(ERIN)
  assert.deepEqual([erin.payout_kind, erin.payout_auto], ['xmoney', 1], 'X Money set up for erin, who never chose')
  // with a dev buy: dave's wallet buys, the coin and its rewards are erin's
  const b = await launchOnSite({ symbol: 'FORB', forHandle: 'erin', devBuy: { sol: '0.5' } })
  assert.equal(b.st?.state, 'launched', JSON.stringify(b))
  const tb = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(b.st.mint)
  assert.deepEqual([tb.creator_id, tb.launched_by_id, tb.mode], [ERIN, DAVE, 'creator'])
  await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000' }), log: { info() {}, error: console.error } })
  assert.ok(owedTo(db, ERIN).total > 0, 'the dev buy\'s creator fees are erin\'s')
  // your own handle: an ordinary creator-mode launch, and your rewards go to your X Money
  const c = await launchOnSite({ symbol: 'FORC', forHandle: 'dave' })
  assert.equal(c.st?.state, 'launched', JSON.stringify(c))
  assert.deepEqual(Object.values(db.prepare("SELECT launched_by_id, mode FROM tokens WHERE symbol = 'FORC'").get()), [null, 'creator'])
  assert.deepEqual(Object.values(db.prepare('SELECT payout_kind, payout_auto FROM users WHERE x_id = ?').get(DAVE)), ['xmoney', 1])
  assert.equal((await (await api('/api/launch/options')).json()).xmoney.enabled, true)
  // the form's lookup: who is behind a handle, before launching (one billed read per handle, then kept)
  const calls = x.calls.user ?? 0
  const found = await (await api('/api/launch/x-user?handle=@ERIN')).json()
  assert.deepEqual([found.found, found.handle, found.name, found.followers, found.self], [true, 'Erin', 'Erin', 2, false])
  await api('/api/launch/x-user?handle=erin')
  assert.equal(x.calls.user, calls + 1, 'the second look is answered from the kept answer')
  assert.equal((await (await api('/api/launch/x-user?handle=nobody_here')).json()).found, false)
  assert.equal((await api('/api/launch/x-user?handle=not%20a%20handle')).status, 400)
  const kept = cookie; cookie = ''
  assert.equal((await api('/api/launch/x-user?handle=erin')).status, 401, 'signed-in accounts only: every lookup is paid for')
  cookie = kept
})

test('explore boards and the payments page: graduated / on the curve split; every landed payout, airdrop and X Money send listed with its token, totals add up', async () => {
  const all = await (await fetch(`${BASE}/api/tokens?limit=100`)).json()
  const one = all.tokens.find((t) => !t.platform)
  db.prepare('UPDATE tokens SET graduated = 1 WHERE mint = ?').run(one.mint)
  await new Promise((r) => setTimeout(r, 5100)) // the public lists are cached for 5 s
  const grad = await (await fetch(`${BASE}/api/tokens?graduated=1&limit=100`)).json()
  const curve = await (await fetch(`${BASE}/api/tokens?graduated=0&limit=100`)).json()
  assert.ok(grad.tokens.some((t) => t.mint === one.mint) && grad.tokens.every((t) => t.graduated))
  assert.ok(curve.tokens.every((t) => !t.graduated) && !curve.tokens.some((t) => t.mint === one.mint))
  assert.equal(grad.total + curve.total, db.prepare('SELECT count(*) n FROM tokens').get().n)
  // the X Money filter: only launches made for an X account
  const xm = await (await fetch(`${BASE}/api/tokens?sort=xmoney&limit=100`)).json()
  assert.equal(xm.total, db.prepare('SELECT count(*) n FROM tokens WHERE launched_by_id IS NOT NULL').get().n)
  assert.ok(xm.tokens.length > 0 && xm.tokens.every((t) => t.launchedBy))
  db.prepare('UPDATE tokens SET graduated = 0 WHERE mint = ?').run(one.mint)

  const pay = await (await fetch(`${BASE}/api/payments?limit=100`)).json()
  const landed = db.prepare("SELECT count(*) n FROM outflows WHERE state = 'landed'").get().n
  assert.ok(landed > 0)
  assert.equal(pay.total, landed)
  assert.ok(pay.items.every((p) => p.signature && p.token.symbol && p.handle && ['payout', 'airdrop'].includes(p.kind)))
  assert.ok(pay.items.every((p, i) => i === 0 || pay.items[i - 1].time >= p.time), 'newest first')
  const kinds = {}
  for (const k of ['creators', 'holders', 'xmoney']) kinds[k] = await (await fetch(`${BASE}/api/payments?kind=${k}&limit=100`)).json()
  assert.equal(kinds.creators.total + kinds.holders.total + kinds.xmoney.total, pay.total)
  assert.ok(kinds.holders.items.length > 0 && kinds.holders.items.every((p) => p.kind === 'airdrop' && p.recipients > 0))
  assert.ok(kinds.xmoney.items.length > 0 && kinds.xmoney.items.every((p) => p.xmoney))
  assert.ok(kinds.creators.items.length > 0 && kinds.creators.items.every((p) => p.kind === 'payout' && !p.xmoney))
  // totals: SOL coins only, straight from the ledger
  const solOut = db.prepare("SELECT COALESCE(SUM(o.lamports), 0) l FROM outflows o JOIN tokens t ON t.mint = o.mint WHERE o.state = 'landed' AND t.quote_mint IS NULL").get().l
  const T = pay.totals
  assert.equal(Math.round((T.creatorsSol + T.holdersSol + T.xmoneySol) * 1e9), solOut)
  assert.ok(Math.abs(T.allSol - (T.creatorsSol + T.holdersSol + T.xmoneySol + T.pumpHoldersSol)) < 1e-9)
  assert.equal((await fetch(`${BASE}/api/payments?kind=bogus`)).status, 400)
  const top = await (await fetch(`${BASE}/api/payments/top`)).json()
  assert.ok(top.items.length > 0 && top.items.every((r, i) => r.creator.handle && (i === 0 || top.items[i - 1].paidSol >= r.paidSol)))
})

test('sign in with a Solana wallet: a one-time signed message makes a session; the wallet account launches with no X account and pays for it; its coin shows under its address; bad signatures and replays refused', async () => {
  const { createPrivateKey, sign: edSign } = await import('node:crypto')
  const signMsg = (msg, kp) => edSign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64')
  const wal = Keypair.generate(), thief = Keypair.generate()
  const A = wal.publicKey.toBase58()
  await fund(wal.publicKey, 2)
  cookie = ''
  const ch = await (await api(`/api/auth/wallet/challenge?address=${A}`)).json()
  assert.ok(ch.message.includes(A) && ch.message.includes(ch.nonce))
  // signed by another key: refused, and the nonce is spent
  assert.equal((await post('/api/auth/wallet', { address: A, nonce: ch.nonce, signature: signMsg(ch.message, thief) })).status, 401)
  assert.equal((await post('/api/auth/wallet', { address: A, nonce: ch.nonce, signature: signMsg(ch.message, wal) })).status, 400, 'a nonce works once')
  assert.equal((await api('/api/me')).status, 401)
  // a challenge for one address cannot sign another in
  const ch2 = await (await api(`/api/auth/wallet/challenge?address=${A}`)).json()
  assert.equal((await post('/api/auth/wallet', { address: thief.publicKey.toBase58(), nonce: ch2.nonce, signature: signMsg(ch2.message, thief) })).status, 400)
  const ch3 = await (await api(`/api/auth/wallet/challenge?address=${A}`)).json()
  assert.equal((await post('/api/auth/wallet', { address: A, nonce: ch3.nonce, signature: signMsg(ch3.message, wal) })).status, 200)
  const me = await (await api('/api/me')).json()
  assert.deepEqual([me.user.id, me.user.handle, me.user.wallet], [`wallet:${A}`, A, A])
  // X Money is an X account's: a wallet account cannot choose it for itself
  assert.equal((await post('/api/settings', { payoutKind: 'xmoney', xmoneyOn: true })).status, 400)

  // launches with no X account at all, paid by that wallet: Holders, and X Money for a named X account
  const pinsBefore = pins.length, launcherBefore = await conn.getBalance(launcher.publicKey)
  const a = await launchOnSite({ symbol: 'WALA', name: 'Wallet Alpha', mode: 'holders' }, wal)
  assert.equal(a.st?.state, 'launched', JSON.stringify(a))
  const ta = db.prepare("SELECT * FROM tokens WHERE symbol = 'WALA'").get()
  assert.deepEqual([ta.creator_id, ta.creator_handle, ta.mode, ta.native_holders], [`wallet:${A}`, A, 'holders', 1])
  assert.match(pins[pinsBefore].description, new RegExp(`launched by ${A.slice(0, 4)}…${A.slice(-4)} on`))
  assert.equal(pins[pinsBefore].twitter, '', 'no X link is made up for a wallet')
  const b = await launchOnSite({ symbol: 'WALB', forHandle: 'erin' }, wal)
  assert.equal(b.st?.state, 'launched', JSON.stringify(b))
  const tb = db.prepare("SELECT * FROM tokens WHERE symbol = 'WALB'").get()
  assert.deepEqual([tb.creator_handle, tb.launched_by_handle, tb.mode], ['Erin', A, 'creator'])
  assert.equal(await conn.getBalance(launcher.publicKey), launcherBefore, 'two launches, and the launch wallet paid for neither')
  // its public page is its address
  const page = await (await fetch(`${BASE}/api/creator/${A}`)).json()
  assert.deepEqual([page.creator.wallet, page.tokens.length], [A, 1])
})
