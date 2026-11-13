// LOCAL ONLY: proves pair launches on a validator with pump.fun cloned (./validator.sh). Refuses any other RPC.
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import {
  TOKEN_2022, TOKEN_PROGRAM_ID, USDC, ata, bondingCurveAddress, buyExactQuoteInV2Ix, collectCreatorFeeV2Ix, createV2Ix, creatorVaultAddress,
  curveCreatorFeeWaiting, decodeBondingCurve, holderRewardsAddress, loadGlobal, pumpProgram, resolveQuote, sweepCurveCreatorFeeQIx, tokenAccountAmount,
} from '../lib/pump.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
const RPC = process.env.RPC ?? 'http://127.0.0.1:8891'
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('local only')
const conn = new Connection(RPC, 'confirmed'), pump = pumpProgram(conn)
const key = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(`../tests/fixtures/${f}`, import.meta.url)))))
const BONK = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), bonkAuth = key('bonk-authority.json')
const payer = Keypair.generate(), trader = Keypair.generate()
for (const k of [payer, trader, bonkAuth]) { const s = await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
const send = async (ixs, signers, label) => {
  const b = await buildTx(conn, { payer: signers[0].publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs], signers })
  const f = await sendUntilFate(conn, { raw: b.raw, signature: b.signature, lastValidBlockHeight: b.lastValidBlockHeight })
  console.log(`${label}: ${f.fate} ${b.raw.length} B${f.fate !== 'landed' ? ' ' + JSON.stringify(f.err ?? f.error) + ' ' + (f.logs ?? []).slice(-4).join(' | ') : ''}`)
  return f.fate === 'landed'
}
const global = await loadGlobal(conn)
async function launch(label, qAddr, { holderReward = false } = {}) {
  const q = await resolveQuote(conn, qAddr)
  if (!q.ok) { console.log(label, 'resolve refused:', q.reason); return null }
  const mint = Keypair.generate(), creator = Keypair.generate().publicKey
  const ix = await createV2Ix(pump, { mint: mint.publicKey, user: payer.publicKey, name: 'A'.repeat(32), symbol: 'ABCDEFGHIJ', uri: 'https://gateway.pinata.cloud/ipfs/' + 'b'.repeat(59), creator, holderReward, quote: q })
  const ok = await send([ix], [payer, mint], `${label} [${q.kind}${holderReward ? ', holder rewards' : ''}]`)
  if (!ok) return null
  const c = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(mint.publicKey))).data)
  console.log(`   curve quote=${c.quote_mint.toBase58().slice(0, 6)} creator=${c.creator.equals(creator) ? 'ours' : c.creator.equals(holderRewardsAddress(mint.publicKey)) ? 'holder-rewards PDA' : c.creator.toBase58()} holder=${JSON.stringify(c.is_holder_reward)}`)
  return { mint: mint.publicKey, creator: c.creator, q }
}
const bonkCoin = await launch('BONK pair, creator', BONK.toBase58())
const bonkHolders = await launch('BONK pair, holders', BONK.toBase58(), { holderReward: true })
await launch('USDC pair', USDC.toBase58())
await launch('curve pump coin pair', '3BXio3YTY7MBaCjLHLR3rL491817x142bnBqQxN3pump')
await launch('pool pump coin pair', 'Goh59QCfoX53RgJa615vzXx4swR3mv51VgvAN6ZCpump')
await launch('a random mint (refused)', Keypair.generate().publicKey.toBase58())
// trades in BONK → creator fee in BONK → sweep + collect_creator_fee_v2 into the creator's BONK account
const tAta = ata(trader.publicKey, BONK, TOKEN_PROGRAM_ID)
await send([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, tAta, trader.publicKey, BONK, TOKEN_PROGRAM_ID),
  createMintToInstruction(BONK, tAta, bonkAuth.publicKey, 10_000_000_000_00000n)], [trader, bonkAuth], 'mint BONK to trader')
for (const coin of [bonkCoin, bonkHolders].filter(Boolean)) {
  const buy = await buyExactQuoteInV2Ix(pump, global, { mint: coin.mint, user: trader.publicKey, creator: coin.creator, quoteMint: BONK, quoteProgram: TOKEN_PROGRAM_ID, amountIn: 1_000_000_000_00000n })
  await send([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, coin.mint, TOKEN_2022), trader.publicKey, coin.mint, TOKEN_2022), buy], [trader], `buy 1B BONK of ${coin === bonkCoin ? 'creator' : 'holders'} coin`)
  const waiting = curveCreatorFeeWaiting((await conn.getAccountInfo(bondingCurveAddress(coin.mint))).data)
  const vaultQ = await conn.getAccountInfo(ata(creatorVaultAddress(coin.creator), BONK, TOKEN_PROGRAM_ID))
  console.log(`   fee unswept on curve ${waiting}, in vault ${vaultQ ? tokenAccountAmount(vaultQ.data) : 0}`)
}
if (bonkCoin) {
  const fw = bonkCoin.creator, fwAta = ata(fw, BONK, TOKEN_PROGRAM_ID)
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, fwAta, fw, BONK, TOKEN_PROGRAM_ID),
    await sweepCurveCreatorFeeQIx(conn, { mint: bonkCoin.mint, payer: payer.publicKey, creator: fw, quoteMint: BONK, quoteProgram: TOKEN_PROGRAM_ID }),
    await collectCreatorFeeV2Ix(pump, { creator: fw, quoteMint: BONK, quoteProgram: TOKEN_PROGRAM_ID })], [payer], 'sweep + collect BONK fees')
  console.log(`   fee wallet BONK: ${tokenAccountAmount((await conn.getAccountInfo(fwAta)).data)}`)
}
