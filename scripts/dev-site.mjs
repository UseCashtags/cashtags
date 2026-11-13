// DEV ONLY: the API on :5570 against the LOCAL validator (./validator.sh), with the sign-in stub, a stub pin, the bot loop
// working the queue and the launch lookup table made, so the launch page can be used end to end at http://localhost:5575
// (cd web && npm run dev). Sign in at /api/auth/x/start?as=alice&return=/launch. Refuses any RPC that is not localhost.
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { rmSync } from 'node:fs'
import { openDb, now, kvSet } from '../api/db.mjs'
import { createApp } from '../api/server.mjs'
import { FixtureX } from '../api/x.mjs'
import { loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8891'
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC)) throw new Error('dev-site runs against a local validator only')
const conn = new Connection(RPC, 'confirmed')
for (const f of ['data/dev-site.db', 'data/dev-site.db-wal', 'data/dev-site.db-shm']) rmSync(f, { force: true })
const db = openDb('data/dev-site.db')
const launcher = Keypair.generate(), keeper = Keypair.generate()
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
await fund(launcher.publicKey, 10); await fund(keeper.publicKey, 10)
for (let i = 0; i < 20; i++) { const k = Keypair.generate(); db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now()) }
const x = new FixtureX('UseCashtags')
// every signed-in stub account passes the follower and age rules
x.userInfo = async (handle) => { const u = db.prepare('SELECT * FROM users WHERE lower(handle) = lower(?)').get(handle); return u ? { id: u.x_id, handle: u.handle, name: u.name, avatar: null, followers: 500, createdAt: now() - 400 * 86400 } : null }
const app = createApp({ env: { PUBLIC_URL: 'http://localhost:5575', DEV_STUBS: '1', FEE_SEED: 'cd'.repeat(32), START_OPEN: '1', PER_AUTHOR_COOLDOWN_SECONDS: '0', XMONEY_ENABLED: '1', TICKER_HOLD_SECONDS: '0', DATA_DIR: 'data' },
  db, conn, x, keeper, launcher, pin: async () => ({ uri: 'https://gateway.pinata.cloud/ipfs/bafkreidev', imageUri: '' }) })
if (process.env.NO_LUT !== '1') kvSet(db, 'launch_lut', (await createLaunchTable(conn, launcher, await staticLaunchAccounts(pumpProgram(conn), await loadGlobal(conn)))).toBase58())
// ── sample data, so Explore and Payments have something to show: coins from three accounts, trades, collected fees,
// a creator payout, a holders airdrop. Two coins are MARKED graduated in the dev store (nothing local really graduates).
{
  const { createHash } = await import('node:crypto')
  const { ComputeBudgetProgram, PublicKey } = await import('@solana/web3.js')
  const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token')
  const { TOKEN_2022, ata, buyExactSolInIx } = await import('../lib/pump.mjs')
  const { buildTx, sendUntilFate } = await import('../lib/tx.mjs')
  const { feeWallet } = await import('../api/feewallet.mjs')
  const { keeperPass, keeperConfig, payCreator } = await import('../api/keeper.mjs')
  const SEED = Buffer.from('cd'.repeat(32), 'hex'), pump = pumpProgram(conn), global = await loadGlobal(conn)
  const id = (h) => BigInt('0x' + createHash('sha256').update(`x:${h}`).digest('hex').slice(0, 12)).toString()
  const asks = [['alice', '$DOGE Doge Coin'], ['bob', '"Space Cats" $SCAT'], ['carol', '$FROG Frog Club'], ['bob', '$MOON Moon Shot'], ['carol', '$PEPE'], ['alice', '$CASH Cash Money'], ['carol', '$GM Good Morning for @bob'], ['alice', '$WAGMI for @carol']]
  for (const h of ['alice', 'bob', 'carol']) db.prepare("INSERT OR IGNORE INTO users (x_id, handle, name, seen_at, default_mode, settings_at, followers) VALUES (?, ?, ?, 0, 'creator', 1, 500)").run(id(h), h, h[0].toUpperCase() + h.slice(1))
  asks.forEach(([h, text], n) => x.mentions.push({ id: String(7000 + n), text: `@UseCashtags ${text}`, createdAt: now(), authorHandle: h, authorId: id(h), authorName: h, authorFollowers: 800,
    authorCreatedAt: now() - 800 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: `https://x.com/${h}/status/${7000 + n}` }))
  await app.bot.poll()
  for (let i = 0; i < asks.length * 2; i++) await app.bot.tick({ doPoll: false })
  const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
  for (const t of traders) await fund(t.publicKey, 60)
  const buyAll = async (coins) => {
    for (const coin of coins) for (const [i, t] of traders.entries()) {
      const mint = new PublicKey(coin.mint), creator = feeWallet(SEED, coin.mint).publicKey
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), createAssociatedTokenAccountIdempotentInstruction(t.publicKey, ata(t.publicKey, mint, TOKEN_2022), t.publicKey, mint, TOKEN_2022),
        await buyExactSolInIx(pump, global, { mint, user: t.publicKey, creator, lamports: BigInt((1 + i) * 1e9) })]
      const b = await buildTx(conn, { payer: t.publicKey, ixs, signers: [t] })
      await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
    }
  }
  const kcfg = keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000', HOLDER_MIN_TOKENS: '1000' })
  const pass = () => keeperPass({ db, conn, pump, keeper, seed: SEED, cfg: kcfg, log: { info() {}, error: console.error } })
  const coins = db.prepare('SELECT * FROM tokens ORDER BY created_at').all()
  await buyAll(coins); await pass()
  for (const h of ['alice', 'bob']) await payCreator(db, conn, { keeper, seed: SEED, xId: id(h), destination: Keypair.generate().publicKey.toBase58(), minLamports: 1, cfg: kcfg, solUsd: 150 })
  db.prepare("UPDATE tokens SET mode = 'holders', mode_at = ? WHERE symbol IN ('FROG', 'PEPE')").run(now())
  await buyAll(coins.filter((c) => ['FROG', 'PEPE'].includes(c.symbol))); await pass()
  db.prepare("UPDATE tokens SET graduated = 1, market_cap_usd = 84000 WHERE symbol = 'DOGE'").run()
  db.prepare("UPDATE tokens SET graduated = 1, market_cap_usd = 61000 WHERE symbol = 'SCAT'").run()
  console.log(`seeded ${coins.length} coins, ${db.prepare("SELECT count(*) n FROM outflows WHERE state = 'landed'").get().n} payments`)
}
app.server.listen(5570, '127.0.0.1', () => console.log('dev api on :5570 (local validator, stub sign-in)'))
app.bot.start(20_000, 1500)
