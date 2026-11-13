import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IChevron, IClose, IRocket, ISearch, IUsers, IWallet, IX } from '../components/Icons'
import { Avatar, Ext, SOLSCAN } from '../components/ui'
import { openSignIn } from '../components/SignIn'
import { api, type LaunchOptions, type PairCheck, type XUser } from '../lib/api'
import { short } from '../lib/format'
import { navigate } from '../lib/router'
import type { Mode } from '../lib/types'
import { useData } from '../lib/useData'
import { useModal } from '../lib/useModal'
import { canSignTransactions, fromBase64, toBase64, useWallet } from '../lib/wallet'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const QUICK_BUYS = ['0.1', '0.5', '1', '2']
const DRAFT = 'cashtags.launch'
const nameBytes = (s: string) => new TextEncoder().encode(s).length
const tokensFmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : Math.round(n).toLocaleString('en-US'))

type Picture = { preview: string; data: string } | null
type Pair = { input: string; symbol: string; mint?: string } | null
type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string; sub?: string }
  | { kind: 'error'; msg: string }
  /** sent to the network, but this page lost track of it: the coin may exist, so the transaction is shown */
  | { kind: 'sent'; msg: string; signature: string | null }

/** Fields kept across the sign-in round trip (the picture is not: it is picked again). */
type Saved = { name: string; symbol: string; description: string; website: string; twitter: string; devBuy: string }
const loadSaved = (): Partial<Saved> => { try { return JSON.parse(sessionStorage.getItem(DRAFT) ?? '{}') as Partial<Saved> } catch { return {} } }

export function Launch() {
  const opts = useData(() => api.launchOptions(), [])
  const me = useData(() => api.me().catch(() => null), [])
  const w = useWallet()
  const o = opts.data
  const saved = useMemo(loadSaved, [])

  const [name, setName] = useState(saved.name ?? '')
  const [symbol, setSymbol] = useState(saved.symbol ?? '')
  const [description, setDescription] = useState(saved.description ?? '')
  const [picture, setPicture] = useState<Picture>(null)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [linksOpen, setLinksOpen] = useState(!!(saved.website || saved.twitter))
  const [website, setWebsite] = useState(saved.website ?? '')
  const [twitter, setTwitter] = useState(saved.twitter ?? '')
  // ⭐ X Money: the token can be launched FOR another X account (its rewards go to their X Money), or the launcher can
  // have their own rewards paid to their X Money
  const [forOn, setForOn] = useState(true) // X Money is the default choice (operator 13 Nov)
  const [forHandle, setForHandle] = useState('')
  const [pair, setPair] = useState<Pair>(null)
  const [devBuy, setDevBuy] = useState(saved.devBuy ?? '')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [picking, setPicking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT, JSON.stringify({ name, symbol, description, website, twitter, devBuy } satisfies Saved)) } catch { /* private window */ }
  }, [name, symbol, description, website, twitter, devBuy])

  // the account's own setting is the starting choice; the form's choice is for this coin only
  const chosenMode: Mode = forOn ? 'creator' : 'holders'
  const forClean = forHandle.trim().replace(/^@/, '')
  const forOk = /^[A-Za-z0-9_]{1,15}$/.test(forClean)
  // the handle starts as the signed-in account's own: its rewards go to its own X Money unless another account is named
  const myHandle = me.data && !me.data.user.wallet ? me.data.user.handle : ''
  useEffect(() => { if (myHandle) setForHandle((h) => h || myHandle) }, [myHandle])

  // is the ticker free (a cashtag launched in the last 24 hours is taken)
  const [tickerNote, setTickerNote] = useState<string | null>(null)
  useEffect(() => {
    setTickerNote(null)
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol)) return
    let live = true
    const t = setTimeout(() => api.launchCheck(symbol).then((r) => { if (live) setTickerNote(r.ticker && !r.ticker.free ? r.ticker.reason : null) }).catch(() => {}), 400)
    return () => { live = false; clearTimeout(t) }
  }, [symbol])

  function pickPicture(file: File | undefined) {
    if (!file) return
    setPictureError(null)
    if (!IMAGE_TYPES.includes(file.type)) return setPictureError('PNG, JPG, GIF or WebP only.')
    if (file.size > (o?.imageMax ?? 4 * 1024 * 1024)) return setPictureError('That image is over 4 MB.')
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      setPicture({ preview: url, data: url.slice(url.indexOf(',') + 1) })
    }
    reader.onerror = () => setPictureError('That image could not be read.')
    reader.readAsDataURL(file)
  }

  const buy = Number(devBuy || '0')
  const wantsBuy = buy > 0
  const buyOff = !o?.devBuy.enabled ? 'Dev buys are switched off right now. You can buy on Pumpfun or FOMO as soon as the token is live.'
    : pair ? 'A dev buy is available when the token is paired with SOL.' : null
  const estimate = useMemo(() => {
    if (!o || !(buy > 0)) return null
    const net = buy / (1 + o.devBuy.feeBps / 10_000)
    const tokens = (o.curve.virtualTokens * net) / (o.curve.virtualSol + net)
    return { tokens, pct: (tokens / o.curve.supply) * 100 }
  }, [o, buy])

  // ⭐ the X account behind the handle, looked up on X as it is typed (700 ms after the last key: each lookup is a paid read)
  const signedIn = !!me.data
  const [xUser, setXUser] = useState<{ state: 'idle' | 'checking' | 'found' | 'missing' | 'error'; user?: Extract<XUser, { found: true }>; msg?: string }>({ state: 'idle' })
  useEffect(() => {
    if (!forOn || !forOk || !signedIn) { setXUser({ state: 'idle' }); return }
    let live = true
    setXUser({ state: 'checking' })
    const t = setTimeout(() => api.xUser(forClean).then(
      (r) => { if (live) setXUser(r.found ? { state: 'found', user: r } : { state: 'missing' }) },
      (e: Error) => { if (live) setXUser({ state: 'error', msg: e.message }) },
    ), 700)
    return () => { live = false; clearTimeout(t) }
  }, [forOn, forOk, forClean, signedIn])

  const problems: string[] = []
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol)) problems.push(symbol ? 'The ticker is letters and numbers, starting with a letter' : 'Add a ticker')
  if (nameBytes(name.trim()) > (o?.nameMax ?? 32)) problems.push('The name is too long')
  if (tickerNote) problems.push('That ticker is taken for now')
  if (forOn && !forOk) problems.push('Add the X handle the fees go to')
  else if (forOn && signedIn && xUser.state === 'checking') problems.push('Checking that X account')
  else if (forOn && signedIn && xUser.state === 'missing') problems.push('That X account was not found')
  if (wantsBuy && !buyOff) {
    if (o && buy < o.devBuy.minSol) problems.push(`The smallest dev buy is ${o.devBuy.minSol} SOL`)
    if (o && buy > o.devBuy.maxSol) problems.push(`The largest dev buy is ${o.devBuy.maxSol} SOL`)
  }

  const busy = phase.kind === 'busy'
  const closed = !!o && !o.open

  /** Follows a launch until the chain has answered, then opens the coin's page. */
  const follow = useCallback(async (id: string, signature: string | null) => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, i < 10 ? 1200 : 2500))
      let s
      try { s = await api.launchStatus(id) } catch { continue }
      if (s.state === 'launched' && s.mint) {
        try { sessionStorage.removeItem(DRAFT) } catch { /* private window */ }
        return navigate(`/t/${s.mint}`)
      }
      if (s.state === 'rejected' || s.state === 'failed' || s.state === 'expired') return setPhase({ kind: 'error', msg: s.reason ?? 'The launch did not go through. Try again.' })
      setPhase({ kind: 'busy', msg: s.state === 'queued' ? 'In the queue' : 'Launching on Pumpfun', sub: s.state === 'queued' ? 'Your token launches as soon as its turn comes. Keep this page open.' : 'Waiting for Solana to confirm.' })
    }
    setPhase({ kind: 'sent', msg: 'This is taking longer than usual. Your token shows up on your profile once it is live.', signature })
  }, [])

  async function launch() {
    if (problems.length || busy || !o) return
    const withBuy = wantsBuy && !buyOff
    // the launch is paid from the launcher's own wallet
    if (!w.address) return setPicking(true)
    try {
      setPhase({ kind: 'busy', msg: 'Preparing your token' })
      const r = await api.launch({
        symbol, name: name.trim(), description: description.trim(), website: website.trim(), twitter: twitter.trim(), telegram: '',
        mode: chosenMode, pair: pair?.mint ?? pair?.input ?? '', image: picture?.data ?? null,
        wallet: w.address, devBuy: withBuy ? { sol: devBuy } : null,
        ...(forOn ? { forHandle: forClean } : {}),
      })
      if (r.state === 'signing' && r.transaction) {
        if (!r.mint?.endsWith('cash')) throw new Error('The server returned an unexpected token address. Nothing was signed.')
        setPhase({ kind: 'busy', msg: 'Approve the launch in your wallet', sub: withBuy ? `Launching $${symbol} and buying ${devBuy} SOL of it.` : `Launching $${symbol}.` })
        let signed: Uint8Array
        try { signed = await w.sign(fromBase64(r.transaction)) } catch (e) {
          return setPhase({ kind: 'error', msg: /reject|denied|cancel|declin/i.test((e as Error).message) ? 'You declined in your wallet. Nothing was sent.' : `Your wallet did not sign: ${(e as Error).message}` })
        }
        setPhase({ kind: 'busy', msg: 'Launching on Pumpfun', sub: 'Waiting for Solana to confirm.' })
        const sent = await api.launchSign(r.id, toBase64(signed))
        return follow(r.id, sent.signature ?? null)
      }
      setPhase({ kind: 'busy', msg: 'In the queue', sub: 'Your token launches as soon as its turn comes. Keep this page open.' })
      return follow(r.id, null)
    } catch (e) {
      setPhase({ kind: 'error', msg: (e as Error).message })
    }
  }

  const label = busy ? phase.msg
    : closed ? 'Launching is closed right now'
    : problems[0] ?? (!w.address ? 'Connect wallet to launch' : wantsBuy && !buyOff ? `Launch and buy ${devBuy} SOL` : 'Launch')

  return (
    <div className="page ct-launch">
      <header className="ct-launch-hero">
        <div className="ct-kicker"><IRocket size={12} /> Launch here</div>
        <h1>Launch a token</h1>
        <p className="muted">Your token goes live on Pumpfun in seconds with an address ending in <span className="mono">cash</span>.</p>
      </header>

      <div className="launch-layout">
        <div className="ct-launch-form">
          <Section n="1" title="Your token">
            <div className="ct-launch-id">
              <div
                className={`ct-pic ${picture ? 'has' : ''}`} role="button" tabIndex={0} aria-label="Choose the token image"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click() } }}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickPicture(e.dataTransfer.files[0]) }}
              >
                {picture ? <img src={picture.preview} alt="" /> : <span className="ct-pic-empty"><span className="ct-pic-plus">+</span><span>Image</span></span>}
                <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => { pickPicture(e.target.files?.[0]); e.target.value = '' }} />
              </div>
              <div className="ct-launch-names">
                <div>
                  <label className="field-label" htmlFor="l-sym">Cashtag</label>
                  <div className="input-row"><span className="ct-cash">$</span><input id="l-sym" value={symbol} maxLength={o?.symbolMax ?? 10} autoComplete="off" spellCheck={false} placeholder="DOGE"
                    onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} /></div>
                </div>
                <div>
                  <label className="field-label" htmlFor="l-name">Name</label>
                  <input id="l-name" value={name} maxLength={32} placeholder={symbol || 'Doge Coin'} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
            </div>
            {tickerNote && <div className="note error" role="status">{tickerNote}</div>}
            {pictureError && <div className="note error" role="status">{pictureError}</div>}
            {picture && <div className="muted tiny"><button type="button" className="ct-linkish" onClick={() => setPicture(null)}>Remove the image</button></div>}
            <label className="field-label" htmlFor="l-desc">Description <span className="muted">(optional)</span></label>
            <textarea id="l-desc" rows={3} value={description} maxLength={o?.descMax ?? 500} placeholder="What is this token about?" onChange={(e) => setDescription(e.target.value)} />
            <button type="button" className="collapse small" aria-expanded={linksOpen} onClick={() => setLinksOpen((v) => !v)}>Links (optional) <IChevron dir={linksOpen ? 'down' : 'right'} /></button>
            {linksOpen && (
              <div className="ct-links">
                <div className="input-row"><span className="ct-link-tag">Website</span><input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="yourtoken.com" spellCheck={false} /></div>
                <div className="input-row"><span className="ct-link-tag"><IX size={13} /></span><input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or a link" spellCheck={false} /></div>
              </div>
            )}
          </Section>

          <Section n="2" title="Creator rewards">
            <div className="ct-mode-cards" role="radiogroup" aria-label="Creator rewards">
              <ModeCard on={forOn} onClick={() => setForOn(true)} icon={<IX size={16} />} label="X Money" />
              <ModeCard on={!forOn} onClick={() => setForOn(false)} icon={<IUsers size={18} />} label="Holders" />
            </div>
            {forOn ? (
              <>
                <div className="input-row"><span className="ct-at">@</span><input value={forHandle} maxLength={16} autoComplete="off" spellCheck={false} placeholder="X handle" aria-label="The X account the fees go to"
                  onChange={(e) => setForHandle(e.target.value.replace(/[^A-Za-z0-9_@]/g, ''))} /></div>
                {xUser.state === 'found' && xUser.user && (
                  <div className="ct-xuser" role="status">
                    <Avatar src={xUser.user.avatar} size={40} label={xUser.user.handle} />
                    <div className="grow"><div className="ct-xuser-name">{xUser.user.name}</div><div className="muted small">@{xUser.user.handle}{xUser.user.followers != null ? ` · ${xUser.user.followers.toLocaleString('en-US')} followers` : ''}{xUser.user.self ? ' · you' : ''}</div></div>
                    <Ext href={`https://x.com/${xUser.user.handle}`} className="btn ghost xs">View on X</Ext>
                    <span className="ct-xuser-ok" aria-label="Found on X">✓</span>
                  </div>
                )}
                {xUser.state === 'checking' && <div className="muted small" role="status">Looking up @{forClean} on X…</div>}
                {xUser.state === 'missing' && <div className="note error" role="status">@{forClean} was not found on X. Check the handle.</div>}
                {xUser.state === 'error' && <div className="note" role="status">{xUser.msg ?? 'That X account could not be checked just now.'} You can still launch: the handle is checked again when you do.</div>}
              </>
            ) : null}
          </Section>

          <Section n="3" title="Paired with" hint="Every token trades against SOL unless you pick another token.">
            <PairPicker options={o} pair={pair} onPick={setPair} />
          </Section>

          <Section n="4" title="Dev buy" hint="Optional. Buy your own token in the launch transaction itself, before anyone else can.">
            {buyOff ? <div className="note">{buyOff}</div> : (
              <>
                <div className="input-row ct-buy-row">
                  <input id="l-buy" inputMode="decimal" value={devBuy} placeholder="0.00" aria-label="Dev buy in SOL"
                    onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))} />
                  <span className="muted">SOL</span>
                </div>
                <div className="ct-quick">
                  {QUICK_BUYS.map((q) => <button key={q} type="button" className={`chip ${devBuy === q ? 'on' : ''}`} onClick={() => setDevBuy(q)}>{q} SOL</button>)}
                  {wantsBuy && <button type="button" className="chip" onClick={() => setDevBuy('')}>None</button>}
                </div>
                {estimate && o && (
                  <div className="ct-buy-est">
                    <div><div className="muted tiny">You receive about</div><div className="amount sm">{tokensFmt(estimate.tokens)} ${symbol || 'tokens'}</div></div>
                    <div><div className="muted tiny">Share of supply</div><div className="amount sm">{estimate.pct.toFixed(2)}%</div></div>
                    <div><div className="muted tiny">Buy cost</div><div className="amount sm">{(buy + o.devBuy.extraSol).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL</div></div>
                  </div>
                )}
              </>
            )}
          </Section>
        </div>

        <aside className="launch-side">
          <div className="card preview-token ct-preview">
            {pair && <div className="ct-preview-top"><span className="pill">Paired with ${pair.symbol}</span></div>}
            <div className="ct-preview-id">
              <div className="pt-art">{picture ? <img src={picture.preview} alt="" /> : <span className="ct-preview-mark"><img src="/mark-t.png" alt="" /></span>}</div>
              <div className="ct-preview-name"><span className="ct-cash">${symbol || 'CASHTAG'}</span><span className="muted ct-trunc">{name.trim() || symbol || 'Token name'}</span></div>
            </div>
            <dl className="kv">
              <dt>Launch cost</dt><dd>About {o?.launchCostSol ?? 0.01} SOL</dd>
              <dt>Creator rewards</dt><dd>{forOn ? (forOk ? `X Money @${forClean}` : 'X Money') : 'Holders'}</dd>
              <dt>Dev buy</dt><dd>{wantsBuy && !buyOff ? `${devBuy} SOL` : 'None'}</dd>
              <dt>Address</dt><dd className="mono">…cash</dd>
            </dl>
            {!signedIn && !me.loading ? (
              <button type="button" className="btn white block" onClick={() => openSignIn('/launch')}>Sign in to launch</button>
            ) : (
              <>
                {w.address && (
                  <div className="ct-wallet-row">
                    <IWallet size={18} />
                    <div className="grow"><div className="small">Paying wallet</div><div className="mono muted small">{short(w.address, 6, 6)}</div></div>
                    <button type="button" className="btn ghost xs" onClick={() => setPicking(true)}>Change</button>
                  </div>
                )}
                <button type="button" className="btn white block" disabled={busy || closed || !o || (problems.length > 0)} onClick={launch}>{label}</button>
              </>
            )}
            {phase.kind === 'busy' && phase.sub && <div className="note" role="status">{phase.sub}</div>}
            {phase.kind === 'error' && <div className="note error" role="alert">{phase.msg}</div>}
            {phase.kind === 'sent' && <div className="note" role="status">{phase.msg}{phase.signature && <> <Ext href={SOLSCAN('tx', phase.signature)} className="u">View the transaction</Ext></>}</div>}
            {opts.error && !o && <div className="note error">The launch form could not load: {opts.error}</div>}
          </div>
        </aside>
      </div>

      {picking && <WalletPicker w={w} onClose={() => setPicking(false)} />}
    </div>
  )
}

function Section({ n, title, hint, children }: { n: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card ct-launch-section">
      <div className="ct-doc-head"><span className="ct-doc-n">{n.padStart(2, '0')}</span><div><h2>{title}</h2>{hint && <div className="muted small">{hint}</div>}</div></div>
      {children}
    </section>
  )
}

function ModeCard({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`ct-mode-card ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="ct-mode-icon">{icon}</span><span className="ct-mode-label">{label}</span><span className="ct-mode-dot" aria-hidden="true" />
    </button>
  )
}

/** SOL, a token from Pumpfun's own pair list (searched by ticker), or any Pumpfun coin by its contract address. */
function PairPicker({ options, pair, onPick }: { options: LaunchOptions | undefined; pair: Pair; onPick: (p: Pair) => void }) {
  const [q, setQ] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const term = q.trim().replace(/^\$/, '')
  const isAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(term)
  const matches = useMemo(() => {
    if (!term || isAddress) return []
    const t = term.toUpperCase()
    return (options?.pairs ?? []).filter((p) => p.symbol.toUpperCase().startsWith(t) || p.name.toUpperCase().includes(t)).slice(0, 8)
  }, [term, isAddress, options])
  // a pasted contract address: ask whether Pumpfun can pair with it
  useEffect(() => {
    setNote(null)
    if (!isAddress) return
    let live = true
    setChecking(true)
    const t = setTimeout(() => api.launchCheck('', term).then((r) => {
      if (!live) return
      const p: PairCheck | null = r.pair
      if (p?.ok && !p.sol) { onPick({ input: term, symbol: p.symbol || short(term, 4, 4), mint: p.mint }); setQ('') }
      else setNote(p?.ok ? 'That is SOL, the default pair.' : p?.reason ?? 'That token cannot be a pair.')
    }).catch(() => { if (live) setNote('That pair could not be checked just now.') }).finally(() => { if (live) setChecking(false) }), 450)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, isAddress])
  return (
    <div className="stack">
      <div className="ct-quick">
        <button type="button" className={`chip ${!pair ? 'on' : ''}`} onClick={() => { onPick(null); setQ('') }}>SOL</button>
        {pair && <span className="chip on ct-chip-x">${pair.symbol}<button type="button" className="icon-btn" aria-label="Remove the pair" onClick={() => onPick(null)}><IClose size={12} /></button></span>}
      </div>
      {!pair && (
        <div className="lookup">
          <div className="input-row"><ISearch size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Pumpfun's pair list ($BONK, $PUMP, USDC…) or paste a Pumpfun token address" aria-label="Custom pair" spellCheck={false} /></div>
          {matches.length > 0 && (
            <div className="lookup-list">
              {matches.map((p) => (
                <button type="button" key={p.mint} className="palette-row" onClick={() => { onPick({ input: p.mint, symbol: p.symbol, mint: p.mint }); setQ('') }}>
                  <b>${p.symbol}</b> <span className="muted small ct-trunc">{p.name}</span>
                </button>
              ))}
            </div>
          )}
          {term && !isAddress && !matches.length && <div className="muted small ct-pair-note">${term.toUpperCase()} is not on Pumpfun's pair list. To pair with a Pumpfun token, paste its contract address.</div>}
          {checking && <div className="muted small ct-pair-note">Checking that token…</div>}
          {note && <div className="note error ct-pair-note">{note}</div>}
        </div>
      )}
      {pair && <div className="muted small">Creator rewards for this token are earned in ${pair.symbol}.</div>}
    </div>
  )
}

function WalletPicker({ w, onClose }: { w: ReturnType<typeof useWallet>; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const close = useCallback(() => onClose(), [onClose])
  const box = useModal<HTMLDivElement>(true, close)
  return (
    <div className="overlay" onClick={close}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h3 style={{ margin: 0 }}>Connect a wallet</h3><button type="button" className="icon-btn" aria-label="Close" onClick={close}><IClose /></button></div>
        {w.wallets.length ? (
          <div className="wallet-list">
            {w.wallets.filter(canSignTransactions).map((x) => (
              <button type="button" key={x.name} className="wallet-row" onClick={() => w.connect(x).then(close).catch((e: Error) => setErr(/reject|denied|cancel|declin/i.test(e.message) ? 'You declined in your wallet.' : e.message))}>
                <img src={x.icon} alt="" width={28} height={28} /> <span>{x.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small" style={{ margin: 0 }}>No Solana wallet was found in this browser. Install Phantom, Solflare or Backpack to launch here. Launching on X needs no wallet.</p>}
        <div className="muted tiny">This wallet pays for the launch and for your dev buy, if you add one.</div>
        {err && <div className="note error">{err}</div>}
      </div>
    </div>
  )
}
