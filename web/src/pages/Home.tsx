import { useState } from 'react'
import { IArrow, IRocket, IUser, IUsers, IX } from '../components/Icons'
import { Empty, Ext, Link, Loading, SectionHead, Stat, TokenTile } from '../components/ui'
import { api } from '../lib/api'
import { ago, usd } from '../lib/format'
import { X_HANDLE, at, sol, tweetIntent } from '../lib/site'
import { useData } from '../lib/useData'

const EXAMPLES = ['Launch $DOGE', 'launch $PILL paired with $PUMP', 'launch $GM for @yourfriend']
const FOR_RE = /for (@[A-Za-z0-9_]+)/

export function Home() {
  const stats = useData(() => api.stats(), [], 15_000)
  const feed = useData(() => api.feed(), [], 10_000)
  const tokens = useData(() => api.tokens('new', '', 12), [], 30_000)
  // signed in with X: the example post is shown as the visitor's own (their picture, name and handle)
  const me = useData(() => api.me().catch(() => null), [])
  const who = me.data?.user
  const [ex, setEx] = useState(0)
  const s = stats.data
  const example = `@${X_HANDLE} ${EXAMPLES[ex]}`
  return (
    <div className="page home ct-home">
      <section className="ct-hero">
        <div className="ct-hero-text">
          <div className="ct-kicker"><IX size={11} /> Launch from X</div>
          <h1 className="ct-brand" aria-label="Cashtag">
            <img src="/mark-t.png" alt="" className="ct-brand-mark" width={104} height={104} />
            <span className="ct-wordmark">CASHTAG</span>
          </h1>
          <p className="lede muted">Turn any cashtag into a tradable token by simply tagging @{X_HANDLE} on X.</p>
          <div className="hero-cta">
            <Ext href={tweetIntent(example)} className="btn white"><IX size={14} /> Launch on X</Ext>
            <Link to="/launch" className="btn ghost"><IRocket size={15} /> Launch here</Link>
            <Link to="/docs" className="btn ghost">How it works <IArrow /></Link>
          </div>
        </div>
        <div className="ct-tweet card" aria-label="Example post">
          <div className="ct-tweet-head"><span className={`ct-tweet-av ${who?.avatar ? 'me' : ''}`}><img src={who?.avatar || '/mark-t.png'} alt="" width={26} height={26} referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.parentElement?.classList.remove('me'); e.currentTarget.src = '/mark-t.png' }} /></span><div><div className="ct-tweet-name">{who ? (who.name || who.handle) : 'you'}</div><div className="muted small">@{who?.handle ?? 'you'} · now</div></div><IX size={16} /></div>
          <div className="ct-tweet-body"><span className="ct-at">@{X_HANDLE}</span> {EXAMPLES[ex].split(/(\$[A-Z]+|@[A-Za-z0-9_]+)/).map((p, i) => p.startsWith('$') ? <span key={i} className="ct-cash">{p}</span> : p.startsWith('@') ? <span key={i} className="ct-at">{p}</span> : p)}</div>
          <div className="seg ct-ex">{EXAMPLES.map((e, i) => <button key={e} type="button" className={`chip ${i === ex ? 'on' : ''}`} onClick={() => setEx(i)}>{['Simple', 'With a pair', 'With X Money'][i]}</button>)}</div>
          <div className="ct-reply">
            <div className="muted small">@{X_HANDLE} replies</div>
            <div className="ct-reply-body">{EXAMPLES[ex].match(/\$[A-Z]+/)?.[0]} is live{/paired with (\$[A-Z]+)/.exec(EXAMPLES[ex])?.[1] ? ` paired with ${/paired with (\$[A-Z]+)/.exec(EXAMPLES[ex])?.[1]}` : '.'}<br />{FOR_RE.exec(EXAMPLES[ex]) && <>Launched for {FOR_RE.exec(EXAMPLES[ex])?.[1]}: its creator rewards go to their X Money.<br /></>}<span className="mono">CA 7xKX…cash</span></div>
          </div>
        </div>
      </section>

      <section className="stat-grid ct-stats">
        <Stat label="Cashtags launched" value={s ? s.launches.toLocaleString('en-US') : '…'} sub={s && s.queued ? `${s.queued} in the queue` : undefined} />
        <Stat label="Fees earned" value={s ? usd(s.feesUsd, true) : '…'} />
        <Stat label="Paid to creators" value={s ? sol(s.paidToCreatorsSol, 2) : '…'} />
        <Stat label="Paid to holders" value={s ? sol(s.airdroppedSol, 2) : '…'} />
      </section>

      <section className="grid-3 ct-steps">
        <div className="card"><div className="step-n">1</div><h3>Post</h3><p className="muted">Tag @{X_HANDLE} with your desired $CASHTAG and token name. Include an image to use as your token logo.</p></div>
        <div className="card"><div className="step-n">2</div><h3>Launch</h3><p className="muted">Your token goes live on Pumpfun and we reply to your post with its contract address. Launching is free.</p></div>
        <div className="card"><div className="step-n">3</div><h3>Creator rewards</h3><p className="muted"><IUsers size={13} /> By default the creator rewards are distributed to your holders. <IUser size={13} /> Sign in with X and select "Fees to me" to receive the fees yourself.</p></div>
      </section>

      <section className="two-col">
        <div>
          <SectionHead title="Newest cashtags" viewAll="/explore" />
          {tokens.loading && !tokens.data ? <Loading /> : tokens.data?.tokens.length ? (
            <div className="ct-grid">{tokens.data.tokens.map((t) => <TokenTile key={t.mint} t={t} />)}</div>
          ) : <Empty title="No cashtags yet">The first one is a post away.</Empty>}
        </div>
        <div>
          <SectionHead title="Live from X" />
          <div className="card ct-feed">
            {feed.data?.feed.length ? feed.data.feed.map((f) => (
              <div key={f.tweetId} className="ct-feed-row">
                <div className="grow">
                  <div><Ext href={f.url} className="u">{at(f.handle)}</Ext> <span className="muted">asked for</span> <span className="ct-cash">${f.symbol}</span></div>
                  <div className="muted small">{f.state === 'launched' && f.mint ? <Link to={`/t/${f.mint}`} className="u">Live</Link> : 'Queued'} · {ago(f.at)}</div>
                </div>
              </div>
            )) : <div className="muted small pad">Launch requests show up here as they arrive.</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
