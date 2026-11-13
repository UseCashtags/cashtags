/**
 * Solana wallets through the Wallet Standard: every installed wallet (Phantom, Solflare, Backpack…) registers itself and
 * the visitor picks one. Nothing is chosen for them. Used only for a dev buy on the launch page.
 *
 * ⚠ The wallet SIGNS and hands the transaction back (`solana:signTransaction`); it never sends it. The launch wallet pays
 * for the launch and signs last, on the server, so a transaction the wallet sent itself would be missing two signatures.
 */
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { useCallback, useEffect, useState } from 'react'

const CHAIN = 'solana:mainnet'
type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> }
type DisconnectFeature = { disconnect: () => Promise<void> }
type EventsFeature = { on: (event: 'change', cb: (p: { accounts?: readonly WalletAccount[] }) => void) => () => void }
type SignMessageFeature = { signMessage: (...inputs: { account: WalletAccount; message: Uint8Array }[]) => Promise<{ signature: Uint8Array }[]> }
type SignFeature = { signTransaction: (...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]) => Promise<{ signedTransaction: Uint8Array }[]> }

const usable = (w: Wallet) => w.chains.some((c) => c === CHAIN) && 'standard:connect' in w.features && ('solana:signTransaction' in w.features || 'solana:signMessage' in w.features)
/** Can this wallet sign a launch's dev buy / a sign-in message? */
export const canSignTransactions = (w: Wallet) => 'solana:signTransaction' in w.features
export const canSignMessages = (w: Wallet) => 'solana:signMessage' in w.features
const LAST = 'cashtags.wallet'
const remember = (name: string | null) => { try { if (name) localStorage.setItem(LAST, name); else localStorage.removeItem(LAST) } catch { /* private window */ } }

export type WalletState = {
  wallets: Wallet[]; wallet: Wallet | null; address: string | null
  /** Connects and returns the account's address. */
  connect: (w: Wallet) => Promise<string>; disconnect: () => Promise<void>
  /** Signs a text message (signing in) with wallet `w`'s connected account. Returns the signature. */
  signMessage: (w: Wallet, address: string, message: string) => Promise<Uint8Array>
  /** Signs a serialized transaction and returns it, signed by this wallet only. */
  sign: (tx: Uint8Array) => Promise<Uint8Array>
}

export function useWallet(): WalletState {
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [account, setAccount] = useState<WalletAccount | null>(null)

  useEffect(() => {
    const reg = getWallets()
    const refresh = () => setWallets(reg.get().filter(usable))
    refresh()
    const offs = [reg.on('register', refresh), reg.on('unregister', refresh)]
    return () => offs.forEach((off) => off())
  }, [])

  const connectTo = useCallback(async (w: Wallet, silent = false) => {
    const { accounts } = await (w.features['standard:connect'] as ConnectFeature).connect(silent ? { silent: true } : undefined)
    const acc = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0] ?? w.accounts[0]
    if (!acc) throw new Error('The wallet returned no account')
    setWallet(w); setAccount(acc); remember(w.name)
    return acc.address
  }, [])

  const signMessage = useCallback(async (w: Wallet, address: string, message: string) => {
    const f = w.features['solana:signMessage'] as SignMessageFeature | undefined
    const acc = w.accounts.find((a) => a.address === address)
    if (!f || !acc) throw new Error('This wallet cannot sign a message')
    const [out] = await f.signMessage({ account: acc, message: new TextEncoder().encode(message) })
    if (!out?.signature?.length) throw new Error('The wallet returned no signature')
    return out.signature
  }, [])

  // Reconnect quietly to the wallet used last time, if it allows that without a prompt.
  useEffect(() => {
    if (wallet) return
    let last: string | null = null
    try { last = localStorage.getItem(LAST) } catch { /* private window */ }
    const w = wallets.find((x) => x.name === last)
    if (w) connectTo(w, true).catch(() => {})
  }, [wallets, wallet, connectTo])

  // The wallet can switch accounts or disconnect on its own side: the page follows, or a launch would be built for the wrong buyer.
  useEffect(() => {
    const ev = wallet?.features['standard:events'] as EventsFeature | undefined
    if (!ev) return
    return ev.on('change', ({ accounts }) => {
      if (!accounts) return
      const acc = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0]
      if (acc) setAccount(acc)
      else { setWallet(null); setAccount(null); remember(null) }
    })
  }, [wallet])

  const disconnect = useCallback(async () => {
    await (wallet?.features['standard:disconnect'] as DisconnectFeature | undefined)?.disconnect().catch(() => {})
    setWallet(null); setAccount(null); remember(null)
  }, [wallet])

  const sign = useCallback(async (transaction: Uint8Array) => {
    if (!wallet || !account) throw new Error('Connect a wallet first')
    const [out] = await (wallet.features['solana:signTransaction'] as SignFeature).signTransaction({ account, transaction, chain: CHAIN })
    if (!out?.signedTransaction?.length) throw new Error('The wallet returned no signed transaction')
    return out.signedTransaction
  }, [wallet, account])

  return { wallets, wallet, address: account?.address ?? null, connect: (w) => connectTo(w), disconnect, sign, signMessage }
}

export const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
