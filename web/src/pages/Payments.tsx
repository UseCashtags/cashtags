import { useState } from 'react'
import { IExternal } from '../components/Icons'
import { Avatar, Chip, Empty, ErrorNote, Ext, Link, Loading, Pager, SOLSCAN, SafeImg, SectionHead, Stat } from '../components/ui'
import { api, type Payment, type PaymentKind } from '../lib/api'
import { ago, dateTime, short, usd } from '../lib/format'
import { amt, at, sol } from '../lib/site'
import { useData } from '../lib/useData'

const PER = 30
const KINDS: { kind: PaymentKind; label: string }[] = [
  { kind: 'all', label: 'All' }, { kind: 'creators', label: 'To creators' }, { kind: 'holders', label: 'To holders' }, { kind: 'xmoney', label: 'X Money' },
]

/** Every payment Cashtags has sent: creator payouts, holder airdrops and X Money sends, each with its transaction. */
export function Payments() {
  const [kind, setKind] = useState<PaymentKind>('all')
  const [page, setPage] = useState(0)
  const list = useData(() => api.payments(kind, PER, page * PER), [kind, page], 30_000)
  const top = useData(() => api.topPaid(), [], 60_000)
  const t = list.data?.totals
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PER))
  return (
    <div className="page">
      <section className="card ct-pay-hero">
        <div className="muted small">Paid out in creator rewards</div>
        <div className="huge-num">{t ? sol(t.allSol, 2) : '…'}</div>
        <div className="stat-grid three">
          <Stat label="Paid to creators" value={t ? sol(t.creatorsSol, 2) : '…'} />
          <Stat label="Paid to holders" value={t ? sol(t.holdersSol + t.pumpHoldersSol, 2) : '…'} />
          <Stat label="Paid on X Money" value={t ? sol(t.xmoneySol, 2) : '…'} />
        </div>
      </section>

      <section className="two-col">
        <div>
          <SectionHead title="Recent payments"><Pager page={page} pages={pages} onPage={setPage} /></SectionHead>
          <div className="chips">{KINDS.map((k) => <Chip key={k.kind} active={kind === k.kind} onClick={() => { setKind(k.kind); setPage(0) }}>{k.label}</Chip>)}</div>
          {list.error && <ErrorNote error={list.error} />}
          {list.loading && !list.data ? <Loading /> : list.data?.items.length ? (
            <div className="stack">{list.data.items.map((p) => <PaymentRow key={`${p.signature}:${p.mint}:${p.kind}`} p={p} />)}</div>
          ) : <Empty title="No payments here yet">Payments show up here as soon as they are sent.</Empty>}
        </div>
        <div>
          <SectionHead title="Top paid creators" />
          {top.data?.items.length ? (
            <div className="stack">
              {top.data.items.slice(0, 10).map((r) => (
                <Link key={r.creator.id} to={`/x/${r.creator.handle}`} className="card most-row">
                  <Avatar src={r.creator.avatar} label={r.creator.handle} size={36} />
                  <span className="grow">{at(r.creator.handle)}<br /><span className="muted small">{r.payments} {r.payments === 1 ? 'payment' : 'payments'}{r.owedSol >= 0.0001 ? ` · ${sol(r.owedSol)} waiting` : ''}</span></span>
                  <b>{sol(r.paidSol, 2)}</b>
                </Link>
              ))}
            </div>
          ) : <Empty title="No creators paid yet" />}
        </div>
      </section>
    </div>
  )
}

function PaymentRow({ p }: { p: Payment }) {
  const what = p.kind === 'airdrop' ? `airdropped to ${p.recipients ?? 0} ${p.recipients === 1 ? 'holder' : 'holders'}`
    : p.xmoney ? `to @${p.handle}'s X Money`
    : <>to <Link to={`/x/${p.handle}`} className="u">{at(p.handle)}</Link>{p.destination ? <span className="mono"> · {short(p.destination, 4, 4)}</span> : null}</>
  return (
    <div className="row ct-pay-row">
      <div className="row-main">
        <Link to={`/t/${p.token.mint}`}><SafeImg src={p.token.image} label={p.token.symbol} size={40} radius={10} /></Link>
        <div>
          <div className="amount sm">{amt(p.amount, p.unit)}{p.usd != null && p.usd > 0 ? <span className="muted small"> · {usd(p.usd)}</span> : null}</div>
          <div className="muted small"><Link to={`/t/${p.token.mint}`} className="u">${p.token.symbol}</Link> {what}</div>
        </div>
      </div>
      <div className="row-side muted small">
        <span className="ct-pay-kind">{p.kind === 'airdrop' ? 'Holders' : p.xmoney ? 'X Money' : 'Creator'}</span>
        <span title={dateTime(p.time)}>{ago(p.time)}</span>
        <Ext href={SOLSCAN('tx', p.signature)} className="tx">tx <IExternal /></Ext>
      </div>
    </div>
  )
}
