// No chain, no network: parser, replies, guards, money buckets, airdrop plan, and the bot's queue rules.
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { parseTweet, isLaunchRequest, hasLaunchIntent } from '../api/parse.mjs'
import { launchedReply, rejectedReply, failedReply, tweetLength } from '../api/replies.mjs'
import { checkGuards, guardConfig, rampFor } from '../api/guards.mjs'
import { openDb, buckets, owedTo, kvSet, kvDel, lockCoin, unlockCoin, LAUNCHING_CLOSED, now } from '../api/db.mjs'
import { creditSurplus, planAirdrop } from '../api/keeper.mjs'
import { feeWallet, parseSeed } from '../api/feewallet.mjs'
import { RENT_FLOOR, isAllowedImageHost, describe, chooseImage, tweetLink, SITE_URL } from '../api/launch.mjs'
import { createBot } from '../api/bot.mjs'
import { FixtureX } from '../api/x.mjs'

const H = 'UseCashtags'

test('parse: the common shapes', () => {
  const ok = (t) => { const r = parseTweet(t); assert.ok(r.ok, `${t}: ${r.message}`); return r.request }
  assert.deepEqual(ok('@UseCashtags $PEPE'), { symbol: 'PEPE', name: 'PEPE', mode: null, pair: null })
  assert.deepEqual(ok('@UseCashtags launch $DOGE Doge Coin'), { symbol: 'DOGE', name: 'Doge Coin', mode: null, pair: null })
  assert.deepEqual(ok('@UseCashtags deploy "Space Cats" $SCAT'), { symbol: 'SCAT', name: 'Space Cats', mode: null, pair: null })
  assert.equal(ok('hey @UseCashtags make me a token called Bread, ticker $BREAD').name, 'Bread')
  assert.equal(ok('@UseCashtags make me a token called Token Cat $TCAT').name, 'Token Cat')
  assert.equal(ok('@UseCashtags $doge').symbol, 'DOGE')
  assert.equal(ok('@UseCashtags $DOGE https://t.co/abc123').name, 'DOGE')
  assert.equal(ok('@UseCashtags $DOGE for @alice').name, 'DOGE')
})

test('parse: the fee phrase is lifted out of the name (the mode itself is the site setting)', () => {
  const r = parseTweet('@UseCashtags $DOGE Doge Coin, fees to holders')
  assert.deepEqual(r.request, { symbol: 'DOGE', name: 'Doge Coin', mode: 'holders', pair: null })
  assert.equal(parseTweet('@UseCashtags launch $X for holders').request.mode, 'holders')
  assert.equal(parseTweet('@UseCashtags $DH Diamond Holders').request.name, 'Diamond Holders')
  assert.equal(parseTweet('@UseCashtags $DH Diamond Holders').request.mode, null)
  // quoted names are the author's exact words
  assert.deepEqual(parseTweet('@UseCashtags "Fees To Holders" $FTH').request, { symbol: 'FTH', name: 'Fees To Holders', mode: null, pair: null })
})

test('parse: a custom pair is lifted out (ticker or address) and never taken for the coin\'s ticker or name', () => {
  const r = (t) => parseTweet(t).request
  assert.deepEqual(r('@UseCashtags launch $FROG paired with $BONK'), { symbol: 'FROG', name: 'FROG', mode: null, pair: '$BONK' })
  assert.deepEqual(r('@UseCashtags $FROG Frog Club pair with 3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump'), { symbol: 'FROG', name: 'Frog Club', mode: null, pair: '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump' })
  assert.equal(r('@UseCashtags pair with $bonk launch $FROG').symbol, 'FROG')
  assert.equal(r('@UseCashtags pair with $bonk launch $FROG').pair, '$BONK')
  assert.equal(r('@UseCashtags $FROG pairing it against $USDC').pair, '$USDC')
  assert.equal(r('@UseCashtags $FROG "Frog paired with Bonk"').pair, null, 'a quoted name is the author\'s words')
  assert.equal(r('@UseCashtags $FROG "Frog paired with Bonk"').name, 'Frog paired with Bonk')
  assert.equal(r('@UseCashtags $PAIR pair').pair, null)
  assert.ok(hasLaunchIntent('@UseCashtags $FROG paired with $BONK'))
})

test('parse: refusals', () => {
  assert.equal(parseTweet('@UseCashtags launch something').code, 'no-ticker')
  assert.equal(parseTweet('@UseCashtags $ABCDEFGHIJK').code, 'bad-ticker')
  assert.equal(parseTweet('@UseCashtags $X ' + 'n'.repeat(40)).code, 'name-too-long')
  // pump.fun counts BYTES: 11 CJK characters are 33 bytes and would fail on chain
  assert.equal(parseTweet('@UseCashtags $X ' + '猫'.repeat(11)).code, 'name-too-long')
  assert.equal(parseTweet('@UseCashtags $X ' + '猫'.repeat(10)).request.name, '猫'.repeat(10))
  assert.equal(parseTweet('@UseCashtags $X​​').request.name, 'X') // zero-width stripped
})

test('isLaunchRequest: retweets, own posts, unrelated mentions', () => {
  const m = (text, extra = {}) => ({ text, authorHandle: 'alice', ...extra })
  assert.ok(isLaunchRequest(m('@UseCashtags $DOGE'), H))
  assert.ok(isLaunchRequest(m('@UseCashtags launch $DOGE Doge Coin'), H))
  assert.ok(isLaunchRequest(m('hey @UseCashtags can you make $BREAD'), H))
  assert.ok(!isLaunchRequest(m('@UseCashtags gm, follow back?'), H))
  assert.ok(!isLaunchRequest(m('@UseCashtags launch something'), H), 'no ticker: not answered')
  assert.ok(!isLaunchRequest(m('@UseCashtags $BTC $ETH $SOL all pumping'), H), 'shill list')
  assert.ok(!isLaunchRequest(m('$SOL looking strong today @UseCashtags'), H), 'market comment: ticker not first, no launch word')
  assert.ok(!isLaunchRequest(m('@UseCashtags @bob nice one $DOGE', { inReplyToId: '5' }), H), 'only tagged by the thread')
  assert.ok(isLaunchRequest(m('@UseCashtags @bob launch $FROG', { inReplyToId: '5' }), H), 'in a thread with a launch word')
  assert.ok(!isLaunchRequest(m('@UseCashtags $DOGE', { isRetweet: true }), H))
  assert.ok(!isLaunchRequest(m('@alice $DOGE is live', { authorHandle: 'UseCashtags' }), H))
  assert.ok(isLaunchRequest(m('@UseCashtags $CASHTAG', { authorHandle: 'UseCashtags' }), H, { allowSelf: true }))
  assert.ok(!isLaunchRequest(m('@UseCashtagsFan $DOGE'), H))
})

test('replies: carry ticker and CA, end with "CA: <mint>"; fit a tweet; deterministic; no banned characters', () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const r = launchedReply({ symbol: 'DOGE', name: 'Doge Coin', mint, url: `https://cashtags.family/t/${mint}` })
  assert.ok(r.includes('$DOGE') && r.endsWith(`\n\nCA: ${mint}`) && !r.includes('http'), r)
  assert.equal(r, launchedReply({ symbol: 'DOGE', name: 'Doge Coin', mint, url: `https://cashtags.family/t/${mint}` }))
  const long = launchedReply({ symbol: 'ABCDEFGHIJ', name: 'N'.repeat(32), mint, url: `https://cashtags.family/t/${mint}`, mode: 'holders', pair: null })
  assert.ok(tweetLength(long) <= 280)
  for (const t of [r, long, rejectedReply('a — b')]) assert.ok(!/—|--|#|\p{Extended_Pictographic}/u.test(t), t)
})

test('replies never carry emojis, hashtags, "--" or long dashes, even from the name someone typed', () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const bad = /[\p{Extended_Pictographic}#—–]|--/u
  for (const name of ['Doge 🚀🚀 #moon', 'Rocket -- Ship', 'Frog — Club', '🇺🇸 Freedom ❤️', 'Coin.', '#️⃣ Hash']) {
    const r = launchedReply({ symbol: 'DOGE', name, mint, url: `https://cashtags.family/t/${mint}` })
    assert.ok(!bad.test(r), r)
    assert.ok(r.includes(mint))
    assert.ok(!r.includes('..'), r)
  }
  assert.ok(!launchedReply({ symbol: 'DOGE', name: 'Doge 🚀 #moon', mint, url: 'u' }).includes('moon'))
  for (const reason of ['an account needs 25 followers -- sorry 😢', 'a ticker is 1 to 10 characters', 'You can launch 3 coins a day. Try again tomorrow.']) {
    const r = rejectedReply(reason)
    assert.ok(!bad.test(r), r)
    assert.match(r, /^[A-Z].*[.!?]$/)
  }
  assert.ok(!bad.test(failedReply()))
})

test('images: only X media is fetched; description is short', () => {
  assert.ok(isAllowedImageHost('https://pbs.twimg.com/media/abc.jpg'))
  assert.ok(!isAllowedImageHost('http://pbs.twimg.com/media/abc.jpg'))
  assert.ok(!isAllowedImageHost('https://evil.example/pbs.twimg.com.jpg'))
  assert.ok(describe({ symbol: 'ABCDEFGHIJ', handle: 'a'.repeat(15), publicUrl: 'https://cashtags.family' }).length < 200)
})

test('fee wallets: deterministic per mint, different per mint and per seed', () => {
  const s1 = parseSeed('11'.repeat(32)), s2 = parseSeed('22'.repeat(32))
  const m1 = Keypair.generate().publicKey.toBase58(), m2 = Keypair.generate().publicKey.toBase58()
  assert.equal(feeWallet(s1, m1).publicKey.toBase58(), feeWallet(s1, m1).publicKey.toBase58())
  assert.notEqual(feeWallet(s1, m1).publicKey.toBase58(), feeWallet(s1, m2).publicKey.toBase58())
  assert.notEqual(feeWallet(s1, m1).publicKey.toBase58(), feeWallet(s2, m1).publicKey.toBase58())
  assert.throws(() => parseSeed('abc'))
})

function coinDb() {
  const db = openDb(':memory:')
  const mint = Keypair.generate().publicKey.toBase58()
  db.prepare("INSERT INTO users (x_id, handle, seen_at) VALUES ('1', 'alice', 0)").run()
  db.prepare(`INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at) VALUES (?, 'Doge', 'DOGE', '1', 'alice', ?, 'creator', 0)`).run(mint, Keypair.generate().publicKey.toBase58())
  return { db, mint, coin: db.prepare('SELECT * FROM tokens').get() }
}

test('buckets: credits go to the mode at the time; outflows reserve; expired releases', () => {
  const { db, mint, coin } = coinDb()
  assert.equal(creditSurplus(db, coin, RENT_FLOOR), 0) // just the floor: nothing new
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1000), 1000)
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1000), 0) // idempotent: same balance credits nothing
  db.prepare("UPDATE tokens SET mode = 'holders' WHERE mint = ?").run(mint)
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1500), 500)
  assert.deepEqual([buckets(db, mint).creator, buckets(db, mint).holders], [1000, 500])
  // a payout in flight blocks credits and reserves its amount
  db.prepare("INSERT INTO outflows (mint, bucket, lamports, kind, state, time) VALUES (?, 'creator', 600, 'payout', 'sending', 0)").run(mint)
  assert.equal(creditSurplus(db, coin, RENT_FLOOR + 1500 + 999), 0)
  assert.equal(buckets(db, mint).creator, 400)
  db.prepare("UPDATE outflows SET state = 'expired'").run()
  assert.equal(buckets(db, mint).creator, 1000)
  assert.equal(owedTo(db, '1').total, 1000)
})

test('coin lock: a conditional UPDATE, one holder at a time', () => {
  const { db, mint } = coinDb()
  assert.ok(lockCoin(db, mint))
  assert.ok(!lockCoin(db, mint))
  unlockCoin(db, mint)
  assert.ok(lockCoin(db, mint))
})

test('airdrop plan: pro rata, wallets only, minimums, rent-safe, sums within the pot', () => {
  const w = () => Keypair.generate().publicKey.toBase58()
  const pda = PublicKey.findProgramAddressSync([Buffer.from('x')], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58()
  const [a, b, c, dust, empty] = [w(), w(), w(), w(), w()]
  const T = 1_000_000n
  const holders = [
    { owner: a, amount: 600_000n * T }, { owner: b, amount: 300_000n * T }, { owner: c, amount: 100_000n * T },
    { owner: dust, amount: 10n * T }, { owner: pda, amount: 5_000_000n * T }, { owner: empty, amount: 200_000n * T },
  ]
  const lamportsOf = new Map([[a, 1e9], [b, 1e9], [c, 1e9], [dust, 1e9], [empty, 0]])
  const plan = planAirdrop(holders, 100_000_000, { holderMinTokens: 100_000n * T, maxHolders: 100, minShare: 10_000, lamportsOf })
  const by = Object.fromEntries(plan.map((p) => [p.owner, p.lamports]))
  assert.ok(!(pda in by), 'program accounts are never paid')
  assert.ok(!(dust in by), 'below the token minimum')
  // `empty` would get 100M*200k/1.2M = 16.6M > rent floor: kept
  assert.ok(empty in by)
  assert.equal(by[a], Math.floor(100_000_000 * 600_000 / 1_200_000))
  assert.ok(plan.reduce((s, p) => s + p.lamports, 0) <= 100_000_000)
  // a tiny pot: an empty wallet's share under the rent floor is dropped and the rest re-divided
  const small = planAirdrop(holders, 2_000_000, { holderMinTokens: 100_000n * T, maxHolders: 100, minShare: 10_000, lamportsOf })
  assert.ok(!small.some((p) => p.owner === empty))
  assert.equal(small.find((p) => p.owner === a).lamports, Math.floor(2_000_000 * 600 / 1000))
})

test('guards: personal rules refuse, capacity defers, closed launching defers everyone', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ MIN_FOLLOWERS: '25', MIN_ACCOUNT_AGE_DAYS: '14', LAUNCH_RAMP: '0', MIN_SPACING_SECONDS: '45', PER_AUTHOR_COOLDOWN_SECONDS: '3600' })
  const s = { authorId: '1', authorHandle: 'alice', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'DOGE' }
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  assert.equal(checkGuards(db, g, { ...s, authorFollowers: 3 }).code, 'too-few-followers')
  assert.equal(guardConfig({}).perAuthorDailyLimit, 0, 'no daily cap (operator 11 Nov)')
  assert.equal(guardConfig({}).perAuthorCooldownSeconds, 1800, 'one launch every 30 minutes (operator 11 Nov)')
  assert.equal(checkGuards(db, g, { ...s, authorCreatedAt: now() - 86400 }).code, 'account-too-new')
  kvSet(db, LAUNCHING_CLOSED, 'x')
  const v = checkGuards(db, g, s)
  assert.equal(v.code, 'launching-closed'); assert.ok(v.defer)
  kvDel(db, LAUNCHING_CLOSED)
  db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at) VALUES ('t1', '1', 'alice', '', 0, 0, 'launched', ?, 0)").run(now() - 10)
  assert.equal(checkGuards(db, g, s).code, 'cooldown')
  const other = { ...s, authorId: '2', authorHandle: 'bob' }
  const sp = checkGuards(db, g, other)
  assert.equal(sp.code, 'spacing'); assert.ok(sp.defer)
  // the ramp can only make it quieter
  const ramped = rampFor(db, { ...g, rampEnabled: true })
  assert.ok(ramped.spacing >= g.minSpacingSeconds && ramped.hourly <= g.globalHourlyLimit)
})

test('bot: known tweets skipped before any billable read, rejections replied once a day, platform request bypasses closure', async () => {
  const db = openDb(':memory:')
  kvSet(db, LAUNCHING_CLOSED, 'x')
  const x = new FixtureX(H)
  const t = now()
  const author = { authorId: '7', authorHandle: 'alice', authorName: 'Alice', authorFollowers: 500, authorCreatedAt: t - 400 * 86400, authorAvatar: null, mediaUrl: null, isRetweet: false }
  x.mentions.push({ ...author, id: '100', text: '@UseCashtags $DOGE', createdAt: t, inReplyToId: '55', url: 'u' })
  x.mentions.push({ ...author, id: '101', text: '@UseCashtags launch $ABCDEFGHIJKLM', createdAt: t, inReplyToId: null, url: 'u' })
  x.mentions.push({ ...author, id: '102', text: '@UseCashtags launch $ABCDEFGHIJKLMN again', createdAt: t, inReplyToId: null, url: 'u' })
  x.mentions.push({ ...author, id: '103', text: '@UseCashtags gm', createdAt: t, inReplyToId: null, url: 'u' })
  x.mentions.push({ ...author, authorId: '999', authorHandle: H, id: '104', text: `@${H} $CASHTAG`, createdAt: t, inReplyToId: null, url: 'u' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0' }), env: { X_HANDLE: H, PLATFORM_X_ID: '999', PROJECT_TICKER: 'CASHTAG' }, publicUrl: 'https://cashtags.family' })
  const r = await bot.poll()
  assert.equal(r.added, 4) // gm is not a request
  const st = Object.fromEntries(db.prepare('SELECT tweet_id, state, reply_state, platform FROM mentions').all().map((m) => [m.tweet_id, m]))
  assert.equal(st['100'].state, 'queued')
  assert.equal(st['101'].reply_state, 'pending')
  assert.equal(st['102'].reply_state, 'skipped') // one rejection reply per account per day
  assert.equal(st['104'].platform, 1)
  const again = await bot.poll()
  assert.equal(again.added, 0)
  assert.equal(x.calls.tweet, 0, 'no billable per-tweet lookups at poll time')
  // the queue defers strangers while closed (the platform request is first in line, and needs the chain: not run here)
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE tweet_id = '104'").run()
  const q = await bot.processQueue()
  assert.equal(q.deferred, 'launching-closed')
})

test('bot: "fees to holders" in a post does not choose the mode (the site setting does), and stays out of the name', async () => {
  const db = openDb(':memory:')
  const x = new FixtureX(H)
  x.mentions.push({ id: '300', text: '@UseCashtags $FROG Frog Club, fees to holders', createdAt: now(), authorHandle: 'erin', authorId: '31', authorName: 'Erin',
    authorFollowers: 500, authorCreatedAt: now() - 400 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'u' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0' }), env: { X_HANDLE: H }, publicUrl: 'https://cashtags.family' })
  await bot.poll()
  const m = db.prepare("SELECT name, mode FROM mentions WHERE tweet_id = '300'").get()
  assert.equal(m.name, 'Frog Club')
  assert.equal(m.mode, null)
})

test('guards: no daily cap, one launch per account every 30 minutes, refused with a clean sentence', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ LAUNCH_RAMP: '0', MIN_SPACING_SECONDS: '0' })
  const s = { authorId: '9', authorHandle: 'zed', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'X' }
  const add = (i, ago) => db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at) VALUES (?, '9', 'zed', '', 0, 0, 'launched', ?, 0)").run(`d${i}`, now() - ago)
  // 20 launches earlier today, each 31+ minutes apart: the next one is still allowed
  for (let i = 0; i < 20; i++) add(i, 31 * 60 * (i + 1))
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  add(99, 18 * 60)
  const v = checkGuards(db, g, s)
  assert.equal(v.code, 'cooldown')
  assert.equal(v.reason, 'You can launch one token every 30 minutes. Try again in 12 minutes.')
})

test('bot filter: automated, default avatar, digit handles, follow farms and firehoses are dropped silently', async () => {
  const { botReason } = await import('../api/botfilter.mjs')
  const t = now()
  const real = { authorHandle: 'alice', authorFollowers: 300, authorFollowing: 400, authorTweets: 2000, authorCreatedAt: t - 400 * 86400, authorAvatar: 'https://pbs.twimg.com/profile_images/1/a.jpg', authorAutomated: false, authorVerified: false }
  assert.equal(botReason(real, t), null)
  assert.match(botReason({ ...real, authorAutomated: true }, t), /automated/)
  assert.match(botReason({ ...real, authorAvatar: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' }, t), /default/)
  assert.match(botReason({ ...real, authorHandle: 'user8812345678' }, t), /handle/)
  assert.match(botReason({ ...real, authorFollowers: 40, authorFollowing: 4000 }, t), /follows/)
  assert.match(botReason({ ...real, authorTweets: 200000 }, t), /hundreds/)
  assert.equal(botReason({ ...real, authorHandle: 'user8812345678', authorVerified: true }, t), null, 'blue-verified: only the X label counts')
  // through the bot: recorded, never queued, never answered
  const db = openDb(':memory:')
  const x = new FixtureX(H)
  x.mentions.push({ ...real, authorId: '66', authorName: 'b', id: '400', text: '@UseCashtags $SPAM', createdAt: t, authorAutomated: true, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'u' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({}), env: { X_HANDLE: H }, publicUrl: 'https://cashtags.family' })
  await bot.poll()
  const row = db.prepare("SELECT state, code, reply_state FROM mentions WHERE tweet_id = '400'").get()
  assert.deepEqual({ ...row }, { state: 'rejected', code: 'bot', reply_state: 'skipped' })
})

test('refusals: only fixable mistakes and the daily limit are answered; too few followers or too new is silent', async () => {
  const db = openDb(':memory:')
  kvSet(db, 'initialised', '1')
  const x = new FixtureX(H)
  const t = now()
  const base = { authorName: 'n', authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: 'u', createdAt: t, authorCreatedAt: t - 400 * 86400 }
  x.mentions.push({ ...base, id: '500', authorId: '71', authorHandle: 'tiny', authorFollowers: 2, text: '@UseCashtags $TINY' })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0' }), env: { X_HANDLE: H }, publicUrl: 'https://cashtags.family' })
  await bot.poll()
  const q = await bot.processQueue()
  assert.equal(q.rejected, 'too-few-followers')
  assert.equal(db.prepare("SELECT reply_state FROM mentions WHERE tweet_id = '500'").get().reply_state, 'skipped')
})

test('coin image priority: own image, then the replied-to post, then the quoted post, then the Cashtags logo', async () => {
  const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)])
  const served = { 'own.jpg': png(16), 'parent.jpg': png(17), 'quoted.jpg': png(18) }
  const fetched = []
  const fetchImpl = async (url) => { const k = new URL(url).pathname.split('/').pop(); fetched.push(k); if (!served[k]) throw new Error('404'); return served[k] }
  const x = { fetchTweet: async (id) => (id === 'p1' ? { mediaUrl: 'https://pbs.twimg.com/media/parent.jpg' } : null) }
  const M = (o) => ({ symbol: 'DOGE', mediaUrl: null, inReplyToId: null, quotedMediaUrl: null, ...o })
  const own = 'https://pbs.twimg.com/media/own.jpg', parent = 'p1', quoted = 'https://pbs.twimg.com/media/quoted.jpg'
  assert.equal((await chooseImage({ mention: M({ mediaUrl: own, inReplyToId: parent, quotedMediaUrl: quoted }), x, fetchImpl })).source, 'tweet', 'own image wins over the parent')
  fetched.length = 0
  assert.equal((await chooseImage({ mention: M({ inReplyToId: parent, quotedMediaUrl: quoted }), x, fetchImpl })).source, 'parent')
  assert.equal((await chooseImage({ mention: M({ quotedMediaUrl: quoted }), x, fetchImpl })).source, 'quoted')
  const none = await chooseImage({ mention: M({}), x, fetchImpl })
  assert.equal(none.source, 'logo')
  assert.ok(none.bytes.equals(readFileSync(new URL('../api/assets/project-token.png', import.meta.url))), 'the Cashtags logo')
  // own image fails to download: falls back to the parent, not straight to a letter
  assert.equal((await chooseImage({ mention: M({ mediaUrl: 'https://pbs.twimg.com/media/gone.jpg', inReplyToId: parent }), x, fetchImpl })).source, 'parent')
  // never fetched from anywhere but X's media host
  assert.equal((await chooseImage({ mention: M({ mediaUrl: 'https://evil.example/own.jpg' }), x, fetchImpl })).source, 'logo')
  // the medium size is asked for
  const urls = []
  await chooseImage({ mention: M({ mediaUrl: own }), x, fetchImpl: async (u) => { urls.push(u); return png(16) } })
  assert.match(urls[0], /name=medium/)
})

test('a mention keeps its own, parent and quoted image sources from the X payload', async () => {
  const { toMention } = await import('../api/x.mjs')
  const m = toMention({ id: '1', text: '@UseCashtags $DOGE', author: { userName: 'a', id: '2' }, inReplyToId: '9',
    extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/own.jpg' }] },
    quoted_tweet: { extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/q.jpg' }] } } })
  assert.equal(m.mediaUrl, 'https://pbs.twimg.com/media/own.jpg')
  assert.equal(m.inReplyToId, '9')
  assert.equal(m.quotedMediaUrl, 'https://pbs.twimg.com/media/q.jpg')
})

test('coin links: the launch post as the X link (always x.com form), the site as the website', () => {
  assert.equal(SITE_URL, 'https://cashtags.family/')
  assert.equal(tweetLink({ tweet_id: '1855', author_handle: 'alice', url: 'https://twitter.com/alice/status/1855?s=20' }), 'https://x.com/alice/status/1855')
  assert.equal(tweetLink({ id: '77', authorHandle: '@bob' }), 'https://x.com/bob/status/77')
})

test('a ticker with no name (or only filler like lfg) is named after the ticker; reply wording per operator 10 Nov', async () => {
  const { parseTweet } = await import('../api/parse.mjs')
  const { launchedReply, failedReply } = await import('../api/replies.mjs')
  for (const t of ['@UseCashtags $PEPE', '@UseCashtags launch $PEPE', '@UseCashtags $PEPE lfg', '@UseCashtags $PEPE now pls ser']) assert.equal(parseTweet(t).request.name, 'PEPE', t)
  assert.equal(parseTweet('@UseCashtags $PEPE Pepe The Frog').request.name, 'Pepe The Frog')
  const banned = /is out\b|Claim or set payouts|Details at|Tag us with a ticker/
  for (let i = 0; i < 60; i++) {
    const mint = `${i}abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQcash`
    for (const mode of ['creator', 'holders', 'platform']) assert.doesNotMatch(launchedReply({ symbol: 'PEPE', name: 'PEPE', mint, url: 'https://cashtags.family', mode }), banned)
  }
  assert.equal(launchedReply({ symbol: 'CASHTAG', name: 'Cashtag', mint: 'Mintcash', url: 'https://cashtags.family', mode: 'platform' }), '$CASHTAG is live.\n\nCA: Mintcash')
  assert.ok(launchedReply({ symbol: 'PILL', name: 'PILL', mint: 'Mintcash', url: 'https://cashtags.family/t/Mintcash', mode: 'holders', pair: 'Pump' })=== '$PILL is live paired with $PUMP\n\nCA: Mintcash')
  assert.ok(launchedReply({ symbol: 'PILL', name: 'Pill Club', mint: 'Mintcash', url: 'https://x', mode: 'creator', pair: 'Pump' })=== '$PILL is live paired with $PUMP\n\nCA: Mintcash')
  assert.ok(/^\$FROG [a-zA-Z ]+\.\n\nCA: Mintcash$/.test(launchedReply({ symbol: 'FROG', name: 'Frog Club', mint: 'Mintcash' })))
  assert.equal(failedReply(), 'That launch did not go through. Posting again puts it back in the queue.')
})

test('a store made by an older version gains every newer column (the live box had xmoney_payouts before carry_usdc)', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'ct-old-')), 'old.db')
  const old = new DatabaseSync(path)
  // the table exactly as the first X Money deploy (04:19 UTC 11 Nov) created it
  old.exec(`CREATE TABLE xmoney_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, x_id TEXT NOT NULL, handle TEXT NOT NULL, state TEXT NOT NULL,
    collect_sigs TEXT NOT NULL DEFAULT '[]', lamports INTEGER NOT NULL DEFAULT 0, refund_mint TEXT, sol_usd REAL, relay_request TEXT, relay_sig TEXT,
    relay_lvh INTEGER, relay_attempts INTEGER NOT NULL DEFAULT 0, usdc INTEGER NOT NULL DEFAULT 0, deposit_id TEXT, list_started_at INTEGER,
    listed_at INTEGER, relists INTEGER NOT NULL DEFAULT 0, filled_usdc INTEGER NOT NULL DEFAULT 0, paid_usd REAL NOT NULL DEFAULT 0,
    cur_filled_usdc INTEGER NOT NULL DEFAULT 0, cur_paid_usd REAL NOT NULL DEFAULT 0, return_usdc INTEGER NOT NULL DEFAULT 0, return_request TEXT,
    return_started_at INTEGER, returned_lamports INTEGER NOT NULL DEFAULT 0, credit_sig TEXT, credit_lvh INTEGER, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER)`)
  old.close()
  const db = openDb(path)
  const cols = db.prepare('PRAGMA table_info(xmoney_payouts)').all().map((c) => c.name)
  for (const c of ['carry_usdc', 'carry_used', 'cur_filled_usdc', 'cur_paid_usd']) assert.ok(cols.includes(c), c)
  // the X Money pass runs its queries against it without throwing
  const { xmoneyPass } = await import('../api/xmoney.mjs')
  const out = await xmoneyPass({ db, conn: null, keeper: null, seed: Buffer.alloc(32), rails: null, cfg: { minLamports: 1, dustUsdc: 500_000 }, log: { error() {} } })
  assert.deepEqual(out, [])
})

test('operator 11 Nov: no global cap, no spacing, no ramp by default; only one launch per account per 30 minutes', () => {
  const db = openDb(':memory:')
  const g = guardConfig({})
  assert.equal(g.globalHourlyLimit, Infinity); assert.equal(g.minSpacingSeconds, 0); assert.equal(g.rampEnabled, false)
  const ins = db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at) VALUES (?, ?, ?, '', 0, 0, 'launched', ?, 0)")
  for (let i = 0; i < 200; i++) ins.run(`b${i}`, String(5000 + i), `u${i}`, now() - 5 - i) // 200 launches by others in the last minutes
  const s = { authorId: '42', authorHandle: 'new', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'X' }
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  ins.run('mine', '42', 'new', now() - 60)
  assert.equal(checkGuards(db, g, s).code, 'cooldown')
})

test('the operator replying "@UseCashtags launch $CASHTAG" under their own intro post is caught even when X leaves it out of the mentions', async () => {
  const db = openDb(':memory:')
  kvSet(db, LAUNCHING_CLOSED, 'x')
  const x = new FixtureX('UseCashtags')
  const t = now()
  const op = { authorId: '2120180575294099456', authorHandle: 'UseCashtags', authorName: 'Cashtags', authorFollowers: 10, authorCreatedAt: t - 86400, authorAvatar: null, mediaUrl: null, isRetweet: false, url: 'u' }
  const stranger = { ...op, authorId: '55', authorHandle: 'eve', authorName: 'Eve', authorFollowers: 900, authorCreatedAt: t - 900 * 86400 }
  // X's mention search returns NOTHING for it; the reply sits only under the intro post (2120402994042941692)
  x.replyThreads = new Map([['2120402994042941692', [
    { ...stranger, id: '900', text: '@UseCashtags launch $CASHTAG', createdAt: t - 30, inReplyToId: '2120402994042941692' },
    { ...op, id: '901', text: '@UseCashtags launch $CASHTAG', createdAt: t - 10, inReplyToId: '2120402994042941692' },
  ]]])
  const env = { X_HANDLE: 'UseCashtags', PLATFORM_X_ID: '2120180575294099456', PROJECT_TICKER: 'CASHTAG', PROJECT_NAME: 'CASHTAG', PLATFORM_WATCH_TWEET: '2120402994042941692' }
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({}), env, publicUrl: 'https://cashtags.family' })
  const r = await bot.poll()
  assert.equal(r.read, 0, 'nothing came through the mention search')
  assert.deepEqual(r.platformWatch, { replies: 2, mine: 1, added: 1 })
  const row = db.prepare("SELECT * FROM mentions WHERE tweet_id = '901'").get()
  assert.equal(row.platform, 1); assert.equal(row.state, 'queued'); assert.equal(row.symbol, 'CASHTAG'); assert.equal(row.name, 'CASHTAG')
  assert.equal(db.prepare("SELECT count(*) n FROM mentions WHERE tweet_id = '900'").get().n, 0, "a stranger's reply under the intro post is not taken from there")
  // once it is queued the watch stops reading (no paid reads after the platform request exists)
  kvSet(db, 'platform_watch_at', 0)
  const calls = x.calls.replies
  await bot.poll()
  assert.equal(x.calls.replies, calls)
  // the by-hand fallback: the same post by id is recognised as already taken (never a second platform row)
  x.tweets.set('901', { mention: { ...op, id: '901', text: '@UseCashtags launch $CASHTAG', createdAt: t - 10, inReplyToId: '2120402994042941692' } })
  const again = await bot.ingestTweetId('901')
  assert.equal(again.added, 0); assert.equal(again.row.platform, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM mentions WHERE platform = 1').get().n, 1)
})

test('the by-hand fallback alone: a post id the watch never saw becomes the platform request', async () => {
  const db = openDb(':memory:')
  const x = new FixtureX('UseCashtags')
  const t = now()
  x.tweets.set('777', { mention: { id: '777', text: '@UseCashtags launch $CASHTAG', createdAt: t, authorId: '2120180575294099456', authorHandle: 'UseCashtags', authorName: 'Cashtags',
    authorFollowers: 10, authorCreatedAt: t - 86400, authorAvatar: null, mediaUrl: null, isRetweet: false, url: 'u', inReplyToId: '2120402994042941692' } })
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({}),
    env: { X_HANDLE: 'UseCashtags', PLATFORM_X_ID: '2120180575294099456', PROJECT_TICKER: 'CASHTAG', PROJECT_NAME: 'CASHTAG' }, publicUrl: 'https://cashtags.family' })
  const r = await bot.ingestTweetId('777')
  assert.equal(r.added, 1); assert.equal(r.row.platform, 1); assert.equal(r.row.state, 'queued')
})

test('feetrack: a holder-reward coin counts every lamport collected into its holder-rewards account and paid out of it, oldest first, nothing twice or skipped', async () => {
  const { trackExternalFees } = await import('../api/feetrack.mjs')
  const { holderRewardsAddress } = await import('../lib/pump.mjs')
  const db = openDb(':memory:')
  const mint = Keypair.generate().publicKey.toBase58()
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at, native_holders) VALUES (?, 'x', 'X', '1', 'x', 'w', 'holders', 0, 1)").run(mint)
  const pda = holderRewardsAddress(new PublicKey(mint)).toBase58()
  // newest first, as the RPC returns them: created+collect, distribute, collect, distribute
  let sigs = [
    { signature: 's4', err: null, blockTime: 400 }, { signature: 's3', err: null, blockTime: 300 },
    { signature: 's2', err: null, blockTime: 200 }, { signature: 's1', err: null, blockTime: 100 },
  ]
  const txs = { s1: [0, 890_880 + 5_000_000], s2: [5_890_880, 890_880], s3: [890_880, 3_890_880], s4: [3_890_880, 1_890_880] }
  const conn = {
    async _rpcRequest(method, params) {
      if (method === 'getSignaturesForAddress') { const until = params[1].until; const i = until ? sigs.findIndex((s) => s.signature === until) : sigs.length; return { result: sigs.slice(0, i < 0 ? sigs.length : i) } }
      if (method === 'getTransaction') { const [pre, post] = txs[params[0]]; return { result: { transaction: { message: { accountKeys: ['payer', pda] } }, meta: { preBalances: [1e9, pre], postBalances: [1e9, post], fee: 5000, logMessages: [] } } } }
    },
    async getMultipleAccountsInfo(keys) { return keys.map(() => null) },
  }
  const row = () => db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint)
  // a budget of 2: the OLDEST two are counted first, the rest next pass (never the newest first)
  await trackExternalFees(db, conn, row(), { maxTx: 2 })
  assert.equal(row().ext_sig, 's2'); assert.equal(row().ext_in, 5_890_880); assert.equal(row().ext_out, 5_000_000)
  await trackExternalFees(db, conn, row())
  assert.equal(row().ext_in, 5_890_880 + 3_000_000, 'every lamport in: no rent is assumed (pump.fun drains the PDA below it)')
  assert.equal(row().ext_out, 5_000_000 + 2_000_000, 'paid out to holders: 5M + 2M')
  assert.equal(row().ext_sig, 's4')
  // a second pass with no new transactions changes nothing
  await trackExternalFees(db, conn, row())
  assert.equal(row().ext_in, 8_890_880); assert.equal(row().ext_out, 7_000_000)
  // a new collect arrives: only it is counted
  sigs = [{ signature: 's5', err: null, blockTime: 500 }, ...sigs]; txs.s5 = [1_890_880, 2_390_880]
  await trackExternalFees(db, conn, row())
  assert.equal(row().ext_in, 9_390_880); assert.equal(row().ext_sig, 's5')
  assert.equal(row().ext_in - row().ext_out, 2_390_880, 'in − out = what the account holds now')
})

test('cashtag protection: a cashtag launched by anyone is refused for 24 hours (any case), then free again', () => {
  const db = openDb(':memory:')
  const g = guardConfig({})
  assert.equal(g.tickerHoldSeconds, 86400)
  const s = { authorId: '42', authorHandle: 'new', authorFollowers: 100, authorCreatedAt: now() - 365 * 86400, symbol: 'frog' }
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, mode, created_at) VALUES ('M1', 'Frog', 'FROG', '7', 'alice', 'w1', 'holders', ?)").run(now() - 3 * 3600)
  const v = checkGuards(db, g, s)
  assert.equal(v.code, 'ticker-taken')
  assert.equal(v.reason, '$FROG was launched in the last 24 hours. Pick another cashtag, or try again in 21 hours.')
  // even the account that launched it, and even an exempt account
  assert.equal(checkGuards(db, { ...g, exempt: ['new'] }, s).code, 'ticker-taken')
  // another cashtag is unaffected; after 24 hours FROG is free again
  assert.deepEqual(checkGuards(db, g, { ...s, symbol: 'TOAD' }), { allowed: true })
  db.prepare("UPDATE tokens SET created_at = ? WHERE mint = 'M1'").run(now() - 86400 - 10)
  assert.deepEqual(checkGuards(db, g, s), { allowed: true })
})


test('launching FOR @someone: parsed from the raw text, never from a quoted name; "for holders" stays the fee phrase', () => {
  assert.equal(parseTweet('@UseCashtags launch $DOGE for @alice').request.forHandle, 'alice')
  assert.equal(parseTweet('@UseCashtags Launch $CASHTAG for @user').request.symbol, 'CASHTAG')
  const r = parseTweet('@UseCashtags $FROG Frog Coin for @bob_99, fees to holders').request
  assert.deepEqual([r.forHandle, r.name], ['bob_99', 'Frog Coin'])
  assert.equal(parseTweet('@UseCashtags launch $CAT for holders').request.forHandle, undefined)
  assert.equal(parseTweet('@UseCashtags $Q "made for @nobody"').request.forHandle, undefined)
  assert.equal(parseTweet('@UseCashtags $X for: @Carol paired with $BONK').request.pair, '$BONK')
})

test('launching FOR @someone: resolved to their X id before launch; unknown refused with a reply; outage waits; self/bot ignored; X Money set up for a new account only', async () => {
  const db = openDb(':memory:')
  const x = new FixtureX(H)
  const t = now()
  const a = { authorId: '7', authorHandle: 'alice', authorName: 'Alice', authorFollowers: 500, authorCreatedAt: t - 400 * 86400, authorAvatar: null, mediaUrl: null, isRetweet: false, inReplyToId: null, url: 'u', createdAt: t }
  x.users = new Map([['bob', { id: '4242', handle: 'Bob', name: 'Bob', followers: 10 }], ['chosen', { id: '5151', handle: 'chosen', name: 'C', followers: 10 }]])
  x.mentions.push({ ...a, id: '500', text: '@UseCashtags launch $GM for @bob' })
  x.mentions.push({ ...a, id: '501', authorId: '8', authorHandle: 'dan', text: '@UseCashtags launch $NOPE for @ghost' })
  x.mentions.push({ ...a, id: '502', authorId: '9', authorHandle: 'erin', text: '@UseCashtags launch $ME for @erin' })
  x.mentions.push({ ...a, id: '503', authorId: '10', authorHandle: 'fay', text: '@UseCashtags launch $BOT for @UseCashtags' })
  x.mentions.push({ ...a, id: '504', authorId: '11', authorHandle: 'gus', text: '@UseCashtags launch $KEPT for @chosen' })
  // an account that already chose its own payout (claim to a wallet) keeps it
  db.prepare("INSERT INTO users (x_id, handle, seen_at, payout_kind, payout_wallet, payout_confirmed, settings_at) VALUES ('5151', 'chosen', 0, 'wallet', 'So11111111111111111111111111111111111111112', 1, 1)").run()
  const bot = createBot({ db, conn: null, pump: null, x, launcher: null, seed: null, guards: guardConfig({ LAUNCH_RAMP: '0', PER_AUTHOR_COOLDOWN_SECONDS: '0' }), env: { X_HANDLE: H, PLATFORM_X_ID: '999' }, publicUrl: 'https://cashtags.family' })
  await bot.poll()
  const row = (id) => db.prepare('SELECT * FROM mentions WHERE tweet_id = ?').get(id)
  assert.equal(row('500').for_handle, 'bob'); assert.equal(row('500').mode, 'creator', 'a launch for someone is always creator mode')
  assert.equal(row('502').for_handle, null, 'for yourself = an ordinary launch')
  assert.equal(row('503').for_handle, null, 'never for the bot itself')
  // the queue resolves each target before its launch claim (no chain here: we stop the launch at the claim by having no launcher)
  x.userInfoFails = true
  const d = await bot.processQueue()
  assert.equal(d.deferred, 'for-wait', 'a lookup outage waits, never guesses')
  assert.equal(row('500').for_id, null)
  x.userInfoFails = false
  db.prepare('UPDATE mentions SET next_try_at = 0').run()
  try { await bot.processQueue() } catch {} // resolves @bob, then the launch itself fails without a launcher
  assert.equal(row('500').for_id, '4242', 'the coin is keyed on the X id')
  assert.equal(row('500').for_handle, 'Bob', 'the handle as X spells it')
  const bob = db.prepare("SELECT payout_kind, payout_auto, payout_confirmed FROM users WHERE x_id = '4242'").get()
  assert.deepEqual({ ...bob }, { payout_kind: 'xmoney', payout_auto: 1, payout_confirmed: 0 }, 'X Money set up for an account that never chose')
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE tweet_id = '500'").run()
  const r = await bot.processQueue()
  assert.equal(r.rejected, 'for-unknown')
  assert.equal(row('501').reply_state, 'pending', 'an unknown handle is answered')
  assert.match(row('501').reason, /@ghost was not found on X/)
  db.prepare("UPDATE mentions SET state = 'rejected' WHERE tweet_id IN ('502', '503')").run()
  try { await bot.processQueue() } catch {}
  assert.equal(row('504').for_id, '5151')
  const kept = db.prepare("SELECT payout_kind, payout_auto FROM users WHERE x_id = '5151'").get()
  assert.deepEqual({ ...kept }, { payout_kind: 'wallet', payout_auto: 0 }, 'an account that chose keeps its own payout')
})

test('launch reply and description say who the coin is for', () => {
  const text = launchedReply({ symbol: 'GM', name: 'GM', mint: 'Mint1111111111111111111111111111111111cash', forHandle: 'Bob' })
  assert.match(text, /Launched for @Bob: its creator rewards go to their X Money\./)
  assert.match(text, /CA: Mint1111111111111111111111111111111111cash$/)
  assert.ok(tweetLength(text) <= 280)
})

test('operator override: one post may pass the 24 h cashtag rule; every other rule still applies', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ LAUNCH_RAMP: '0' })
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, created_at) VALUES ('M1', 'X', 'X', '1', 'a', 'FW1', ?)").run(now() - 3600)
  const s = { authorId: '7', authorHandle: 'pix', authorFollowers: 500, authorCreatedAt: now() - 400 * 86400, symbol: 'X' }
  assert.equal(checkGuards(db, g, s).code, 'ticker-taken')
  assert.equal(checkGuards(db, g, { ...s, tickerOverride: true }).allowed, true)
  assert.equal(checkGuards(db, g, { ...s, tickerOverride: true, authorFollowers: 3 }).allowed, false, 'the follower rule still applies')
})

test('buyback rounds: not before next_at; a due round schedules the next one a random 5..30 minutes away', async () => {
  const { buybackPass, buybackConfig, ensureTables } = await import('../api/buyback.mjs')
  const db = openDb(':memory:')
  ensureTables(db)
  const cfg = { ...buybackConfig({ BUYBACK_ENABLED: '1', BUYBACK_LIVE: '1' }) }
  const wallet = Keypair.generate()
  const conn = { getAccountInfo: async () => null } // no pool: the round ends before any send
  const t0 = Date.now()
  db.prepare('UPDATE buyback_lock SET next_at = ? WHERE id = 1').run(t0 + 600_000)
  const skip = await buybackPass({ db, conn, wallet, cfg, log: { info() {}, error() {} } })
  assert.equal(skip.next, new Date(t0 + 600_000).toISOString(), 'not due yet')
  db.prepare('UPDATE buyback_lock SET next_at = 0 WHERE id = 1').run()
  for (let i = 0; i < 20; i++) {
    db.prepare('UPDATE buyback_lock SET next_at = 0 WHERE id = 1').run()
    await buybackPass({ db, conn, wallet, cfg, log: { info() {}, error() {} } })
    const gap = db.prepare('SELECT next_at FROM buyback_lock').get().next_at - Date.now()
    assert.ok(gap >= 5 * 60_000 - 1000 && gap <= 30 * 60_000, `gap ${gap / 60_000} min`)
  }
})

// ── launching on the site (13 Nov) ──
import { ComputeBudgetProgram as CB, SystemProgram as SP, TransactionInstruction as TI, TransactionMessage as TM, VersionedTransaction as VT } from '@solana/web3.js'
import { LIGHTHOUSE, SiteError, sameLaunch, signedBy, validateSiteLaunch } from '../api/sitelaunch.mjs'
import { siteFields, pinOnce } from '../api/launch.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('site launch form: fields are cleaned and checked before anything is pinned (all of it is permanent on chain)', () => {
  const W = Keypair.generate().publicKey.toBase58()
  const ok = validateSiteLaunch({ wallet: W, symbol: '$doge', name: '  Doge​   Coin ', description: 'much‮ wow', website: 'doge.example/path', twitter: '@dogecoin', telegram: 't.me/doge', mode: 'creator', image: PNG.toString('base64'), devBuy: { sol: '0.5' } })
  assert.equal(ok.symbol, 'DOGE')
  assert.equal(ok.name, 'Doge Coin', 'zero-width characters and runs of spaces are gone')
  assert.equal(ok.description, 'much wow')
  assert.equal(ok.website, 'https://doge.example/path')
  assert.equal(ok.twitter, 'https://x.com/dogecoin')
  assert.equal(ok.telegram, 'https://t.me/doge')
  assert.deepEqual([ok.wallet, ok.devBuy.lamports], [W, 500_000_000])
  assert.ok(ok.image.equals(PNG))
  // nothing written: the name is the ticker, no dev buy, the account's own fee setting decides
  const bare = validateSiteLaunch({ wallet: W, symbol: 'frog', devBuy: { sol: '' } })
  assert.deepEqual([bare.name, bare.mode, bare.devBuy, bare.pair, bare.website], ['FROG', null, null, null, ''])
  const bad = (body, re) => assert.throws(() => validateSiteLaunch({ wallet: W, ...body }), (e) => e instanceof SiteError && re.test(e.message), JSON.stringify(body))
  bad({}, /ticker/)
  bad({ symbol: 'ABCDEFGHIJK' }, /up to 10/)
  bad({ symbol: '1DOGE' }, /starting with a letter/)
  bad({ symbol: 'DO GE' }, /letters and numbers/)
  bad({ symbol: 'A', name: '猫'.repeat(11) }, /up to 32/) // 33 bytes: pump.fun counts bytes
  bad({ symbol: 'A', description: 'x'.repeat(501) }, /description/)
  bad({ symbol: 'A', mode: 'cashback' }, /Creator rewards/)
  bad({ symbol: 'A', website: 'javascript:alert(1)' }, /website/)
  bad({ symbol: 'A', website: 'http://user:pw@evil.example' }, /website/)
  bad({ symbol: 'A', twitter: 'https://evil.example/x.com' }, /X link/)
  bad({ symbol: 'A', telegram: 'https://x.com/a' }, /Telegram/)
  bad({ symbol: 'A', image: Buffer.from('<svg onload=alert(1)>').toString('base64') }, /PNG, JPG/)
  // the wallet that pays is always needed, and must be a wallet
  bad({ symbol: 'A', wallet: '' }, /Connect the wallet/)
  bad({ symbol: 'A', wallet: PublicKey.findProgramAddressSync([Buffer.from('x')], SP.programId)[0].toBase58() }, /program account/)
  bad({ symbol: 'A', devBuy: { sol: '0.0001' } }, /smallest/)
  bad({ symbol: 'A', devBuy: { sol: '51' } }, /largest/)
  bad({ symbol: 'A', devBuy: { sol: 'lots' } }, /amount of SOL/)
  bad({ symbol: 'A', pair: 'not a pair!' }, /Pair with/)
  // for another X account: the handle is cleaned, and the coin always pays that account
  const forBob = validateSiteLaunch({ wallet: W, symbol: 'GM', mode: 'holders', forHandle: ' @Bob_1 ' })
  assert.deepEqual([forBob.forHandle, forBob.mode], ['Bob_1', 'creator'])
  bad({ symbol: 'A', forHandle: 'bob the builder' }, /X handle/)
})

test('site launch: the signed message must be the launch we built; a wallet may only add its own guard instructions', () => {
  // the launcher's own wallet pays: two signers, the wallet (fee payer) and the mint
  const wallet = Keypair.generate(), mint = Keypair.generate(), thief = Keypair.generate()
  const bh = Keypair.generate().publicKey.toBase58()
  const ours = [CB.setComputeUnitLimit({ units: 400_000 }), SP.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 890_880 }),
    new TI({ programId: Keypair.generate().publicKey, keys: [{ pubkey: mint.publicKey, isSigner: true, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) })]
  const msg = (ixs, blockhash = bh, payer = wallet) => new TM({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
  const who = { mint: mint.publicKey }
  const guardIx = (keys) => new TI({ programId: new PublicKey(LIGHTHOUSE), keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: Buffer.from([9]) })
  const original = msg(ours)
  assert.deepEqual(sameLaunch(original, msg(ours), who), { ok: true, changed: false })
  assert.deepEqual(sameLaunch(original, msg([...ours, guardIx([wallet.publicKey])]), who), { ok: true, changed: true }, 'Phantom-style guard on the wallet\'s own account')
  const refused = (m, re) => { const r = sameLaunch(original, m, who); assert.equal(r.ok, false); assert.match(r.reason, re) }
  refused(msg([...ours, SP.transfer({ fromPubkey: wallet.publicKey, toPubkey: thief.publicKey, lamports: 1e9 })]), /not part of the launch/)
  refused(msg([...ours, guardIx([mint.publicKey])]), /names the mint/)
  refused(msg(ours.slice(0, 2)), /other signers|missing/)
  refused(msg([ours[0], SP.transfer({ fromPubkey: wallet.publicKey, toPubkey: thief.publicKey, lamports: 890_880 }), ours[2]]), /not part of the launch/)
  refused(msg(ours, Keypair.generate().publicKey.toBase58()), /blockhash/)
  // someone else as fee payer (an extra signer)
  refused(new TM({ payerKey: thief.publicKey, recentBlockhash: bh, instructions: ours }).compileToV0Message(), /other signers/)

  // the wallet's signature is checked against the exact bytes we will send
  const tx = new VT(original); tx.sign([wallet])
  const at = original.staticAccountKeys.findIndex((k) => k.equals(wallet.publicKey))
  assert.equal(at, 0, 'the wallet is the fee payer')
  assert.equal(signedBy(wallet.publicKey, original.serialize(), tx.signatures[at]), true)
  assert.equal(signedBy(thief.publicKey, original.serialize(), tx.signatures[at]), false)
  assert.equal(signedBy(wallet.publicKey, msg([...ours, guardIx([wallet.publicKey])]).serialize(), tx.signatures[at]), false)
  assert.equal(signedBy(wallet.publicKey, original.serialize(), new Uint8Array(64)), false)
})

test('site launch metadata: the form\'s picture and links, sensible defaults, and one pin per exact content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-site-'))
  const { storeImage } = await import('../api/images.mjs')
  const file = storeImage({ logoDir: dir, publicUrl: 'https://cashtags.family' }, PNG).split('/').pop()
  const full = siteFields({ mention: { symbol: 'DOGE', author_handle: 'alice', opts: JSON.stringify({ description: 'much wow', website: 'https://doge.example/', twitter: 'https://x.com/doge', telegram: 'https://t.me/doge', imageFile: file }) }, publicUrl: 'https://cashtags.family', logoDir: dir })
  assert.deepEqual([full.description, full.website, full.twitter, full.telegram, full.img.source], ['much wow', 'https://doge.example/', 'https://x.com/doge', 'https://t.me/doge', 'upload'])
  assert.ok(full.img.bytes.equals(PNG))
  const bare = siteFields({ mention: { symbol: 'DOGE', author_handle: 'alice', opts: JSON.stringify({ imageFile: '../../etc/passwd' }) }, publicUrl: 'https://cashtags.family', logoDir: dir })
  assert.deepEqual([bare.description, bare.website, bare.twitter, bare.telegram, bare.img.source], ['$DOGE was launched by @alice on cashtags.family', SITE_URL, 'https://x.com/alice', '', 'logo'])
  const db = openDb(':memory:')
  let calls = 0
  const pin = async () => ({ uri: `https://gateway.pinata.cloud/ipfs/meta${++calls}`, imageUri: 'https://gateway.pinata.cloud/ipfs/img' })
  const f = { image: PNG, imageType: 'image/png', name: 'Doge', symbol: 'DOGE', description: 'd', website: 'w', twitter: 't', telegram: '' }
  assert.equal((await pinOnce(db, pin, f)).uri, (await pinOnce(db, pin, { ...f })).uri)
  assert.equal(calls, 1, 'the same content again pins nothing')
  await pinOnce(db, pin, { ...f, description: 'other' })
  assert.equal(calls, 2)
})

test('a store made before site launches gains the source column, and old rows read as posts', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, updated_at) VALUES ('1', '1', 'a', 't', 0, 0, 'queued', 0)").run()
  assert.equal(db.prepare("SELECT source FROM mentions WHERE tweet_id = '1'").get().source, 'x')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'site_drafts'").get())
})

test('guards: a site launch is paid by its own wallet, so only the cashtag rule and the blocklists bind it', () => {
  const db = openDb(':memory:')
  const g = guardConfig({ BLOCKED_SYMBOLS: 'SCAM', BLOCKLIST: 'badguy' })
  const who = { authorId: 'wallet:abc', authorHandle: 'abc', symbol: 'DOGE', selfPaid: true }
  // no followers, no account age, and a launch a minute ago: still allowed
  db.prepare("INSERT INTO mentions (tweet_id, author_id, author_handle, text, tweeted_at, seen_at, state, launched_at, updated_at, source) VALUES ('site-1', 'wallet:abc', 'abc', 't', 0, 0, 'launched', ?, 0, 'site')").run(now() - 60)
  assert.equal(checkGuards(db, g, who).allowed, true)
  // the same account posting on X is not held back by its site launches either (they cost the launch wallet nothing)
  assert.equal(checkGuards(db, g, { authorId: 'wallet:abc', authorHandle: 'abc', authorFollowers: 900, authorCreatedAt: now() - 900 * 86400, symbol: 'DOGE' }).allowed, true)
  assert.equal(checkGuards(db, g, { ...who, symbol: 'SCAM' }).code, 'blocked-symbol')
  assert.equal(checkGuards(db, g, { ...who, authorHandle: 'badguy' }).code, 'blocklisted')
  db.prepare("INSERT INTO tokens (mint, name, symbol, creator_id, creator_handle, fee_wallet, created_at) VALUES ('m1', 'Doge', 'DOGE', '1', 'a', 'fw1', ?)").run(now() - 100)
  assert.equal(checkGuards(db, g, who).code, 'ticker-taken')
})

test('PumpSwap price: the pool\'s virtual quote reserves are read as a signed i128 and added to the vault balance', async () => {
  const { poolVirtualQuoteReserves } = await import('../lib/pump.mjs')
  const pool = Buffer.alloc(301)
  pool.writeBigUInt64LE(17_584_505_000n, 245) // ~17.58 SOL, positive: high half zero
  assert.equal(poolVirtualQuoteReserves(pool), 17_584_505_000n)
  // negative (fees kept in the vault): two's complement across 16 bytes
  const neg = -1_234_567_890n, mask = (1n << 128n) - 1n, raw = neg & mask
  pool.writeBigUInt64LE(raw & ((1n << 64n) - 1n), 245); pool.writeBigUInt64LE(raw >> 64n, 253)
  assert.equal(poolVirtualQuoteReserves(pool), neg, 'never read as ~2^64')
  assert.equal(poolVirtualQuoteReserves(Buffer.alloc(240)), 0n, 'an old short pool account')
  const old = Buffer.alloc(255); old.writeBigUInt64LE(5n, 245)
  assert.equal(poolVirtualQuoteReserves(old), 5n, 'the u64 layout before 30 Sep')
})
