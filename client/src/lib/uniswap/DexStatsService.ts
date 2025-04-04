import { ethers } from 'ethers';
import { Token } from '@uniswap/sdk-core';
import { Pool } from '@uniswap/v3-sdk';
import { WETH, WBTC, USDC, USDT, providers } from './AlphaRouterService';
import { CHAIN_IDS, getContractsForChain } from '@/lib/constants';

// Local storage key for the selected chain
const SELECTED_CHAIN_KEY = 'selectedChainId';

// Get the saved chain ID from local storage or use the default
const getSavedChainId = (): number => {
  try {
    const savedChainId = localStorage.getItem(SELECTED_CHAIN_KEY);
    if (savedChainId) {
      const chainId = parseInt(savedChainId);
      return chainId;
    }
  } catch (error) {
    console.error('Error reading from localStorage:', error);
  }
  return parseInt(import.meta.env.VITE_CHAIN_ID); // Default to env chain ID if no saved chain or error
};

const DEFAULT_CHAIN_ID = getSavedChainId();
const POOL_FEES = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

// Use the current provider from AlphaRouterService
let currentProvider = providers[DEFAULT_CHAIN_ID] || providers[CHAIN_IDS.ABC_TESTNET];
let currentContracts = getContractsForChain(DEFAULT_CHAIN_ID);

// Function to update the current provider
export const updateDexStatsProvider = (chainId: number) => {
  if (providers[chainId]) {
    currentProvider = providers[chainId];
    currentContracts = getContractsForChain(chainId);
    console.log(`DexStatsService: Switched to chain ID ${chainId}`);
  } else {
    console.error(`DexStatsService: No provider available for chain ID ${chainId}`);
  }
};

interface PoolData {
  address: string;
  token0: Token;
  token1: Token;
  fee: number;
  liquidity: string;
  sqrtPriceX96: string;
  tick: number;
  volume24h: string;
  tvl: string;
}

interface UserStats {
  totalTrades: number;
  totalVolume: string;
  profitLoss: string;
}

interface DexStats {
  totalValueLocked: string;
  volume24h: string;
  totalPools: number;
  pools: PoolData[];
  userStats?: UserStats;
}

class DexStatsService {
  private provider: ethers.providers.Provider;
  private cache: {
    stats: DexStats | null;
    lastUpdate: number;
  } = {
      stats: null,
      lastUpdate: 0
    };

  private CACHE_DURATION = 30000; // 30 seconds

  constructor() {
    this.provider = currentProvider;
  }

  async getStats(userAddress?: string): Promise<DexStats> {
    // Check if we have cached stats that are still valid
    const now = Date.now();
    if (this.cache.stats && now - this.cache.lastUpdate < this.CACHE_DURATION) {
      // If user stats are requested and we have them cached, return the cached stats
      if (!userAddress || (this.cache.stats.userStats && userAddress)) {
        return this.cache.stats;
      }
    }

    // Update the provider to ensure we're using the current one
    this.provider = currentProvider;

    try {
      // Get all pools
      const factoryContract = new ethers.Contract(
        currentContracts.UNISWAP_FACTORY,
        [
          'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
          'function allPairsLength() external view returns (uint)'
        ],
        this.provider
      );

      const tokens = [WETH, WBTC, USDC, USDT];
      const pools: PoolData[] = [];
      let totalTVL = ethers.BigNumber.from(0);
      let totalVolume = ethers.BigNumber.from(0);

      // Batch all pool address queries
      const poolQueries = [];
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          for (const fee of POOL_FEES) {
            poolQueries.push(
              factoryContract.getPool(tokens[i].address, tokens[j].address, fee)
                .then(async (poolAddress: string) => {
                  if (poolAddress === ethers.constants.AddressZero) return null;
                  return {
                    address: poolAddress,
                    token0: tokens[i],
                    token1: tokens[j],
                    fee
                  };
                })
                .catch(() => null)
            );
          }
        }
      }

      // Execute all pool queries in parallel
      const poolResults = await Promise.all(poolQueries);
      const validPools = poolResults.filter(pool => pool !== null);

      // Batch all pool data queries
      const poolDataQueries = validPools.map(async (pool) => {
        if (!pool) return null;

        const poolContract = new ethers.Contract(
          pool.address,
          [
            'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
            'function liquidity() external view returns (uint128)',
            'function observe(uint32[] secondsAgos) external view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
          ],
          this.provider
        );

        try {
          // First try to get slot0 and liquidity data
          const [slot0, liquidity] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
          ]);

          let volume = ethers.BigNumber.from(0);
          let observations;

          // Try to get historical data with error handling
          try {
            // Try with a shorter time window first (1 hour)
            observations = await poolContract.observe([0, 3600]);

            // Calculate volume based on 1-hour data and extrapolate to 24h
            const tickChange = Math.abs(observations.tickCumulatives[1].sub(observations.tickCumulatives[0]).toNumber());
            volume = liquidity.mul(tickChange).div(1e6).mul(24);
          } catch (observeError) {
            console.warn(`Could not fetch historical data for pool ${pool.address}:`, observeError);

            // Fallback: estimate volume based on liquidity and current tick
            // This is a rough approximation assuming 5% of liquidity is traded daily
            volume = liquidity.mul(5).div(100);
          }

          const tvl = ethers.utils.formatEther(liquidity);
          totalTVL = totalTVL.add(liquidity);
          totalVolume = totalVolume.add(volume);

          return {
            ...pool,
            liquidity: liquidity.toString(),
            sqrtPriceX96: slot0.sqrtPriceX96.toString(),
            tick: slot0.tick,
            volume24h: ethers.utils.formatEther(volume),
            tvl,
          };
        } catch (error) {
          console.error(`Error fetching data for pool ${pool.address}:`, error);
          return null;
        }
      });

      const poolDataResults = (await Promise.all(poolDataQueries)).filter(Boolean) as PoolData[];

      const stats: DexStats = {
        totalValueLocked: ethers.utils.formatEther(totalTVL),
        volume24h: ethers.utils.formatEther(totalVolume),
        totalPools: poolDataResults.length,
        pools: poolDataResults,
      };

      // Update cache
      this.cache = {
        stats,
        lastUpdate: now
      };

      // Add user stats if address provided
      if (userAddress) {
        stats.userStats = await this.getUserStats(userAddress);
      }

      return stats;
    } catch (error) {
      console.error('Error fetching DEX stats:', error);
      return {
        totalValueLocked: '0',
        volume24h: '0',
        totalPools: 0,
        pools: []
      };
    }
  }

  private async getUserStats(address: string): Promise<UserStats> {
    try {
      // Get user's trading history from events
      const swapInterface = new ethers.utils.Interface([
        'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
      ]);

      const filter = {
        topics: [
          swapInterface.getEventTopic('Swap'),
          null,
          ethers.utils.hexZeroPad(address, 32)
        ],
        fromBlock: -7200, // Last ~24 hours of blocks
        toBlock: 'latest'
      };

      const logs = await this.provider.getLogs(filter);
      const trades = logs.map(log => swapInterface.parseLog(log));

      let totalVolume = ethers.BigNumber.from(0);
      let profitLoss = ethers.BigNumber.from(0);

      trades.forEach(trade => {
        const amount0 = ethers.BigNumber.from(trade.args.amount0);
        const amount1 = ethers.BigNumber.from(trade.args.amount1);

        // Add absolute values to total volume
        totalVolume = totalVolume.add(amount0.abs()).add(amount1.abs());

        // Simple P&L calculation (can be improved)
        profitLoss = profitLoss.add(amount1).sub(amount0);
      });

      return {
        totalTrades: trades.length,
        totalVolume: ethers.utils.formatEther(totalVolume),
        profitLoss: ethers.utils.formatEther(profitLoss)
      };
    } catch (error) {
      console.error('Error fetching user stats:', error);
      return {
        totalTrades: 0,
        totalVolume: '0',
        profitLoss: '0'
      };
    }
  }
}

// Export a singleton instance
export const dexStatsService = new DexStatsService();

// Initialize with the saved chain ID
updateDexStatsProvider(DEFAULT_CHAIN_ID); 