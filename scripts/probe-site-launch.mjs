// Local probe (validator.sh, port 8891): which create_v2 option combinations pump.fun accepts, and whether a launch with a
// dev buy signed by a SECOND wallet (the launch wallet pays the creation) fits one transaction, with and without a lookup table.
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { TOKEN_2022, ata, bondingCurveAddress, buyExactSolInIx, createV2Ix, decodeBondingCurve, holderRewardsAddress, loadGlobal, pumpProgram, tokenAccountAmount } from '../lib/pump.mjs'
import { createLaunchTable, staticLaunchAccounts } from '../lib/lut.mjs'

const conn = new Connection(`http://127.0.0.1:${process.env.LOCAL_RPC_PORT ?? 8891}`, 'confirmed')
const pump = pumpProgram(conn)
const launcher = Keypair.generate(), user = Keypair.generate()
const fund = async (to, sol) => { const s = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }) }
await fund(launcher.publicKey, 50); await fund(user.publicKey, 50)
const global = await loadGlobal(conn)
const lutAddr = await createLaunchTable(conn, launcher, await staticLaunchAccounts(pump, global))
const lut = (await conn.getAddressLookupTable(lutAddr)).value
console.log('lookup table', lutAddr.toBase58(), lut.state.addresses.length, 'addresses')

const URI = `https://gateway.pinata.cloud/ipfs/bafkreib${'a'.repeat(52)}`
async function attempt(label, { mayhem = false, cashback = false, holderReward = false, creatorFeeBps = null, devBuy = 0 }) {
  const mint = Keypair.generate(), fw = Keypair.generate().publicKey
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })]
  if (!holderReward) ixs.push(SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: fw, lamports: 890_880 }))
  ixs.push(await createV2Ix(pump, { mint: mint.publicKey, user: launcher.publicKey, name: 'W'.repeat(32), symbol: 'ABCDEFGHIJ', uri: URI, creator: fw, holderReward, mayhem, cashback, creatorFeeBps }))
  const signers = [launcher, mint]
  if (devBuy) {
    const creator = holderReward ? holderRewardsAddress(mint.publicKey) : fw
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(user.publicKey, ata(user.publicKey, mint.publicKey, TOKEN_2022), user.publicKey, mint.publicKey, TOKEN_2022))
    ixs.push(await buyExactSolInIx(pump, global, { mint: mint.publicKey, user: user.publicKey, creator, lamports: BigInt(Math.round(devBuy * 1e9)), mayhem }))
    signers.push(user)
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  const size = (tables) => { try { const t = new VersionedTransaction(new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables)); t.sign(signers); return t.serialize().length } catch (e) { return `too large (${e.message.slice(0, 60)})` } }
  const plain = size([]), withLut = size([lut])
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([lut]))
  tx.sign(signers)
  const before = await conn.getBalance(user.publicKey), lb = await conn.getBalance(launcher.publicKey)
  let result
  try {
    const sig = await conn.sendRawTransaction(tx.serialize())
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    const c = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(mint.publicKey))).data)
    const held = devBuy ? tokenAccountAmount((await conn.getAccountInfo(ata(user.publicKey, mint.publicKey, TOKEN_2022))).data) : 0n
    const meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 })
    result = `OK mayhem=${c.is_mayhem_mode} cashback=${c.is_cashback_coin} holder=${c.is_holder_reward} feeBps=${c.creator_fee_bps} supply=${c.token_total_supply} | launcher paid ${(lb - await conn.getBalance(launcher.publicKey)) / 1e9} SOL, user paid ${(before - await conn.getBalance(user.publicKey)) / 1e9} SOL, user holds ${Number(held) / 1e6} | CU ${meta?.meta?.computeUnitsConsumed}`
  } catch (e) {
    result = `REFUSED ${String(e.message).slice(0, 160)} ${(e.logs ?? e.transactionLogs ?? []).filter((l) => /Error|error/.test(l)).join(' | ').slice(0, 300)}`
  }
  console.log(`\n${label}\n  size plain ${plain}, with table ${withLut}\n  ${result}`)
}

await attempt('plain', {})
await attempt('mayhem', { mayhem: true })
await attempt('mayhem + holder rewards', { mayhem: true, holderReward: true })
await attempt('cashback', { cashback: true })
await attempt('creator fee 100 bps on SOL', { creatorFeeBps: 100 })
await attempt('dev buy 1 SOL, fees to creator', { devBuy: 1 })
await attempt('dev buy 1 SOL, holder rewards', { devBuy: 1, holderReward: true })
await attempt('dev buy 1 SOL, mayhem', { devBuy: 1, mayhem: true })
await attempt('dev buy 1 SOL, mayhem + holder rewards', { devBuy: 1, mayhem: true, holderReward: true })
await attempt('dev buy 60 SOL', { devBuy: 40 })
