/**
 * READ-ONLY check on mainnet: builds the site launch transactions exactly as api/sitelaunch.mjs does (worst-case name,
 * cashtag and metadata link) and SIMULATES them. ⛔ Nothing is signed and nothing is sent: there is no send in this file.
 * The paying wallet is only named (simulation does not check signatures); the mint is a throwaway key that is never used.
 *
 *   on the box:  set -a; . /root/cashtags-ops/api.env; set +a; DATA_DIR=/var/lib/cashtags node scripts/verify-site-launch.mjs <funded wallet address>
 */
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { join } from 'node:path'
import { openDb, kvGet } from '../api/db.mjs'
import { buildLaunchIxs } from '../api/launch.mjs'
import { resolvePair } from '../api/pairs.mjs'
import { pumpProgram } from '../lib/pump.mjs'

const env = process.env
const conn = new Connection(env.RPC_URL, 'confirmed')
const db = openDb(env.DB_PATH ?? join(env.DATA_DIR ?? './data', 'cashtags.db'))
const payer = new PublicKey(process.argv[2])
const pump = pumpProgram(conn)
const lutAddr = env.LAUNCH_LUT || kvGet(db, 'launch_lut')
const lut = lutAddr ? (await conn.getAddressLookupTable(new PublicKey(lutAddr))).value : null
console.log(`paying wallet ${payer.toBase58()} holds ${(await conn.getBalance(payer)) / 1e9} SOL; lookup table ${lutAddr ?? 'none'} (${lut?.state.addresses.length ?? 0} addresses)`)
const URI = `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`
const bonk = await resolvePair(db, conn, '$BONK').catch((e) => ({ ok: false, reason: e.message }))

async function check(label, { holderReward = false, devBuy = 0, quote = null, useLut = true }) {
  const mint = Keypair.generate().publicKey, fw = Keypair.generate().publicKey
  try {
    const ixs = await buildLaunchIxs({ conn, pump, launcher: payer, mint, feeWalletPk: fw, name: 'W'.repeat(32), symbol: 'ABCDEFGHIJ', uri: URI, holderReward, quote,
      devBuy: devBuy ? { user: payer, lamports: Math.round(devBuy * 1e9) } : null })
    const { blockhash } = await conn.getLatestBlockhash('confirmed')
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(useLut && lut ? [lut] : []))
    let size
    try { size = tx.serialize().length } catch { size = 'over 1232' }
    const sim = typeof size === 'number' && size <= 1232 ? await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }) : null
    const err = sim ? sim.value.err : 'too large'
    console.log(`${err ? 'FAIL' : 'ok  '} ${label}: ${size} bytes, ${sim?.value.unitsConsumed ?? '-'} CU${err ? ` ${JSON.stringify(err)} ${(sim?.value.logs ?? []).slice(-3).join(' | ')}` : ''}`)
  } catch (e) { console.log(`FAIL ${label}: ${e.message}`) }
  await new Promise((r) => setTimeout(r, 1500))
}
await check('X Money / creator, no dev buy, no table', { useLut: false })
await check('Holders, no dev buy, no table', { holderReward: true, useLut: false })
await check('X Money / creator + 0.5 SOL dev buy', { devBuy: 0.5 })
await check('Holders + 0.5 SOL dev buy', { holderReward: true, devBuy: 0.5 })
if (bonk.ok && bonk.quote.kind !== 'sol') {
  await check('paired with $BONK, creator', { quote: bonk.quote })
  await check('paired with $BONK, holders', { quote: bonk.quote, holderReward: true })
} else console.log(`pair check skipped: ${bonk.reason ?? 'BONK resolved to SOL'}`)
