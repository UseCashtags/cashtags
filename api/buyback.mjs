/**
 * $CASHTAG buyback + burn from its OWN creator rewards (operator 12 Nov 2026). Runs inside the keeper pass (keeper-run.mjs),
 * acts once per round; rounds are a RANDOM 5..30 minutes apart (BUYBACK_MIN_MINUTES / BUYBACK_MAX_MINUTES):
 *
 *   1. COLLECT  the coin's creator rewards into the creator wallet (PLATFORM_LAUNCH_KEY, cashcTx…): PumpSwap Pool.creator_fees
 *               swept into the creator vault, the vault's WSOL collected to the wallet and unwrapped, in ONE transaction.
 *   2. BUY      $CASHTAG on PumpSwap with what was collected (pot = all collected − all spent, from the ledger below), so
 *               the wallet's OTHER SOL is never spent. Minimum BUYBACK_MIN_SOL, at most BUYBACK_MAX_SOL per round.
 *   3. BURN     exactly the tokens that buy received (read from the buy's own transaction), never the wallet's balance.
 *
 * Ledger: table `buybacks`, one row per step. A buy whose burn did not land is burned on the next pass.
 * OFF unless BUYBACK_ENABLED=1. DRY (simulates every step on mainnet, sends nothing) unless BUYBACK_LIVE=1: the operator
 * switches it live; the assistant never sends a buy or a burn (operator rule, as for another token 9 Nov).
 * ⛔ A transaction counts as failed/expired only on a POSITIVE chain answer.
 * ⛔ PumpSwap buys need 3 remaining accounts (pool_v2, a Global buyback recipient + its WSOL account), from an earlier project's
 *    proven another token buyback.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from '@solana/spl-token'
import anchor from '@coral-xyz/anchor'
// ⛔ Node 22 (the box) cannot import BN as a NAMED export of this CommonJS package (keeper crashed 12 Nov 01:14): use the default export.
const { AnchorProvider, BN, BorshCoder, Program } = anchor
import bs58 from 'bs58'
import { PUMP_AMM, TOKEN_2022, WSOL, TOKEN_PROGRAM_ID, ata, poolAddress, POOL_INDEXES, decodePool, loadGlobal, pumpAmmIdl,
  ammCreatorVaultAuthority, poolCreatorFeesWaiting, sweepPoolCreatorFeeIx, collectCoinCreatorFeeIx } from '../lib/pump.mjs'

const DECIMALS = 6
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
const SOL = 1_000_000_000

export function buybackConfig(env = process.env) {
  return {
    enabled: env.BUYBACK_ENABLED === '1',
    live: env.BUYBACK_LIVE === '1',
    mint: new PublicKey(env.BUYBACK_MINT || 'BoRsyzgtFw56gHqWgqb7wL45bMr9vQMF564j1Gvtcash'),
    // operator 12 Nov: a RANDOM gap between rounds, BUYBACK_MIN_MINUTES..BUYBACK_MAX_MINUTES (default 5..30)
    minGapMs: Number(env.BUYBACK_MIN_MINUTES || 5) * 60_000,
    maxGapMs: Number(env.BUYBACK_MAX_MINUTES || 30) * 60_000,
    minLamports: BigInt(Math.round(Number(env.BUYBACK_MIN_SOL || 0.02) * SOL)),
    maxLamports: BigInt(Math.round(Number(env.BUYBACK_MAX_SOL || 2) * SOL)),
    minCollectLamports: BigInt(Math.round(Number(env.BUYBACK_MIN_COLLECT_SOL || 0.005) * SOL)),
    slippagePct: Number(env.BUYBACK_SLIPPAGE_PCT || 10),
    reserveLamports: 10_000_000n, // the wallet keeps 0.01 SOL for fees and token-account rent
  }
}

export function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS buybacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- collect | buy
    lamports TEXT NOT NULL DEFAULT '0', -- collect: SOL collected; buy: SOL spent
    tokens TEXT NOT NULL DEFAULT '0',   -- buy: raw $CASHTAG received (= burned)
    sig TEXT,                           -- collect or buy transaction
    burn_sig TEXT,                      -- buy: the burn
    status TEXT NOT NULL                -- collected | bought (burn pending) | burned
  );
  CREATE TABLE IF NOT EXISTS buyback_lock (id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL);
  INSERT OR IGNORE INTO buyback_lock (id, until) VALUES (1, 0);`)
  // when the next round is due (ms); 0 = now. Set to a random gap after every round.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('buyback_lock') WHERE name = 'next_at'").get()) db.exec('ALTER TABLE buyback_lock ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0')
}

/** SOL collected but not yet spent on buys: the only SOL a round may spend. */
export function pot(db) {
  const s = (kind) => BigInt(db.prepare("SELECT COALESCE(SUM(CAST(lamports AS INTEGER)), 0) AS t FROM buybacks WHERE kind = ?").get(kind).t)
  return s('collect') - s('buy')
}

/** Totals for the site and logs. */
export function totals(db) {
  ensureTables(db)
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(lamports AS INTEGER)), 0) AS sol, COALESCE(SUM(CAST(tokens AS INTEGER)), 0) AS tokens FROM buybacks WHERE kind = 'buy' AND status = 'burned'").get()
  return { rounds: r.n, solSpent: Number(r.sol) / SOL, tokensBurned: Number(r.tokens) / 10 ** DECIMALS, pot: Number(pot(db)) / SOL }
}

const now = () => Date.now()
const fmtT = (raw) => (Number(raw) / 10 ** DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 2 })
const budget = (units) => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units })]

/** Sends and waits for a POSITIVE answer: the signature when confirmed, null when provably expired, throws when it failed. */
async function sendAndConfirm(conn, ixs, signer, label, log) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  tx.sign([signer])
  const sig = bs58.encode(tx.signatures[0])
  log.info(`buyback: ${label}: sending ${sig}`)
  const raw = tx.serialize()
  for (let i = 0; i < 200; i++) {
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    let st = null, height = null
    try { st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0]; height = await conn.getBlockHeight('confirmed') } catch { continue }
    if (st?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(st.err)} (${sig})`)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig
    if (height != null && height > lastValidBlockHeight + 5 && !st) {
      const again = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => ({ value: [undefined] }))).value[0]
      if (again === null) return null
    }
  }
  throw new Error(`${label}: no answer for ${sig}; it will be looked at again next pass`)
}

/** Simulates `ixs` from the wallet; returns { err, accounts } (accounts = base64 data of `watch`). */
async function simulate(conn, ixs, signer, watch = []) {
  const { blockhash } = await conn.getLatestBlockhash()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  tx.sign([signer])
  const sim = await conn.simulateTransaction(tx, { sigVerify: true, accounts: { encoding: 'base64', addresses: watch.map((k) => k.toBase58()) } })
  return { err: sim.value.err, logs: sim.value.logs ?? [], accounts: sim.value.accounts ?? [] }
}

/** The coin's SOL PumpSwap pool, or null while it is still on its curve. */
async function findPool(conn, mint) {
  for (const i of POOL_INDEXES) {
    const addr = poolAddress(mint, WSOL, i)
    const info = await conn.getAccountInfo(addr)
    if (info && decodePool(info.data).base_mint.equals(mint)) return { addr, info }
  }
  return null
}

/** Raw tokens of `mint` the owner gained in a landed transaction (its own token balances; version-1 safe). */
async function receivedIn(conn, sig, owner, mint) {
  for (let i = 0; i < 20; i++) {
    const r = (await conn._rpcRequest('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null))?.result
    if (r) {
      if (r.meta?.err) throw new Error(`buy ${sig} failed on chain`)
      const sum = (list) => (list ?? []).filter((b) => b.owner === owner.toBase58() && b.mint === mint.toBase58()).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n)
      return sum(r.meta.postTokenBalances) - sum(r.meta.preTokenBalances)
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  return null
}

const burnIxs = (wallet, mint, amount) => [...budget(60_000), createBurnCheckedInstruction(ata(wallet.publicKey, mint, TOKEN_2022), mint, wallet.publicKey, amount, DECIMALS, [], TOKEN_2022)]

/** One pass. Returns a summary object (also logged). */
export async function buybackPass({ db, conn, wallet, cfg = buybackConfig(), log = console }) {
  if (!cfg.enabled) return { buyback: 'off' }
  if (!wallet) return { buyback: 'no wallet (PLATFORM_LAUNCH_KEY)' }
  ensureTables(db)
  // ⛔ A cross-process lock: a conditional UPDATE claims the round (an in-process flag is not a lock; an earlier incident).
  if (db.prepare('UPDATE buyback_lock SET until = ? WHERE id = 1 AND until < ?').run(now() + 15 * 60_000, now()).changes !== 1) return { buyback: 'another pass holds the lock' }
  const release = () => db.prepare('UPDATE buyback_lock SET until = 0 WHERE id = 1').run()
  const mode = cfg.live ? 'LIVE' : 'DRY'
  const out = { buyback: mode }
  try {
    const { mint } = cfg
    // 0. a buy whose received amount was not readable yet: read it now; then any buy whose burn has not landed: burn it first
    for (const b of db.prepare("SELECT * FROM buybacks WHERE kind = 'buy' AND status = 'unread'").all()) {
      const got = await receivedIn(conn, b.sig, wallet.publicKey, cfg.mint)
      if (got != null) db.prepare("UPDATE buybacks SET tokens = ?, status = 'bought' WHERE id = ?").run(String(got), b.id)
    }
    for (const b of db.prepare("SELECT * FROM buybacks WHERE kind = 'buy' AND status = 'bought'").all()) {
      if (!cfg.live) { out.pendingBurn = b.sig; continue }
      const amount = BigInt(b.tokens)
      const sig = await sendAndConfirm(conn, burnIxs(wallet, mint, amount), wallet, `burn ${fmtT(amount)} $CASHTAG (buy ${b.sig.slice(0, 8)}…)`, log)
      if (sig) { db.prepare("UPDATE buybacks SET burn_sig = ?, status = 'burned' WHERE id = ?").run(sig, b.id); out.burned = fmtT(amount) }
    }
    const nextAt = db.prepare('SELECT next_at FROM buyback_lock WHERE id = 1').get().next_at
    if (cfg.live && now() < nextAt) { out.next = new Date(nextAt).toISOString(); return out }
    // this round is happening: the next one is a random 5..30 minutes away, whatever this one finds
    if (cfg.live) {
      const gap = cfg.minGapMs + Math.floor(Math.random() * Math.max(0, cfg.maxGapMs - cfg.minGapMs))
      db.prepare('UPDATE buyback_lock SET next_at = ? WHERE id = 1').run(now() + gap)
      out.nextRound = new Date(now() + gap).toISOString()
    }

    const pool = await findPool(conn, mint)
    if (!pool) { out.skip = '$CASHTAG has no PumpSwap pool (still on its curve): buyback only runs after graduation'; return out }
    const p = decodePool(pool.info.data)
    if (!new PublicKey(p.coin_creator).equals(wallet.publicKey)) { out.skip = `the pool's coin creator is ${new PublicKey(p.coin_creator).toBase58()}, not this wallet`; return out }

    // 1. COLLECT (sweep the pool's kept fees into the vault, collect the vault's WSOL, unwrap), one transaction
    const authority = ammCreatorVaultAuthority(wallet.publicKey)
    const vaultWsol = ata(authority, WSOL, TOKEN_PROGRAM_ID)
    const userWsol = ata(wallet.publicKey, WSOL, TOKEN_PROGRAM_ID)
    const vaultAmt = await conn.getTokenAccountBalance(vaultWsol).then((b) => BigInt(b.value.amount)).catch(() => 0n)
    const waiting = vaultAmt + poolCreatorFeesWaiting(pool.info.data)
    out.waiting = Number(waiting) / SOL
    const userWsolInfo = await conn.getAccountInfo(userWsol)
    if (userWsolInfo && userWsolInfo.data.readBigUInt64LE(64) > 0n) { out.skip = `the wallet already holds wrapped SOL in ${userWsol.toBase58()}: unwrap it by hand first (it is not creator rewards)`; return out }
    if (waiting >= cfg.minCollectLamports) {
      const ixs = [...budget(200_000),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN_PROGRAM_ID),
        await sweepPoolCreatorFeeIx(conn, { pool: pool.addr, poolData: pool.info.data, payer: wallet.publicKey, creator: wallet.publicKey }),
        await collectCoinCreatorFeeIx(conn, { creator: wallet.publicKey, quoteMint: WSOL, quoteProgram: TOKEN_PROGRAM_ID }),
        createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)]
      if (!cfg.live) {
        const s = await simulate(conn, ixs, wallet, [vaultWsol])
        out.collect = s.err ? `WOULD FAIL ${JSON.stringify(s.err)} ${s.logs.slice(-3).join(' | ')}` : `would collect ${Number(waiting) / SOL} SOL`
      } else {
        // `waiting` was read before sending: anything that arrives in between stays with the wallet uncounted (conservative).
        const sig = await sendAndConfirm(conn, ixs, wallet, `collect ${Number(waiting) / SOL} SOL creator rewards`, log)
        if (sig) { db.prepare("INSERT INTO buybacks (at, kind, lamports, sig, status) VALUES (?, 'collect', ?, ?, 'collected')").run(now(), String(waiting), sig); out.collected = Number(waiting) / SOL }
      }
    } else out.collect = `only ${Number(waiting) / SOL} SOL waiting (min ${Number(cfg.minCollectLamports) / SOL})`

    // 2. BUY with the pot (collected − spent), 3. BURN exactly what arrived
    let amount = cfg.live ? pot(db) : pot(db) + (waiting >= cfg.minCollectLamports ? waiting : 0n)
    if (amount > cfg.maxLamports) amount = cfg.maxLamports
    out.pot = Number(amount) / SOL
    if (amount < cfg.minLamports) { out.buy = `pot ${Number(amount) / SOL} SOL under the ${Number(cfg.minLamports) / SOL} SOL minimum: carried`; return out }
    const bal = BigInt(await conn.getBalance(wallet.publicKey))
    if (cfg.live && bal < amount + cfg.reserveLamports) { out.buy = `wallet holds ${Number(bal) / SOL} SOL, needs ${Number(amount + cfg.reserveLamports) / SOL}`; return out }
    // DRY: nothing was collected for real, so the buy is simulated with what the wallet holds now (it proves the route)
    if (!cfg.live && amount > bal - cfg.reserveLamports) { amount = bal - cfg.reserveLamports; out.simulatedWith = Number(amount) / SOL }

    const amm = new Program(pumpAmmIdl, new AnchorProvider(conn, { publicKey: wallet.publicKey, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {}))
    const gc = new BorshCoder(pumpAmmIdl).accounts.decode('GlobalConfig', (await conn.getAccountInfo(GLOBAL_CONFIG)).data)
    const protocolFeeRecipient = gc.protocol_fee_recipients.find((k) => !k.equals(PublicKey.default))
    const buybackRecipient = (await loadGlobal(conn)).buyback_fee_recipients.find((k) => !k.equals(PublicKey.default))
    const userAta = ata(wallet.publicKey, mint, TOKEN_2022)
    const buildBuy = async (minOut) => [...budget(300_000),
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userAta, wallet.publicKey, mint, TOKEN_2022),
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userWsol, lamports: amount }),
      createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
      await amm.methods.buyExactQuoteIn(new BN(amount.toString()), new BN(minOut.toString()), { 0: true })
        .accountsPartial({ pool: pool.addr, user: wallet.publicKey, globalConfig: GLOBAL_CONFIG, baseMint: mint, quoteMint: WSOL,
          userBaseTokenAccount: userAta, userQuoteTokenAccount: userWsol, poolBaseTokenAccount: p.pool_base_token_account, poolQuoteTokenAccount: p.pool_quote_token_account,
          protocolFeeRecipient, baseTokenProgram: TOKEN_2022, quoteTokenProgram: TOKEN_PROGRAM_ID })
        .remainingAccounts([
          { pubkey: PublicKey.findProgramAddressSync([Buffer.from('pool-v2'), mint.toBuffer()], PUMP_AMM)[0], isSigner: false, isWritable: false },
          { pubkey: buybackRecipient, isSigner: false, isWritable: false },
          { pubkey: ata(buybackRecipient, WSOL, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
        ])
        .instruction(),
      createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)]
    // the exact amount from a simulation (no guessing at reserves), then the floor from the slippage
    const before = await conn.getTokenAccountBalance(userAta).then((b) => BigInt(b.value.amount)).catch(() => 0n)
    const s = await simulate(conn, await buildBuy(1n), wallet, [userAta])
    if (s.err) { out.buy = `WOULD FAIL ${JSON.stringify(s.err)} ${s.logs.slice(-3).join(' | ')}`; return out }
    const quoted = (s.accounts[0] ? Buffer.from(s.accounts[0].data[0], 'base64').readBigUInt64LE(64) : 0n) - before
    if (quoted <= 0n) { out.buy = 'the simulated buy received nothing'; return out }
    const minOut = quoted * BigInt(Math.round((100 - cfg.slippagePct) * 100)) / 10000n
    if (!cfg.live) {
      out.buy = `would buy ${fmtT(quoted)} $CASHTAG for ${Number(amount) / SOL} SOL (min ${fmtT(minOut)} at ${cfg.slippagePct}% slippage), then burn exactly that`
      return out
    }
    const buySig = await sendAndConfirm(conn, await buildBuy(minOut), wallet, `buy $CASHTAG with ${Number(amount) / SOL} SOL`, log)
    if (!buySig) { out.buy = 'expired without landing: nothing bought, the pot carries'; return out }
    const received = await receivedIn(conn, buySig, wallet.publicKey, mint)
    // the SOL is spent from here on, whatever happens to the burn: book the buy first
    const row = db.prepare("INSERT INTO buybacks (at, kind, lamports, tokens, sig, status) VALUES (?, 'buy', ?, ?, ?, 'bought')").run(now(), String(amount), String(received ?? 0n), buySig)
    if (received == null) { out.buy = `bought (${buySig}) but its token amount is not readable yet: burned next pass`; db.prepare("UPDATE buybacks SET status = 'unread' WHERE id = ?").run(row.lastInsertRowid); return out }
    out.bought = fmtT(received)
    const burnSig = await sendAndConfirm(conn, burnIxs(wallet, mint, received), wallet, `burn ${fmtT(received)} $CASHTAG`, log)
    if (burnSig) { db.prepare("UPDATE buybacks SET burn_sig = ?, status = 'burned' WHERE id = ?").run(burnSig, row.lastInsertRowid); out.burned = fmtT(received); out.burnSig = burnSig }
    out.buySig = buySig
    return out
  } finally { release() }
}
