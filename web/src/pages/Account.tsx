import { useEffect, useState } from 'react'
import { IExternal, IUser, IUsers } from '../components/Icons'
import { Avatar, Empty, ErrorNote, Ext, Link, Loading, ModePill, SOLSCAN, SafeImg, SectionHead } from '../components/ui'
import { api } from '../lib/api'
import { openSignIn } from '../components/SignIn'
import { ago } from '../lib/format'
import { X_HANDLE, amt, at, sol, tweetIntent } from '../lib/site'
import type { Me, Mode, PayoutKind } from '../lib/types'
import { useData } from '../lib/useData'
import { ModeSwitch } from './Token'

export function Account() {
  const me = useData(() => api.me(), [])
  const err = new URLSearchParams(location.search).get('error')
  if (me.loading && !me.data) return <div className="page"><Loading /></div>
  if (!me.data) {
    if (me.status !== 401) return <div className="page"><ErrorNote error={me.error ?? 'unknown'} /></div>
    return (
      <div className="page">
        <div className="card ct-signin">
          <h1>Your cashtags and rewards</h1>
          <p className="muted">Cashtags you launch by tagging @{X_HANDLE} belong to your X account. Sign in with X to claim their creator rewards, set automatic payouts, or send the fees to your holders.</p>
          {err && <div className="note error">Sign-in did not complete{err !== 'signin' ? `: ${err}` : ''}. Try again.</div>}
          <button type="button" className="btn white" onClick={() => openSignIn('/account')}>Sign in</button>
          <p className="muted tiny">Sign in with X or with a Solana wallet. Signing in with X only reads your public profile: Cashtags never posts for you.</p>
        </div>
      </div>
    )
  }
  return <SignedIn me={me.data} reload={me.reload} />
}

function SignedIn({ me, reload }: { me: Me; reload: () => void }) {
  const [dest, setDest] = useState(me.settings.payoutWallet)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { setDest(me.settings.payoutWallet) }, [me.settings.payoutWallet])
  // "Payout settings" in the account menu links here with #payouts: scroll once the page has rendered.
  useEffect(() => { if (location.hash === '#payouts') document.getElementById('payouts')?.scrollIntoView({ block: 'start' }) }, [])
  // asset: 'SOL', or the mint of a pair token owed from paired coins (paid in that token)
  const withdraw = async (asset = 'SOL', unit = 'SOL') => {
    setBusy(true); setMsg(null)
    try {
      const r = await api.withdraw(dest.trim(), asset)
      setMsg({ ok: true, text: r.pending ? 'Sent. The network has not confirmed it yet: it shows here once it does.' : `Sent ${amt(r.paid, unit)}.` })
      reload()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  return (
    <div className="page">
      <section className="row-between">
        <div className="row-gap">
          <Avatar src={me.user.avatar} size={52} label={me.user.handle} />
          <div><h1>{at(me.user.handle)}</h1><div className="muted small">{me.tokens.length} {me.tokens.length === 1 ? 'coin' : 'coins'}</div></div>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => api.logout().then(() => { location.href = '/' })}>Sign out</button>
      </section>

      <section className="grid-2 ct-account">
        <div className="card stack">
          <div className="muted small">Creator rewards ready to withdraw</div>
          <div className="huge-num">{sol(me.owedSol)}</div>
          <div className="muted small">about ${me.owedUsd.toFixed(2)}</div>
          <label className="field-label small muted" htmlFor="dest">Send to (a Solana wallet address)</label>
          <input id="dest" className="mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Your Solana wallet address" spellCheck={false} />
          <button type="button" className="btn white" disabled={busy || me.owedSol < me.minWithdrawSol || !dest.trim()} onClick={() => withdraw()}>{busy ? 'Sending…' : 'Withdraw'}</button>
          {(me.owed ?? []).filter((a) => a.asset !== 'SOL').map((a) => (
            // paired coins pay their creator in the pair token
            <div key={a.asset} className="row-between ct-owed-token">
              <div><div className="amount sm">{amt(a.amount, a.symbol)}</div><div className="muted tiny">from {a.coins} paired {a.coins === 1 ? 'coin' : 'coins'}</div></div>
              <button type="button" className="btn ghost sm" disabled={busy || !(a.amount > 0) || !dest.trim()} onClick={() => withdraw(a.asset, a.symbol)}>Withdraw {a.symbol}</button>
            </div>
          ))}
          {msg && <div className={`note ${msg.ok ? '' : 'error'}`}>{msg.text}</div>}
        </div>
        <PayoutSettings me={me} onSaved={reload} />
      </section>

      <section className="card ct-launch-pref">
        <h2>New launches</h2>
        <p className="muted small ct-launch-pref-text">Where creator rewards go for coins you launch from now on. <strong>Fees to holders</strong> is the default: it launches the coin with Pumpfun holder rewards: Pumpfun pays your holders directly, and that coin stays a holder-rewards coin for good.</p>
        <DefaultMode mode={me.settings.defaultMode} onSaved={reload} />
      </section>

      {me.options.float && (
        <section className="card ct-launch-pref">
          <h2>Launch on</h2>
          <p className="muted small ct-launch-pref-text">Where your tokens launch when your post does not say. Add <strong>on Float</strong> or <strong>on Pumpfun</strong> to a post to choose for that one.</p>
          <LaunchVenue venue={me.settings.launchVenue ?? 'pump'} onSaved={reload} />
        </section>
      )}

      <section>
        <div className="ct-center-head"><SectionHead title="Your cashtags" /></div>
        {me.tokens.length ? (
          <div className="stack">
            {me.tokens.map((t) => (
              <div key={t.mint} className="row ct-coin-row">
                <div className="row-gap grow">
                  <SafeImg src={t.image} label={t.symbol} size={44} radius={12} />
                  <div className="grow">
                    <Link to={`/t/${t.mint}`} className="cc-name u">${t.symbol}</Link>
                    <div className="muted small">{t.name}{t.quote ? ` · paired with ${t.unit}` : ''} · earned {t.quote ? amt(t.creatorEarned, t.unit) : sol(t.creatorEarnedSol + t.holdersEarnedSol)}{t.creatorOwed > 0 ? ` · ${amt(t.creatorOwed, t.unit)} yours to withdraw` : ''}</div>
                  </div>
                </div>
                <div className="ct-coin-mode"><ModePill mode={t.mode} native={t.nativeHolders} />{t.ownCreator ? <div className="muted tiny">Fees go to its creator wallet, claimed on Pumpfun.</div> : t.nativeHolders ? <div className="muted tiny">Paid by Pumpfun to holders, permanently.</div> : t.quote ? <div className="muted tiny">Paid to you in {t.unit}.</div> : <ModeSwitch mint={t.mint} mode={t.mode} onDone={reload} />}</div>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No cashtags yet">
            <Ext href={tweetIntent(`@${X_HANDLE} $`)} className="u">Post a $CASHTAG to @{X_HANDLE}</Ext> and it shows up here.
          </Empty>
        )}
      </section>

      {(me.xmoney?.length ?? 0) > 0 && (
        <section>
          <SectionHead title="X Money payouts" />
          <div className="stack">
            {me.xmoney!.map((x) => (
              <div key={x.id} className="row">
                <div className="row-main"><div className="amount sm">{x.usd > 0 ? `$${x.usd.toFixed(2)}` : `${x.sol.toFixed(4)} SOL`}</div><div className="muted small">{x.status}{x.paidUsd > 0 && !x.done ? ` · $${x.paidUsd.toFixed(2)} paid so far` : ''}</div></div>
                <div className="row-side muted small"><span>{ago(x.time)}</span><span>@{x.handle}</span></div>
              </div>
            ))}
          </div>
        </section>
      )}
      {me.payouts.length > 0 && (
        <section>
          <div className="ct-center-head"><SectionHead title="Payouts" /></div>
          <div className="stack">
            {me.payouts.map((p) => (
              <div key={p.signature + p.mint} className="row">
                <div className="row-main"><div className="amount sm">{amt(p.amount, p.unit)}</div><div className="muted small mono">{p.destination?.startsWith('xmoney:') ? `to X Money ${p.destination.slice(7)}` : `to ${p.destination?.slice(0, 6)}…${p.destination?.slice(-6)}`}{p.state === 'sending' ? ' · confirming' : ''}</div></div>
                <div className="row-side muted small"><span>{ago(p.time)}</span><Ext href={SOLSCAN('tx', p.signature)} className="tx">tx <IExternal /></Ext></div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function LaunchVenue({ venue, onSaved }: { venue: 'pump' | 'float'; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const set = async (v: 'pump' | 'float') => {
    if (v === venue || busy) return
    setBusy(v); setErr(null)
    try {
      await api.settings({ launchVenue: v })
      // read back: only a value the server returns counts as saved
      if ((await api.me()).settings.launchVenue !== v) throw new Error('That change did not save. Try again.')
      onSaved()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const opts: { v: 'pump' | 'float'; label: string; mark: string }[] = [
    { v: 'pump', label: 'Pumpfun', mark: 'P' },
    { v: 'float', label: 'Float', mark: 'F' },
  ]
  return (
    <div className="stack">
      <div className="ct-mode-cards" role="radiogroup" aria-label="Launch on">
        {opts.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={venue === o.v} className={`ct-mode-card ${venue === o.v ? 'on' : ''}`} disabled={!!busy} onClick={() => set(o.v)}>
            <span className="ct-mode-icon"><strong>{o.mark}</strong></span>
            <span className="ct-mode-label">{busy === o.v ? 'Saving…' : o.label}</span>
            <span className="ct-mode-dot" aria-hidden="true" />
          </button>
        ))}
      </div>
      {err && <div className="note error">{err}</div>}
    </div>
  )
}

function DefaultMode({ mode, onSaved }: { mode: Mode; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<Mode | null>(null)
  const set = async (m: Mode) => {
    if (m === mode || busy) return
    setBusy(m); setErr(null)
    try {
      await api.settings({ defaultMode: m })
      // read back: only a value the server returns counts as saved
      const back = await api.me()
      if (back.settings.defaultMode !== m) throw new Error('That change did not save. Try again.')
      onSaved()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const opts: { m: Mode; label: string; icon: JSX.Element }[] = [
    { m: 'creator', label: 'Fees to me', icon: <IUser size={18} /> },
    { m: 'holders', label: 'Fees to holders', icon: <IUsers size={18} /> },
  ]
  return (
    <div className="stack">
      <div className="ct-mode-cards" role="radiogroup" aria-label="New launches">
        {opts.map((o) => (
          <button key={o.m} type="button" role="radio" aria-checked={mode === o.m} className={`ct-mode-card ${mode === o.m ? 'on' : ''}`} disabled={!!busy} onClick={() => set(o.m)}>
            <span className="ct-mode-icon">{o.icon}</span>
            <span className="ct-mode-label">{busy === o.m ? 'Saving…' : o.label}</span>
            <span className="ct-mode-dot" aria-hidden="true" />
          </button>
        ))}
      </div>
      {err && <div className="note error">{err}</div>}
    </div>
  )
}

const KINDS: { kind: PayoutKind; title: string; text: string }[] = [
  { kind: 'claim', title: 'Manual payments', text: 'Fees wait here until you withdraw them.' },
  { kind: 'wallet', title: 'Automated payments', text: 'Sent as soon as your fees pass your threshold.' },
  { kind: 'fomo', title: 'FOMO payments', text: 'Enter your FOMO handle. Its wallet is checked on chain first.' },
  { kind: 'xmoney', title: 'X Money payments', text: 'Paid in dollars to the X Money of the account you signed in with, once your fees pass your threshold. Usually within a day.' },
]

function PayoutSettings({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const s = me.settings
  const [kind, setKind] = useState<PayoutKind>(s.payoutKind === 'xmoney' && !me.options.xmoney ? 'claim' : s.payoutKind)
  const [xmOn, setXmOn] = useState(s.payoutKind === 'xmoney' && s.payoutConfirmed)
  const [wallet, setWallet] = useState(s.payoutKind === 'wallet' ? s.payoutWallet : '')
  const [fomo, setFomo] = useState(s.fomoHandle)
  const [min, setMin] = useState(String(s.autoMinSol))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await api.settings({ payoutKind: kind, payoutWallet: wallet.trim(), fomoHandle: fomo.trim(), ...(kind === 'xmoney' ? { xmoneyOn: xmOn } : {}), ...(kind !== 'claim' ? { autoMinSol: Number(min) } : {}) })
      // read back: "Saved." only once the server returns what was sent
      const back = (await api.me()).settings
      const same = back.payoutKind === kind && (kind !== 'wallet' || back.payoutWallet === wallet.trim()) && (kind === 'claim' || Math.abs(back.autoMinSol - Number(min)) < 1e-9)
      if (!same) throw new Error('That change did not save. Try again.')
      setMsg({ ok: true, text: kind === 'fomo' && !r.payoutConfirmed ? 'Saved. That FOMO wallet could not be confirmed on chain yet, so auto payouts wait until it is.' : 'Saved.' })
      onSaved()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  return (
    <div className="card stack" id="payouts">
      <div className="muted small ct-card-title">Payouts</div>
      {KINDS.map((k) => {
        const disabled = (k.kind === 'xmoney' && !me.options.xmoney) || (k.kind === 'fomo' && !me.options.fomo)
        return (
          <label key={k.kind} className={`ct-option ${kind === k.kind ? 'on' : ''} ${disabled ? 'off' : ''}`}>
            <input type="radio" name="payout" checked={kind === k.kind} disabled={disabled} onChange={() => setKind(k.kind)} />
            <div>
              <div className="ct-option-title">{k.title}{k.kind === 'xmoney' && !me.options.xmoney && <span className="pill ghost">Not available yet</span>}</div>
              <div className="muted tiny">{k.kind === 'xmoney' && !me.options.xmoney ? me.options.xmoneyNote : k.kind === 'fomo' && !me.options.fomo ? 'Coming soon.' : k.text}</div>
            </div>
          </label>
        )
      })}
      {kind === 'wallet' && <input className="mono" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Solana wallet address" spellCheck={false} />}
      {kind === 'fomo' && <input value={fomo} onChange={(e) => setFomo(e.target.value)} placeholder="Your FOMO handle" />}
      {kind === 'xmoney' && (
        <label className="small muted ct-inline ct-threshold"><input type="checkbox" checked={xmOn} onChange={(e) => setXmOn(e.target.checked)} /> X Money is turned on for @{me.user.handle}</label>
      )}
      {(kind === 'wallet' || kind === 'fomo' || kind === 'xmoney') && (
        <label className="small muted ct-inline ct-threshold">Pay out once fees reach <input className="ct-num" value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" /> SOL</label>
      )}
      <button type="button" className="btn sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save payout setting'}</button>
      {s.payoutKind === 'xmoney' && <div className="muted tiny">Now: X Money payouts to @{me.user.handle}{me.options.xmoneyMinSol ? `, from ${Math.max(me.options.xmoneyMinSol, s.autoMinSol)} SOL` : ''}. Coins paired with another token still pay out in that token: withdraw those here.</div>}
      {s.payoutKind !== 'claim' && s.payoutWallet && <div className="muted tiny">Now: auto payouts to <span className="mono">{s.payoutWallet.slice(0, 6)}…{s.payoutWallet.slice(-6)}</span>{s.payoutConfirmed ? '' : ' (waiting for confirmation)'}</div>}
      {msg && <div className={`note ${msg.ok ? '' : 'error'}`}>{msg.text}</div>}
    </div>
  )
}
