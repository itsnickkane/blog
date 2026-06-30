import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { Token } from '@uniswap/sdk-core'
import v3sdk from '@uniswap/v3-sdk'
const { Pool, Position, tickToPrice } = v3sdk

const CHAIN_ID = 8453
const MY_ADDRESS = process.env.WALLET_ADDRESS ?? '0x9c77233BBD235a3Ed219DAA051E0a3DE5cE03C3E'

const CONTRACTS = {
  factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  nfpm:    '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const NFPM_ABI = [
  { name: 'balanceOf',           type: 'function', stateMutability: 'view',    inputs: [{ name: 'owner', type: 'address' }],                                                                                                  outputs: [{ name: '', type: 'uint256' }] },
  { name: 'tokenOfOwnerByIndex', type: 'function', stateMutability: 'view',    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],                                                             outputs: [{ name: '', type: 'uint256' }] },
  { name: 'positions',           type: 'function', stateMutability: 'view',    inputs: [{ name: 'tokenId', type: 'uint256' }],                                                                                                outputs: [{ name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' }, { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' }, { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' }] },
  { name: 'collect',             type: 'function', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' }] }], outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
]

const FACTORY_ABI = [
  { name: 'getPool', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }], outputs: [{ name: 'pool', type: 'address' }] },
]

const POOL_ABI = [
  { name: 'slot0',     type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' }, { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' }, { name: 'unlocked', type: 'bool' }] },
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
]

const ERC20_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
]

// ── Metrics ───────────────────────────────────────────────────────────────────
function computeVolatility(closes) {
  const window = closes.slice(-31)
  const returns = []
  for (let i = 1; i < window.length; i++) returns.push(Math.log(window[i] / window[i - 1]))
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  const dailyVol = Math.sqrt(variance)
  return { dailyVol, monthlyVol: dailyVol * Math.sqrt(30), annualVol: dailyVol * Math.sqrt(365) }
}

function concentrationMultiple(P, Pa, Pb) {
  return (2 * Math.sqrt(P)) / (2 * Math.sqrt(P) - Math.sqrt(Pa) - P / Math.sqrt(Pb))
}

function sigmaToEdge(P, Pa, Pb, monthlyVol) {
  return { sigmaToLower: Math.log(P / Pa) / monthlyVol, sigmaToUpper: Math.log(Pb / P) / monthlyVol }
}

// ── Seed data ─────────────────────────────────────────────────────────────────
const POSITION_CONFIG = {
  5238157: { label: 'Legacy inner', deployDate: '2026-06-02', capitalUSD: 1000, initialToken0: '436000000000000000', initialToken1: '202680000' },
}

const CONTRIBUTIONS = [{ date: '2026-06-02', amountUSD: 1000 }]
const MAX_UINT128 = 2n ** 128n - 1n

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')

  try {
    const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) })

    // 1. Token IDs
    const balance = await client.readContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'balanceOf', args: [MY_ADDRESS] })
    const indices  = Array.from({ length: Number(balance) }, (_, i) => BigInt(i))
    const tokenIds = await Promise.all(indices.map(i => client.readContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [MY_ADDRESS, i] })))

    // 2. Raw positions (filter zero liquidity)
    const rawPositions = await Promise.all(tokenIds.map(id => client.readContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'positions', args: [id] }).then(r => ({ tokenId: id, token0: r[2], token1: r[3], fee: r[4], tickLower: r[5], tickUpper: r[6], liquidity: r[7] }))))
    const active = rawPositions.filter(p => p.liquidity > 0n)

    // 3. CoinGecko vol (30d)
    let vol = null
    try {
      const cgRes  = await fetch(`https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=31&interval=daily`)
      const cgData = await cgRes.json()
      const closes = cgData.prices.map(([, p]) => p)
      vol = computeVolatility(closes)
    } catch { /* vol optional */ }

    // 4. Per-position data
    const tokenMeta = {}
    async function getToken(address) {
      if (tokenMeta[address]) return tokenMeta[address]
      const [decimals, symbol] = await Promise.all([
        client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
        client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
      ])
      tokenMeta[address] = { address, decimals, symbol }
      return tokenMeta[address]
    }

    const positions = await Promise.all(active.map(async raw => {
      const [t0, t1] = await Promise.all([getToken(raw.token0), getToken(raw.token1)])

      const poolAddress = await client.readContract({ address: CONTRACTS.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [raw.token0, raw.token1, raw.fee] })
      const [slot0, poolLiq] = await Promise.all([
        client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'slot0' }),
        client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'liquidity' }),
      ])

      const token0 = new Token(CHAIN_ID, raw.token0, t0.decimals, t0.symbol)
      const token1 = new Token(CHAIN_ID, raw.token1, t1.decimals, t1.symbol)
      const pool   = new Pool(token0, token1, raw.fee, slot0[0].toString(), poolLiq.toString(), slot0[1])

      const position   = new Position({ pool, liquidity: raw.liquidity.toString(), tickLower: raw.tickLower, tickUpper: raw.tickUpper })
      const amount0Num = parseFloat(position.amount0.toSignificant(8))
      const amount1Num = parseFloat(position.amount1.toSignificant(8))

      const priceLower = parseFloat(tickToPrice(token0, token1, raw.tickLower).toSignificant(10))
      const priceUpper = parseFloat(tickToPrice(token0, token1, raw.tickUpper).toSignificant(10))
      const price      = parseFloat(pool.token0Price.toSignificant(10))
      const inRange    = slot0[1] >= raw.tickLower && slot0[1] <= raw.tickUpper
      const isToken0ETH = t0.symbol === 'WETH'
      const principalUSD = isToken0ETH ? amount0Num * price + amount1Num : amount0Num + amount1Num * price

      // Uncollected fees via static-call
      let feesUSD = 0, fees0 = 0, fees1 = 0
      try {
        const simRes = await client.simulateContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'collect', args: [{ tokenId: raw.tokenId, recipient: MY_ADDRESS, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }], account: MY_ADDRESS })
        fees0 = Number(simRes.result[0]) / 10 ** t0.decimals
        fees1 = Number(simRes.result[1]) / 10 ** t1.decimals
        feesUSD = isToken0ETH ? fees0 * price + fees1 : fees0 + fees1 * price
      } catch { /* fees unavailable */ }

      const totalUSD = principalUSD + feesUSD
      const C = concentrationMultiple(price, priceLower, priceUpper)
      const edges = vol ? sigmaToEdge(price, priceLower, priceUpper, vol.monthlyVol) : { sigmaToLower: 0, sigmaToUpper: 0 }
      const cfg = POSITION_CONFIG[Number(raw.tokenId)]

      // IL + ROI
      let ilDollar = 0, ilPct = 0, holdValueUSD = 0, netYieldUSD = 0, roiPct = 0, feeAPR = 0, daysActive = 0
      if (cfg) {
        const init0 = Number(BigInt(cfg.initialToken0)) / 10 ** t0.decimals
        const init1 = Number(BigInt(cfg.initialToken1)) / 10 ** t1.decimals
        holdValueUSD = isToken0ETH ? init0 * price + init1 : init0 + init1 * price
        ilDollar     = principalUSD - holdValueUSD
        ilPct        = ilDollar / holdValueUSD
        netYieldUSD  = feesUSD - Math.abs(ilDollar < 0 ? ilDollar : 0)
        daysActive   = (Date.now() - new Date(cfg.deployDate).getTime()) / 86_400_000
        roiPct       = (principalUSD + feesUSD - cfg.capitalUSD) / cfg.capitalUSD
        feeAPR       = daysActive > 0 ? (feesUSD / cfg.capitalUSD) * (365 / daysActive) : 0
      }

      return {
        tokenId:        raw.tokenId.toString(),
        label:          cfg?.label ?? `Token ${raw.tokenId}`,
        pool:           `${t0.symbol}/${t1.symbol}`,
        fee:            raw.fee / 10_000,
        poolAddress,
        inRange,
        currentPrice:   price,
        priceLower,
        priceUpper,
        tickLower:      raw.tickLower,
        tickUpper:      raw.tickUpper,
        currentTick:    slot0[1],
        sym0:           t0.symbol,
        sym1:           t1.symbol,
        amount0:        amount0Num,
        amount1:        amount1Num,
        principalUSD,
        fees0,
        fees1,
        feesUSD,
        totalUSD,
        concentration:  C,
        vol,
        sigmaToLower:   edges.sigmaToLower,
        sigmaToUpper:   edges.sigmaToUpper,
        ilDollar,
        ilPct,
        holdValueUSD,
        netYieldUSD,
        roiPct,
        feeAPR,
        capitalDeployed: cfg?.capitalUSD ?? 0,
        daysActive,
      }
    }))

    // 5. Benchmarks
    let benchmarks = null
    if (positions.length > 0 && CONTRIBUTIONS.length > 0) {
      try {
        const ethPrice = positions[0].currentPrice
        let stEthEth = 0, halfStEthEth = 0, halfUSDC = 0, totalContributed = 0
        const details = []
        for (const c of CONTRIBUTIONS) {
          const [y, m, d]  = c.date.split('-')
          const cgHist     = await fetch(`https://api.coingecko.com/api/v3/coins/ethereum/history?date=${d}-${m}-${y}&localization=false`)
          const histData   = await cgHist.json()
          const priceAt    = histData.market_data?.current_price?.usd ?? ethPrice
          const years      = (Date.now() - new Date(c.date).getTime()) / (365 * 86_400_000)
          const ethBought  = c.amountUSD / priceAt
          const withYield  = ethBought * Math.pow(1.03, years)
          stEthEth     += withYield
          halfStEthEth += (ethBought / 2) * Math.pow(1.03, years)
          halfUSDC     += c.amountUSD / 2
          totalContributed += c.amountUSD
          details.push({ date: c.date, priceAtEntry: priceAt, ethBought })
        }
        benchmarks = {
          totalContributed,
          stEthValueUSD:      stEthEth * ethPrice,
          stEthEth,
          fiftyFiftyValueUSD: halfStEthEth * ethPrice + halfUSDC,
          halfStEthEth,
          halfUSDC,
          details,
        }
      } catch { /* benchmarks optional */ }
    }

    res.status(200).json({ ok: true, address: MY_ADDRESS, fetchedAt: new Date().toISOString(), positions, benchmarks })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: err.message })
  }
}
