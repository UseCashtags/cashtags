import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { navigate, type Route } from '../lib/router'
import { X_HANDLE, at } from '../lib/site'
import { SignInHost, openSignIn } from './SignIn'
import { useData } from '../lib/useData'
import { ICash, IChevron, ICompass, IDoc, IHome, IRocket, ISearch, IUser, IX } from './Icons'
import type { Me } from '../lib/types'
import { Avatar, Ext, Link, Mark } from './ui'

const NAV: { to: string; label: string; icon: ReactNode; match: Route['name'][] }[] = [
  { to: '/', label: 'Home', icon: <IHome />, match: ['home'] },
  { to: '/explore', label: 'Explore', icon: <ICompass />, match: ['explore', 'token', 'creator'] },
  { to: '/launch', label: 'Launch', icon: <IRocket />, match: ['launch'] },
  { to: '/payments', label: 'Payments', icon: <ICash />, match: ['payments'] },
  { to: '/account', label: 'Profile', icon: <IUser />, match: ['account'] },
  { to: '/docs', label: 'How it works', icon: <IDoc />, match: ['docs'] },
]

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const [q, setQ] = useState('')
  const me = useData(() => api.me().catch(() => null), [route.name === 'account'])
  // "Profile" opens your public page once signed in (as in the account menu); signed out it is the sign-in page
  const myHandle = me.data?.user?.handle ?? null
  const ownPage = route.name === 'creator' && !!myHandle && route.handle.toLowerCase() === myHandle.toLowerCase()
  const toOf = (n: (typeof NAV)[number]) => (n.label === 'Profile' && myHandle ? `/x/${myHandle}` : n.to)
  const isOn = (n: (typeof NAV)[number]) => (n.label === 'Profile' ? route.name === 'account' || ownPage : n.match.includes(route.name) && !(ownPage && n.label === 'Explore'))
  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main">
        <Link to="/" className="side-logo" aria-label="Cashtags home"><Mark size={34} /></Link>
        <nav>
          {NAV.map((n) => (
            <Link key={n.to} to={toOf(n)} className={`side-item ${isOn(n) ? 'on' : ''}`} aria-label={n.label} data-tip={n.label}>{n.icon}</Link>
          ))}
        </nav>
      </aside>

      <header className="topbar">
        <Link to="/" className="top-logo" aria-label="Cashtags home"><Mark size={28} /></Link>
        <form className="search-btn" onSubmit={(e) => { e.preventDefault(); navigate(`/explore?q=${encodeURIComponent(q.trim())}`) }}>
          <ISearch size={16} />
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a $CASHTAG, name, @handle or address" aria-label="Search" />
        </form>
        <div className="top-actions">
          <Ext href={`https://x.com/${X_HANDLE}`} className="btn ghost sm ct-x-btn" aria-label={`@${X_HANDLE} on X`}><IX size={17} /></Ext>
          {me.data ? <UserMenu me={me.data} /> : (
            <button type="button" className="btn ghost sm" onClick={() => openSignIn(route.name === 'launch' ? '/launch' : '/account')}>Sign in</button>
          )}
        </div>
      </header>

      <main className="main">
        {children}
        <Footer myHandle={myHandle} />
      </main>

      <SignInHost />
      <nav className="bottombar" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.to} to={toOf(n)} className={`bottom-item ${isOn(n) ? 'on' : ''}`}>{n.icon}<span>{n.label}</span></Link>
        ))}
      </nav>
    </div>
  )
}

/** The signed-in account: a button that opens a small menu (closes on outside click, Escape, or picking an item). */
function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const go = (to: string) => { setOpen(false); navigate(to) }
  return (
    <span className="wallet-wrap" ref={box}>
      <button type="button" className="btn ghost sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar src={me.user.avatar} size={22} label={me.user.handle} /> <span className="hide-sm">{at(me.user.handle)}</span> <IChevron dir="down" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => go(`/x/${me.user.handle}`)}>Profile</button>
          <button type="button" role="menuitem" onClick={() => go('/account')}>Settings</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); api.logout().then(() => { location.href = '/' }) }}>Sign out</button>
        </div>
      )}
    </span>
  )
}

function Footer({ myHandle }: { myHandle: string | null }) {
  return (
    <footer className="footer">
      <div className="foot-brand">
        <span className="wordmark"><Mark size={22} /> Cashtags</span>
        <div className="foot-social"><Ext className="foot-link" href={`https://x.com/${X_HANDLE}`}><IX size={14} /> @{X_HANDLE}</Ext></div>
      </div>
      <div className="foot-col">
        <div className="foot-title">Product</div>
        <Link to="/explore">Explore</Link><Link to="/launch">Launch</Link><Link to="/payments">Payments</Link><Link to={myHandle ? `/x/${myHandle}` : '/account'}>Profile</Link><Link to="/docs">How it works</Link>
      </div>
      <div className="foot-col">
        <div className="foot-title">Trade</div>
        <Ext href="https://fomo.family">FOMO</Ext><Ext href="https://pump.fun">Pumpfun</Ext><Ext href="https://solana.com">Solana</Ext>
      </div>
      <div className="foot-col">
        <div className="foot-title">Legal</div>
        <Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link>
      </div>
    </footer>
  )
}
