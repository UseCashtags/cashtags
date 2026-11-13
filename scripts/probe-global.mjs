// Prints the pump.fun Global switches a launch form depends on (read-only).
import { Connection } from '@solana/web3.js'
import { loadGlobal } from '../lib/pump.mjs'
const conn = new Connection(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com')
const g = await loadGlobal(conn)
const s = (v) => v?.toBase58 ? v.toBase58() : v?.toString?.() ?? v
for (const k of ['create_v2_enabled','mayhem_mode_enabled','is_cashback_enabled','creator_fee_configurable','max_configurable_creator_fee_bps','is_holder_reward_enabled','fee_basis_points','creator_fee_basis_points','initial_virtual_token_reserves','initial_virtual_sol_reserves','initial_real_token_reserves','token_total_supply','reserved_fee_recipient','fee_recipient','buyback_basis_points','initial_virtual_quote_reserves']) console.log(k, s(g[k]))
console.log('reserved', g.reserved_fee_recipients.map(s).join(' '))
