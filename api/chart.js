'use strict'

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const days = req.query.days ?? '1'

  try {
    const url = `https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=${days}&precision=2`
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      }
    })
    if (!r.ok) {
      const text = await r.text()
      return res.status(r.status).json({ ok: false, error: `CoinGecko ${r.status}: ${text.slice(0, 200)}` })
    }
    const data = await r.json()
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300')
    return res.status(200).json({ ok: true, prices: data.prices, total_volumes: data.total_volumes })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
}
