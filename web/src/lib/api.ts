import type { FeedItem, Me, Mode, Outflow, Stats, Token, User } from './types'

export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg) } }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(body.error ?? `Request failed (${r.status})`, r.status)
  return body as T
}
const post = <T,>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  stats: () => call<Stats>('/api/stats'),
  /** `graduated`: true = off the curve, false = still on it, undefined = every coin */
  tokens: (sort = 'new', q = '', limit = 48, offset = 0, graduated?: boolean) => call<{ tokens: Token[]; total: number }>(`/api/tokens?sort=${sort}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${graduated === undefined ? '' : `&graduated=${graduated ? 1 : 0}`}`),
  payments: (kind: PaymentKind = 'all', limit = 30, offset = 0) => call<Payments>(`/api/payments?kind=${kind}&limit=${limit}&offset=${offset}`),
  topPaid: () => call<{ items: TopPaid[] }>('/api/payments/top'),
  token: (mint: string) => call<{ token: Token; activity: Outflow[]; buybacks: Buybacks | null; xmoney: XMoneyCoinPayout[]; xmoneyWallet: string | null }>(`/api/token/${mint}`),
  creator: (handle: string) => call<{ creator: User; tokens: Token[]; earnedSol: number; paidSol: number }>(`/api/creator/${encodeURIComponent(handle)}`),
  feed: () => call<{ feed: FeedItem[] }>('/api/feed'),
  me: () => call<Me>('/api/me'),
  settings: (s: Record<string, unknown>) => post<{ ok: true; payoutConfirmed: boolean; payoutWallet: string }>('/api/settings', s),
  setMode: (mint: string, mode: Mode) => post<{ ok: true; mode: Mode }>(`/api/token/${mint}/mode`, { mode }),
  withdraw: (destination: string, asset = 'SOL') => post<{ ok: true; asset: string; paid: number; paidSol: number; pending: boolean; signatures: string[] }>('/api/withdraw', { destination, asset }),
  logout: () => post<{ ok: true }>('/api/auth/logout', {}),
  // sign in with a Solana wallet: it signs a one-time message
  walletChallenge: (address: string) => call<{ nonce: string; message: string }>(`/api/auth/wallet/challenge?address=${encodeURIComponent(address)}`),
  walletSignIn: (address: string, nonce: string, signature: string) => post<{ ok: true }>('/api/auth/wallet', { address, nonce, signature }),
  // launching on the site
  launchOptions: () => call<LaunchOptions>('/api/launch/options'),
  launchCheck: (symbol: string, pair = '') => call<LaunchCheck>(`/api/launch/check?symbol=${encodeURIComponent(symbol)}&pair=${encodeURIComponent(pair)}`),
  launch: (body: LaunchBody) => post<LaunchResult>('/api/launch', body),
  launchSign: (id: string, transaction: string) => post<LaunchResult>('/api/launch/sign', { id, transaction }),
  /** the X account behind a handle, so the form can show who the X Money goes to */
  xUser: (handle: string) => call<XUser>(`/api/launch/x-user?handle=${encodeURIComponent(handle)}`),
  launchStatus: (id: string) => call<LaunchStatus>(`/api/launch/${id}`),
}
export const signInUrl = (ret = location.pathname) => `/api/auth/x/start?return=${encodeURIComponent(ret)}`

/** $CASHTAG buyback + burn rounds (bought with its own creator rewards, every bought token burned). */
export type BuybackRound = { at: number; sol: number; tokens: number; buyTx: string; burnTx: string | null; burned: boolean }
export type Buybacks = { count: number; solSpent: number; tokensBurned: number; rounds: BuybackRound[] }
/** One X Money payout that took this coin's creator rewards (status + every step's transaction). */
export type XMoneyCoinPayout = { id: number; time: number; handle: string; sol: number; totalSol: number; usd: number; paidUsd: number; status: string; done: boolean;
  collectTxs: string[]; bridgeTx: string | null; peerOrder: string | null; creditTx: string | null }

/** What the launch form needs to draw itself (api/sitelaunch.mjs options). */
export type LaunchOptions = {
  open: boolean; defaultMode: Mode; nameMax: number; symbolMax: number; descMax: number; imageMax: number
  launchCostSol: number
  devBuy: { enabled: boolean; minSol: number; maxSol: number; feeBps: number; extraSol: number }
  curve: { virtualSol: number; virtualTokens: number; supply: number }
  pairs: { mint: string; symbol: string; name: string }[]
  limits: { cooldownMinutes: number; minFollowers: number; minAccountAgeDays: number; tickerHoldHours: number }
  xmoney: { enabled: boolean; minSol: number }
}
export type XUser = { found: false; handle: string } | { found: true; id: string; handle: string; name: string; avatar: string; followers: number | null; self: boolean }
export type PairCheck = { ok: true; sol: boolean; symbol: string; mint?: string; name?: string; kind?: string } | { ok: false; reason: string }
export type LaunchCheck = { ticker: { symbol: string; free: boolean; reason: string | null } | null; pair: PairCheck | null }
export type LaunchBody = {
  symbol: string; name: string; description: string; website: string; twitter: string; telegram: string
  mode: Mode; pair: string; image: string | null
  /** the wallet that pays for the launch (and the dev buy) */
  wallet: string; devBuy: { sol: string } | null
  /** launch FOR this X account: the token and its rewards are theirs, paid to their X Money */
  forHandle?: string
}
export type LaunchResult = { id: string; state: 'queued' | 'signing' | 'launching'; mint?: string; transaction?: string; signature?: string; expiresAt?: number }
export type LaunchStatus = { id: string; state: 'queued' | 'launching' | 'launched' | 'rejected' | 'failed' | 'signing' | 'expired'; symbol?: string; mint: string | null; signature: string | null; reason: string | null }

/** The payments page: every creator payout, holder airdrop and X Money send. */
export type PaymentKind = 'all' | 'creators' | 'holders' | 'xmoney'
export type Payment = Outflow & { token: { mint: string; symbol: string; name: string; image: string }; handle: string; xmoney: boolean }
export type Payments = {
  items: Payment[]; total: number
  totals: { creatorsSol: number; holdersSol: number; xmoneySol: number; pumpHoldersSol: number; allSol: number; allUsd: number; accountsPaid: number; walletsPaid: number }
}
export type TopPaid = { creator: User; paidSol: number; paidUsd: number; payments: number; owedSol: number }
