// LOCAL ONLY (validator :8891): launches a pump.fun coin with the native holder-reward option, buys, and shows where the creator fee went.
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { TOKEN_2022, ata, bondingCurveAddress, buyExactSolInIx, createV2Ix, creatorVaultAddress, decodeBondingCurve, holderRewardsAddress, loadGlobal, pumpProgram } from '../lib/pump.mjs'
import { buildTx, sendUntilFate } from '../lib/tx.mjs'
const conn = new Connection('http://127.0.0.1:8891', 'confirmed'), pump = pumpProgram(conn)
const fund = async (pk) => { const s = await conn.requestAirdrop(pk, 20 * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
const launcher = Keypair.generate(), trader = Keypair.generate(), mint = Keypair.generate(), creator = Keypair.generate().publicKey
await fund(launcher.publicKey); await fund(trader.publicKey)
const create = await createV2Ix(pump, { mint: mint.publicKey, user: launcher.publicKey, name: 'Holders Test', symbol: 'HOLD', uri: 'https://gateway.pinata.cloud/ipfs/bafkrei' + 'a'.repeat(52), creator, holderReward: true })
let b = await buildTx(conn, { payer: launcher.publicKey, ixs: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), create], signers: [launcher, mint] })
console.log('launch bytes', b.raw.length, JSON.stringify(await sendUntilFate(conn, b)))
const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(mint.publicKey))).data)
console.log('is_holder_reward', JSON.stringify(curve.is_holder_reward), '| curve.creator is ours:', curve.creator.equals(creator), '| is holder-rewards PDA:', curve.creator.equals(holderRewardsAddress(mint.publicKey)))
const realCreator = curve.creator
const hr = holderRewardsAddress(mint.publicKey), cv = creatorVaultAddress(realCreator)
const before = await conn.getMultipleAccountsInfo([hr, cv])
const g = await loadGlobal(conn)
const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, ata(trader.publicKey, mint.publicKey, TOKEN_2022), trader.publicKey, mint.publicKey, TOKEN_2022),
  await buyExactSolInIx(pump, g, { mint: mint.publicKey, user: trader.publicKey, creator: realCreator, lamports: 2_000_000_000n })]
b = await buildTx(conn, { payer: trader.publicKey, ixs, signers: [trader] })
const f = await sendUntilFate(conn, b)
console.log('buy', JSON.stringify(f).slice(0, 300))
if (f.fate !== 'landed') { const t = await conn.simulateTransaction(b.tx); console.log((t.value.logs ?? []).slice(-8).join('\n')) }
const after = await conn.getMultipleAccountsInfo([hr, cv])
const raw = (await conn.getAccountInfo(bondingCurveAddress(mint.publicKey))).data
console.log('holder-rewards PDA', before[0]?.lamports ?? 0, '->', after[0]?.lamports ?? 0, '| creator vault', before[1]?.lamports ?? 0, '->', after[1]?.lamports ?? 0, '| curve creator_fee waiting', raw.length >= 133 ? raw.readBigUInt64LE(125).toString() : 'n/a')
