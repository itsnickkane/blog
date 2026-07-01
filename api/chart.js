'use strict'

// Kraken supported intervals in minutes: 1,5,15,30,60,240,1440,10080,21600
function krakenParams(days) {
  if (days === 'max') return { interval: 21600 } // 15-day candles, no since = full history
  const n = Number(days)
  const since = Math.floor(Date.now() / 1000) - n * 86400
  if (n <= 1)    return { interval: 60,    since }
  if (n <= 7)    return { interval: 240,   since }
  if (n <= 365)  return { interval: 1440,  since }
  return             { interval: 10080,  since } // weekly for 2Y-5Y
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const days = req.query.days ?? '1'
  const { interval, since } = krakenParams(days)

  try {
    const url = `https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=${interval}${since ? `&since=${since}` : ''}`
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (!r.ok) {
      const text = await r.text()
      return res.status(r.status).json({ ok: false, error: `Kraken ${r.status}: ${text.slice(0, 200)}` })
    }
    const json = await r.json()
    if (json.error?.length) return res.status(400).json({ ok: false, error: json.error.join(', ') })

    // Kraken OHLC: [time(s), open, high, low, close, vwap, volume, count]
    const candles = json.result?.XETHZUSD ?? json.result?.ETHUSD ?? Object.values(json.result ?? {})[0] ?? []
    const prices        = candles.map(k => [k[0] * 1000, parseFloat(k[4])])  // close, ms timestamp
    const total_volumes = candles.map(k => [k[0] * 1000, parseFloat(k[4]) * parseFloat(k[6])])  // price * volume = USD vol

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300')
    return res.status(200).json({ ok: true, prices, total_volumes })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
}
