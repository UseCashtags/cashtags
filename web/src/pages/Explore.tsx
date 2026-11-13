import { useEffect, useState } from 'react'
import { IX } from '../components/Icons'
import { Chip, Empty, ErrorNote, Loading, SectionHead, TokenTile } from '../components/ui'
import { api } from '../lib/api'
import { useData } from '../lib/useData'

const PER = 24
type Sort = 'new' | 'top' | 'xmoney'
const SORT_LABEL: Record<Sort, string> = { new: 'Newest', top: 'Market cap', xmoney: 'X Money' }

export function Explore() {
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? '')
  useEffect(() => {
    const on = () => setQ(new URLSearchParams(location.search).get('q') ?? '')
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return (
    <div className="page">
      <div className="page-head ct-centered">
        <h1>Explore</h1>
        <p className="muted">Every token launched with Cashtags, from X or on the site.{q && <> Showing results for <span className="hl">{q}</span>.</>}</p>
      </div>
      <form onSubmit={(e) => e.preventDefault()}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a $CASHTAG, name, @handle or address" aria-label="Search coins" />
      </form>
      <Board title="Graduated" sorts={['top', 'new', 'xmoney']} graduated q={q} empty="Tokens show up here once they complete their curve." />
      <Board title="On the curve" sorts={['new', 'top', 'xmoney']} graduated={false} q={q} empty="New tokens show up here the moment they launch." />
    </div>
  )
}

/** One board: its own sort switch and grid. The first sort listed is the default. */
function Board({ title, sorts, graduated, q, empty }: { title: string; sorts: Sort[]; graduated: boolean; q: string; empty: string }) {
  const [sort, setSort] = useState<Sort>(sorts[0]!)
  const [count, setCount] = useState(PER)
  useEffect(() => { setCount(PER) }, [q])
  const d = useData(() => api.tokens(sort, q, count, 0, graduated), [sort, q, count, graduated], 30_000)
  return (
    <section className="ct-board">
      <SectionHead title={<>{title}{d.data && <span className="ct-board-count">{d.data.total.toLocaleString('en-US')}</span>}</>}>
        <span className="seg">{sorts.map((s) => <Chip key={s} active={sort === s} onClick={() => { setSort(s); setCount(PER) }}>{s === 'xmoney' && <IX size={11} />} {SORT_LABEL[s]}</Chip>)}</span>
      </SectionHead>
      {d.error && <ErrorNote error={d.error} />}
      {d.loading && !d.data ? <Loading /> : d.data?.tokens.length ? (
        <div className="ct-grid wide">{d.data.tokens.map((t) => <TokenTile key={t.mint} t={t} />)}</div>
      ) : <Empty title={q ? 'Nothing matches here' : sort === 'xmoney' ? 'No X Money launches here yet' : graduated ? 'No graduated tokens yet' : 'No tokens on the curve'}>{q ? 'Try a ticker, a handle or a full address.' : sort === 'xmoney' ? 'Tokens launched for an X account, with the fees paid to their X Money, show up here.' : empty}</Empty>}
      {d.data && d.data.total > d.data.tokens.length && (
        <div className="center"><button type="button" className="btn ghost" onClick={() => setCount((c) => c + PER)}>Show more</button></div>
      )}
    </section>
  )
}
