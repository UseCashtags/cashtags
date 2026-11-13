// READ-ONLY: a graduated coin's market cap as we compute it (pool balances + virtual quote reserves) next to DexScreener's.
//   on the box:  set -a; . /root/cashtags-ops/api.env; set +a; node scripts/check-market-cap.mjs <mint> [<mint>…]
import { Connection } from '@solana/web3.js'
import { poolMarketCap, solUsd } from '../api/market.mjs'
const conn = new Connection(process.env.RPC_URL, 'confirmed')
const price = await solUsd()
for (const mint of process.argv.slice(2)) {
  const ours = await poolMarketCap(conn, mint, price).catch((e) => ({ error: e.message }))
  const pairs = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`)).json().catch(() => [])
  const main = (pairs ?? []).filter((x) => x?.baseToken?.address === mint).sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0]
  console.log(`${mint}  ours $${ours?.marketCapUsd?.toFixed(0) ?? JSON.stringify(ours)}  DexScreener $${main ? Number(main.marketCap ?? main.fdv).toFixed(0) : 'n/a'}  (SOL $${price.toFixed(2)})`)
}
