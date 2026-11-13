// DEV ONLY: fills data/dev.db with coins launched on the LOCAL validator (./validator.sh) through the real bot path,
// plus trades so fees, payouts and an airdrop show on the site. Refuses any RPC that is not localhost.
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { openDb, now } from '../api/db.mjs'
import { createApp } from '../api/server.mjs'
import { FixtureX } from '../api/x.mjs'
import { feeWallet } from '../api/feewallet.mjs'
import { keeperPass, keeperConfig } from '../api/keeper.mjs'
import { TOKEN_2022, ata, buyExactSolInIx, loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8891'
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC)) throw new Error('dev-seed runs against a local validator only')
const conn = new Connection(RPC, 'confirmed')
const SEED = 'cd'.repeat(32)
mkdirSync('data/dev-keys', { recursive: true })
rmSync('data/dev.db', { force: true }); rmSync('data/dev.db-wal', { force: true }); rmSync('data/dev.db-shm', { force: true })
const db = openDb('data/dev.db')
const launcher = Keypair.generate(), keeper = Keypair.generate()
writeFileSync('data/dev-keys/keeper.json', JSON.stringify([...keeper.secretKey]))
writeFileSync('data/dev-keys/launcher.json', JSON.stringify([...launcher.secretKey]))
const fund = async (pk, sol) => { const s = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
await fund(launcher.publicKey, 10); await fund(keeper.publicKey, 10)
for (let i = 0; i < 6; i++) { const k = Keypair.generate(); db.prepare('INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)').run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString('base64'), now()) }
const x = new FixtureX('UseCashtags')
const app = createApp({ env: { PUBLIC_URL: 'http://localhost:5575', DEV_STUBS: '1', FEE_SEED: SEED, START_OPEN: '1', LAUNCH_RAMP: '0', MIN_SPACING_SECONDS: '0', REPLY_SPACING_SECONDS: '0', DATA_DIR: 'data' },
  db, conn, x, keeper, launcher, pin: async () => ({ uri: 'https://gateway.pinata.cloud/ipfs/bafkreidev', imageUri: '' }) })
const id = (h) => BigInt('0x' + createHash('sha256').update(`x:${h}`).digest('hex').slice(0, 12)).toString()
const asks = [['alice', '$DOGE Doge Coin'], ['bob', '"Space Cats" $SCAT'], ['carol', '$FROG Frog Club'], ['alice', '$CASH']]
let n = 0
for (const [h, text] of asks) {
  x.mentions.push({ id: String(7000 + n++), text: `@UseCashtags ${text}`, createdAt: now(), authorHandle: h, authorId: id(h), authorName: h[0].toUpperCase() + h.slice(1),
    authorFollowers: 800, authorCreatedAt: now() - 800 * 86400, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: `https://x.com/${h}/status/${7000 + n}` })
}
await app.bot.poll()
db.prepare("UPDATE mentions SET author_id = ? WHERE author_handle = 'alice' AND tweet_id = '7003'").run(id('alice'))
for (let i = 0; i < asks.length; i++) {
  db.prepare("UPDATE mentions SET launched_at = launched_at - 7200 WHERE state = 'launched'").run() // step past the per-account cooldown
  console.log(JSON.stringify((await app.bot.tick({ doPoll: false })).queue))
}
const pump = pumpProgram(conn), global = await loadGlobal(conn)
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
for (const t of traders) await fund(t.publicKey, 30)
for (const coin of db.prepare('SELECT * FROM tokens').all()) {
  const { PublicKey } = await import('@solana/web3.js')
  const mint = new PublicKey(coin.mint), creator = feeWallet(Buffer.from(SEED, 'hex'), coin.mint).publicKey
  for (const [i, t] of traders.entries()) {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), createAssociatedTokenAccountIdempotentInstruction(t.publicKey, ata(t.publicKey, mint, TOKEN_2022), t.publicKey, mint, TOKEN_2022),
      await buyExactSolInIx(pump, global, { mint, user: t.publicKey, creator, lamports: BigInt((1 + i) * 1e9) })]
    const b = await buildTx(conn, { payer: t.publicKey, ixs, signers: [t] })
    await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  }
}
console.log(JSON.stringify(await keeperPass({ db, conn, pump, keeper, seed: Buffer.from(SEED, 'hex'), cfg: keeperConfig({ MIN_COLLECT_LAMPORTS: '1', HOLDERS_MIN_LAMPORTS: '1000000', HOLDER_MIN_TOKENS: '1000' }) })))
console.log(`seeded ${db.prepare('SELECT count(*) n FROM tokens').get().n} coins; FEE_SEED=${SEED}`)
process.exit(0)
