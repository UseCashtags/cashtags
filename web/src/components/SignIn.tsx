import { useCallback, useEffect, useState } from 'react'
import { api, signInUrl } from '../lib/api'
import { useModal } from '../lib/useModal'
import { canSignMessages, toBase64, useWallet } from '../lib/wallet'
import { IClose, IX } from './Icons'

const EVENT = 'ct-signin'
/** Opens the sign-in popup from anywhere (the top bar, the launch page). `returnTo`: where X sign-in comes back to. */
export const openSignIn = (returnTo = location.pathname) => window.dispatchEvent(new CustomEvent(EVENT, { detail: returnTo }))

/** The sign-in popup: a Solana wallet (it signs a one-time message, no transaction), or X. Rendered once, by the shell. */
export function SignInHost() {
  const [returnTo, setReturnTo] = useState<string | null>(null)
  useEffect(() => {
    const on = (e: Event) => setReturnTo(String((e as CustomEvent).detail ?? location.pathname))
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return returnTo === null ? null : <SignInDialog returnTo={returnTo} onClose={() => setReturnTo(null)} />
}

function SignInDialog({ returnTo, onClose }: { returnTo: string; onClose: () => void }) {
  const w = useWallet()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const close = useCallback(() => onClose(), [onClose])
  const box = useModal<HTMLDivElement>(true, close)
  const wallets = w.wallets.filter(canSignMessages)
  const withWallet = async (x: (typeof wallets)[number]) => {
    setBusy(x.name); setErr(null)
    try {
      const address = await w.connect(x)
      const { nonce, message } = await api.walletChallenge(address)
      const signature = await w.signMessage(x, address, message)
      await api.walletSignIn(address, nonce, toBase64(signature))
      location.reload()
    } catch (e) {
      setErr(/reject|denied|cancel|declin/i.test((e as Error).message) ? 'You declined in your wallet.' : (e as Error).message)
      setBusy(null)
    }
  }
  return (
    <div className="overlay" onClick={close}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="Sign in" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head ct-signin-head"><h3 style={{ margin: 0 }}>Sign in</h3><button type="button" className="icon-btn" aria-label="Close" onClick={close}><IClose /></button></div>
        <div className="wallet-list">
          <a className="wallet-row" href={signInUrl(returnTo)}><span className="ct-signin-x"><IX size={15} /></span> <span>Continue with X</span></a>
          {wallets.map((x) => (
            <button type="button" key={x.name} className="wallet-row" disabled={!!busy} onClick={() => withWallet(x)}>
              <img src={x.icon} alt="" width={28} height={28} /> <span>{busy === x.name ? 'Approve in your wallet…' : x.name}</span>
            </button>
          ))}
        </div>
        {!wallets.length && <div className="muted small">No Solana wallet was found in this browser. Install Phantom, Solflare or Backpack to sign in with a wallet.</div>}
        {err && <div className="note error">{err}</div>}
      </div>
    </div>
  )
}
