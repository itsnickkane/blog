const { createPublicClient, http, decodeAbiParameters, decodeEventLog } = require('viem')
const { base } = require('viem/chains')
const { Token } = require('@uniswap/sdk-core')
const { Pool, Position, tickToPrice } = require('@uniswap/v3-sdk')

const CHAIN_ID  = 8453
const MY_ADDRESS = process.env.WALLET_ADDRESS ?? '0x9c77233BBD235a3Ed219DAA051E0a3DE5cE03C3E'

const CONTRACTS = {
  factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  nfpm:    '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const NFPM_ABI = [
  { name: 'balanceOf',           type: 'function', stateMutability: 'view',    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'tokenOfOwnerByIndex', type: 'function', stateMutability: 'view',    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'positions',           type: 'function', stateMutability: 'view',    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' }, { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' }, { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' }] },
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

const MAX_UINT128 = 2n ** 128n - 1n

// IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const INCREASE_LIQUIDITY_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'
const COLLECT_ABI = [{
  type: 'event', name: 'Collect',
  inputs: [
    { name: 'tokenId',        type: 'uint256', indexed: true },
    { name: 'recipient',      type: 'address', indexed: false },
    { name: 'amount0Collect', type: 'uint256', indexed: false },
    { name: 'amount1Collect', type: 'uint256', indexed: false },
  ],
}]

// Staked asset token addresses on Base
const STAKED_ASSETS = {
  wstETH: { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH', decimals: 18 },
  cbETH:  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH',  decimals: 18 },
}

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

// ── CoinGecko helpers ─────────────────────────────────────────────────────────
async function fetchEthPriceAt(dateStr) {
  const [y, m, d] = dateStr.split('-')
  const res  = await fetch(`https://api.coingecko.com/api/v3/coins/ethereum/history?date=${d}-${m}-${y}&localization=false`)
  const data = await res.json()
  return data.market_data?.current_price?.usd ?? null
}

// ── Registry via Alchemy transfers + tx receipt — no block-range scanning ─────
async function fetchRegistry(client, tokenId, poolAddress, t0Addr, t1Addr, t0Decimals, t1Decimals, isToken0ETH) {
  const fallback = { mintDate: '', initialToken0Raw: '0', initialToken1Raw: '0', contributions: [], totalCapitalUSD: 0 }

  // 1. Find mint block via ERC721 mint transfer (0x0 → MY_ADDRESS)
  const mintRes = await client.request({
    method: 'alchemy_getAssetTransfers',
    params: [{
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: '0x0000000000000000000000000000000000000000',
      toAddress: MY_ADDRESS,
      contractAddresses: [CONTRACTS.nfpm],
      category: ['erc721'],
    }],
  })
  const mintTx = (mintRes.transfers ?? []).find(t => t.tokenId != null && BigInt(t.tokenId) === tokenId)
  if (!mintTx) return fallback

  // 2. Find all ERC20 outflows of the position's tokens from user, starting at mint block.
  //    Each IncreaseLiquidity call pulls tokens FROM the user via transferFrom.
  const erc20Res = await client.request({
    method: 'alchemy_getAssetTransfers',
    params: [{
      fromBlock: mintTx.blockNum, toBlock: 'latest',
      fromAddress: MY_ADDRESS,
      contractAddresses: [t0Addr, t1Addr],
      category: ['erc20'],
    }],
  })

  // 3. Unique tx hashes (one tx may have two token transfers — dedupe)
  const txHashes = [...new Set((erc20Res.transfers ?? []).map(t => t.hash))]

  // 4. For each tx, check receipt for IncreaseLiquidity matching our tokenId
  const tokenIdTopic = '0x' + tokenId.toString(16).padStart(64, '0')
  const contributions = []
  let totalCapitalUSD = 0, initialToken0Raw = '0', initialToken1Raw = '0', mintDate = ''

  for (const hash of txHashes) {
    const receipt = await client.getTransactionReceipt({ hash })
    const incLog = receipt.logs.find(l =>
      l.address.toLowerCase() === CONTRACTS.nfpm.toLowerCase() &&
      l.topics[0] === INCREASE_LIQUIDITY_TOPIC &&
      l.topics[1] === tokenIdTopic
    )
    if (!incLog) continue

    // Get pool price and block timestamp for this specific deposit
    const [slot0AtBlock, block] = await Promise.all([
      client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'slot0', blockNumber: receipt.blockNumber }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
    ])

    const sqrtPrice = Number(slot0AtBlock[0]) / 2 ** 96
    const rawPrice  = sqrtPrice * sqrtPrice * 10 ** (t0Decimals - t1Decimals)
    const ethPrice  = isToken0ETH ? rawPrice : 1 / rawPrice
    const date      = new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 10)

    const [, amount0Raw, amount1Raw] = decodeAbiParameters(
      [{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }],
      incLog.data
    )
    const a0Str = amount0Raw.toString()
    const a1Str = amount1Raw.toString()
    const amount0Num = Number(amount0Raw) / 10 ** t0Decimals
    const amount1Num = Number(amount1Raw) / 10 ** t1Decimals
    const capitalUSD = isToken0ETH ? amount0Num * ethPrice + amount1Num : amount0Num + amount1Num * ethPrice

    contributions.push({ date, amount0Raw: a0Str, amount1Raw: a1Str, ethPriceUSD: ethPrice, capitalUSD })
    totalCapitalUSD += capitalUSD
    if (contributions.length === 1) { initialToken0Raw = a0Str; initialToken1Raw = a1Str; mintDate = date }
  }

  if (contributions.length === 0) return fallback
  return { mintDate, initialToken0Raw, initialToken1Raw, contributions, totalCapitalUSD }
}

// ── Harvested returns — Collect events + staked asset balances ────────────────
async function fetchHarvestedReturns(client, tokenIds, wethAddress, usdcAddress, ethPrice) {
  // 1. Find all inbound WETH/USDC transfers to my address — pool sends tokens directly to recipient
  const transfersRes = await client.request({
    method: 'alchemy_getAssetTransfers',
    params: [{
      fromBlock: '0x0', toBlock: 'latest',
      toAddress: MY_ADDRESS,
      contractAddresses: [wethAddress, usdcAddress],
      category: ['erc20'],
    }],
  })

  // 2. Find unique tx hashes and check receipts for Collect events matching our tokenIds
  const txHashes = [...new Set((transfersRes.transfers ?? []).map(t => t.hash))]
  const tokenIdSet = new Set(tokenIds.map(id => id.toString()))

  const WETH_DECIMALS = 18, USDC_DECIMALS = 6
  let totalWethCollected = 0, totalUsdcCollected = 0
  const collectEvents = []

  for (const hash of txHashes) {
    const receipt = await client.getTransactionReceipt({ hash })
    const block   = await client.getBlock({ blockNumber: receipt.blockNumber })
    const date    = new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 10)

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== CONTRACTS.nfpm.toLowerCase()) continue
      let decoded
      try { decoded = decodeEventLog({ abi: COLLECT_ABI, data: log.data, topics: log.topics }) } catch { continue }
      if (decoded.eventName !== 'Collect') continue
      if (!tokenIdSet.has(decoded.args.tokenId.toString())) continue

      const weth = Number(decoded.args.amount0Collect) / 10 ** WETH_DECIMALS
      const usdc = Number(decoded.args.amount1Collect) / 10 ** USDC_DECIMALS
      totalWethCollected += weth
      totalUsdcCollected += usdc
      collectEvents.push({ date, tokenId: decoded.args.tokenId.toString(), weth, usdc })
    }
  }

  // 3. Live staked asset balances
  const BALANCE_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }]
  const [wstEthRaw, cbEthRaw] = await Promise.all([
    client.readContract({ address: STAKED_ASSETS.wstETH.address, abi: BALANCE_ABI, functionName: 'balanceOf', args: [MY_ADDRESS] }),
    client.readContract({ address: STAKED_ASSETS.cbETH.address,  abi: BALANCE_ABI, functionName: 'balanceOf', args: [MY_ADDRESS] }),
  ])

  const wstEthBalance = Number(wstEthRaw) / 1e18
  const cbEthBalance  = Number(cbEthRaw)  / 1e18
  // wstETH trades at a premium to ETH; approximate 1 wstETH ≈ 1.2 ETH (staking yield accumulates in price)
  // cbETH similarly trades slightly above ETH
  // Use ethPrice as a conservative floor — user can see token counts and judge
  const stakedValueUSD = (wstEthBalance + cbEthBalance) * ethPrice

  const harvestedUsdcUSD = totalUsdcCollected
  const harvestedWethUSD = totalWethCollected * ethPrice
  const totalHarvestUSD  = harvestedWethUSD + harvestedUsdcUSD + stakedValueUSD

  return {
    totalWethCollected, totalUsdcCollected,
    harvestedWethUSD, harvestedUsdcUSD,
    wstEthBalance, cbEthBalance, stakedValueUSD,
    totalHarvestUSD,
    collectEvents,
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')

  try {
    const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) })

    // 1. Token IDs
    const balance  = await client.readContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'balanceOf', args: [MY_ADDRESS] })
    const indices  = Array.from({ length: Number(balance) }, (_, i) => BigInt(i))
    const tokenIds = await Promise.all(indices.map(i => client.readContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [MY_ADDRESS, i] })))

    // 2. Raw positions (filter zero liquidity)
    const rawPositions = await Promise.all(tokenIds.map(id =>
      client.readContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'positions', args: [id] })
        .then(r => ({ tokenId: id, token0: r[2], token1: r[3], fee: r[4], tickLower: r[5], tickUpper: r[6], liquidity: r[7] }))
    ))
    const active = rawPositions.filter(p => p.liquidity > 0n)

    // 3. CoinGecko vol (30d)
    let vol = null
    try {
      const cgRes  = await fetch('https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=31&interval=daily')
      const cgData = await cgRes.json()
      vol = computeVolatility(cgData.prices.map(([, p]) => p))
    } catch { /* vol optional */ }

    // 4. Token metadata cache
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

    // 5. Per-position data
    const positions = await Promise.all(active.map(async raw => {
      const [t0, t1] = await Promise.all([getToken(raw.token0), getToken(raw.token1)])

      const poolAddress  = await client.readContract({ address: CONTRACTS.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [raw.token0, raw.token1, raw.fee] })
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

      const priceLower  = parseFloat(tickToPrice(token0, token1, raw.tickLower).toSignificant(10))
      const priceUpper  = parseFloat(tickToPrice(token0, token1, raw.tickUpper).toSignificant(10))
      const price       = parseFloat(pool.token0Price.toSignificant(10))
      const inRange     = slot0[1] >= raw.tickLower && slot0[1] <= raw.tickUpper
      const isToken0ETH = t0.symbol === 'WETH'
      const principalUSD = isToken0ETH ? amount0Num * price + amount1Num : amount0Num + amount1Num * price

      // Uncollected fees via static-call
      let feesUSD = 0, fees0 = 0, fees1 = 0
      try {
        const simRes = await client.simulateContract({ address: CONTRACTS.nfpm, abi: NFPM_ABI, functionName: 'collect', args: [{ tokenId: raw.tokenId, recipient: MY_ADDRESS, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }], account: MY_ADDRESS })
        fees0   = Number(simRes.result[0]) / 10 ** t0.decimals
        fees1   = Number(simRes.result[1]) / 10 ** t1.decimals
        feesUSD = isToken0ETH ? fees0 * price + fees1 : fees0 + fees1 * price
      } catch { /* fees unavailable */ }

      const totalUSD = principalUSD + feesUSD
      const C        = concentrationMultiple(price, priceLower, priceUpper)
      const edges    = vol ? sigmaToEdge(price, priceLower, priceUpper, vol.monthlyVol) : { sigmaToLower: 0, sigmaToUpper: 0 }

      // On-chain contribution registry — Alchemy transfers + tx receipt, no getLogs
      const reg = await fetchRegistry(client, raw.tokenId, poolAddress, raw.token0, raw.token1, t0.decimals, t1.decimals, isToken0ETH)

      // IL + ROI from registry
      let ilDollar = 0, ilPct = 0, holdValueUSD = 0, netYieldUSD = 0, roiPct = 0, feeAPR = 0, daysActive = 0
      if (reg.initialToken0Raw !== '0') {
        const init0  = Number(BigInt(reg.initialToken0Raw)) / 10 ** t0.decimals
        const init1  = Number(BigInt(reg.initialToken1Raw)) / 10 ** t1.decimals
        holdValueUSD = isToken0ETH ? init0 * price + init1 : init0 + init1 * price
        ilDollar     = principalUSD - holdValueUSD
        ilPct        = ilDollar / holdValueUSD
        netYieldUSD  = feesUSD - Math.abs(ilDollar < 0 ? ilDollar : 0)
        daysActive   = (Date.now() - new Date(reg.mintDate).getTime()) / 86_400_000
        roiPct       = (principalUSD + feesUSD - reg.totalCapitalUSD) / reg.totalCapitalUSD
        feeAPR       = daysActive > 0 ? (feesUSD / reg.totalCapitalUSD) * (365 / daysActive) : 0
      }

      return {
        tokenId: raw.tokenId.toString(),
        label:   `Token ${raw.tokenId}`,
        mintDate: reg.mintDate,
        pool:    `${t0.symbol}/${t1.symbol}`,
        fee:     raw.fee / 10_000,
        poolAddress, inRange, currentPrice: price, priceLower, priceUpper,
        sym0: t0.symbol, sym1: t1.symbol,
        amount0: amount0Num, amount1: amount1Num,
        principalUSD, fees0, fees1, feesUSD, totalUSD,
        concentration: C, vol,
        sigmaToLower: edges.sigmaToLower, sigmaToUpper: edges.sigmaToUpper,
        ilDollar, ilPct, holdValueUSD, netYieldUSD,
        roiPct, feeAPR, capitalDeployed: reg.totalCapitalUSD, daysActive,
        contributions: reg.contributions,
      }
    }))

    // 6. Benchmarks — derived from all on-chain contributions across all positions
    let benchmarks = null
    try {
      const allContribs = positions
        .flatMap(p => p.contributions)
        .sort((a, b) => a.date.localeCompare(b.date))

      if (allContribs.length > 0) {
        const ethPrice = positions[0].currentPrice
        let ethHeld = 0, halfEthHeld = 0, halfUSDC = 0, totalContributed = 0
        const details = []

        for (const c of allContribs) {
          const ethBought = c.capitalUSD / c.ethPriceUSD
          ethHeld      += ethBought
          halfEthHeld  += ethBought / 2
          halfUSDC     += c.capitalUSD / 2
          totalContributed += c.capitalUSD
          details.push({ date: c.date, priceAtEntry: c.ethPriceUSD, ethBought })
        }

        benchmarks = {
          totalContributed,
          ethValueUSD:        ethHeld * ethPrice,
          ethHeld,
          fiftyFiftyValueUSD: halfEthHeld * ethPrice + halfUSDC,
          halfEthHeld,
          halfUSDC,
          details,
        }
      }
    } catch { /* benchmarks optional */ }

    // 7. Harvested returns — Collect events + staked asset balances
    let harvest = null
    try {
      const wethAddr = active.find(p => p.token0)?.token0  // token0 is always WETH in these pools
      const usdcAddr = active.find(p => p.token1)?.token1
      if (wethAddr && usdcAddr) {
        harvest = await fetchHarvestedReturns(
          client,
          positions.map(p => p.tokenId),
          wethAddr, usdcAddr,
          positions[0]?.currentPrice ?? 0
        )
      }
    } catch { /* harvest optional */ }

    res.status(200).json({ ok: true, address: MY_ADDRESS, fetchedAt: new Date().toISOString(), positions, benchmarks, harvest })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: err.message })
  }
}
