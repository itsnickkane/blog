'use strict'

// Map our period keys to Binance interval + limit
function binanceParams(days) {
  if (days === 'max') return { interval: '1M', limit: 120 }
  const n = Number(days)
  if (n <= 1)    return { interval: '1h',  limit: 24  }
  if (n <= 7)    return { interval: '4h',  limit: 42  }
  if (n <= 30)   return { interval: '1d',  limit: 30  }
  if (n <= 90)   return { interval: '1d',  limit: 90  }
  if (n <= 180)  return { interval: '1d',  limit: 180 }
  if (n <= 365)  return { interval: '1w',  limit: 53  }
  if (n <= 730)  return { interval: '1w',  limit: 105 }
  if (n <= 1095) return { interval: '1w',  limit: 157 }
  if (n <= 1460) return { interval: '1w',  limit: 209 }
  if (n <= 1825) return { interval: '1w',  limit: 261 }
  return { interval: '1M', limit: 120 }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const days = req.query.days ?? '1'
  const { interval, limit } = binanceParams(days)

  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=${interval}&limit=${limit}`
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (!r.ok) {
      const text = await r.text()
      return res.status(r.status).json({ ok: false, error: `Binance ${r.status}: ${text.slice(0, 200)}` })
    }
    const klines = await r.json()
    // Kline: [openTime, open, high, low, close, baseVol, closeTime, quoteVol, ...]
    // Return in CoinGecko-compatible shape so client code is unchanged
    const prices        = klines.map(k => [k[0], parseFloat(k[4])])   // close price
    const total_volumes = klines.map(k => [k[0], parseFloat(k[7])])   // quote asset volume (USDT)
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300')
    return res.status(200).json({ ok: true, prices, total_volumes })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
}
