import { createContext } from 'preact'
import type { ComponentChildren } from 'preact'
import { useContext } from 'preact/hooks'
import { useEffect, useState } from 'preact/hooks'
import { DEFAULT_ABI_API_URL, syncUploadedAbis } from '../lib/abi-api.ts'
import {
  getChainMeta,
  getExplorerStats,
  resetExplorerData,
  resetExplorerDataIncludingAbis,
  setActiveChainScope,
} from '../lib/db.ts'
import { createLogger } from '../lib/logger.ts'
import {
  createAnvilClient,
  createSnapshot,
  getTrace,
  mineBlocks,
  revertSnapshot,
  setBalance,
} from '../lib/rpc.ts'
import { syncChain, type SyncProgress } from '../lib/sync.ts'
import type { ChainMeta, ExplorerEndpoint, ExplorerStats, ExplorerStatus } from '../lib/types.ts'

type ExplorerContextValue = {
  activeEndpointId: string
  endpoints: ExplorerEndpoint[]
  chainMeta: ChainMeta | null
  abiApiUrl: string
  error: string | null
  refreshKey: number
  rpcUrl: string
  startBlock: number | null
  setActiveEndpointId: (value: string) => Promise<void>
  setAbiApiUrl: (value: string) => void
  setRpcUrl: (value: string) => void
  setStartBlock: (value: number | null) => void
  saveEndpoint: (input: { id?: string; name: string; rpcUrl: string; startBlock: number | null }) => Promise<string>
  deleteEndpoint: (id: string) => Promise<void>
  snapshots: string[]
  status: ExplorerStatus
  stats: ExplorerStats
  statusMessage: string
  actions: {
    reconnect: () => void
    refresh: () => void
    resetChainData: () => Promise<void>
    resetData: () => Promise<void>
    loadTrace: (txHash: `0x${string}`) => Promise<unknown>
    mineBlocks: (count: number) => Promise<void>
    setBalance: (address: string, amountEth: string) => Promise<void>
    createSnapshot: () => Promise<string>
    revertSnapshot: (snapshotId: string) => Promise<boolean>
  }
}

const ENDPOINTS_STORAGE_KEY = 'anvil-explorer.endpoints'
const ACTIVE_ENDPOINT_STORAGE_KEY = 'anvil-explorer.active-endpoint-id'
const LEGACY_RPC_STORAGE_KEY = 'anvil-explorer.rpc-url'
const ABI_API_STORAGE_KEY = 'anvil-explorer.abi-api-url'
const LEGACY_START_BLOCK_STORAGE_KEY = 'anvil-explorer.start-block'
const DEFAULT_URL = 'http://127.0.0.1:8545'
const DEFAULT_ENDPOINT_ID = 'local-default'
const EMPTY_STATS: ExplorerStats = {
  blockCount: 0,
  transactionCount: 0,
  logCount: 0,
  latestBlockNumber: null,
}

const logger = createLogger('app')

const ExplorerContext = createContext<ExplorerContextValue | null>(null)

function parseStoredStartBlock(value: string | null) {
  if (value === null) {
    return null
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function createDefaultEndpoint(): ExplorerEndpoint {
  return {
    id: DEFAULT_ENDPOINT_ID,
    name: 'Local Anvil',
    rpcUrl: DEFAULT_URL,
    startBlock: null,
  }
}

function createEndpointScopeKey(endpoint: ExplorerEndpoint) {
  return `${endpoint.id}::${endpoint.rpcUrl.trim().toLowerCase()}`
}

function readInitialEndpoints() {
  const fallback = [createDefaultEndpoint()]
  const stored = window.localStorage.getItem(ENDPOINTS_STORAGE_KEY)

  if (stored) {
    try {
      const parsed = JSON.parse(stored)

      if (!Array.isArray(parsed)) {
        return fallback
      }

      const endpoints = parsed
        .map((item, index) => {
          if (!item || typeof item !== 'object') {
            return null
          }

          const rpcUrl = typeof item.rpcUrl === 'string' ? item.rpcUrl.trim() : ''

          if (!rpcUrl) {
            return null
          }

          const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Endpoint ${index + 1}`
          const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `endpoint-${index + 1}`
          const startBlock =
            typeof item.startBlock === 'number' && Number.isFinite(item.startBlock) && item.startBlock >= 0
              ? item.startBlock
              : null

          return {
            id,
            name,
            rpcUrl,
            startBlock,
          } satisfies ExplorerEndpoint
        })
        .filter((item): item is ExplorerEndpoint => item !== null)

      return endpoints.length > 0 ? endpoints : fallback
    } catch {
      return fallback
    }
  }

  const legacyRpcUrl = window.localStorage.getItem(LEGACY_RPC_STORAGE_KEY)?.trim() ?? ''
  const legacyStartBlock = parseStoredStartBlock(window.localStorage.getItem(LEGACY_START_BLOCK_STORAGE_KEY))

  if (!legacyRpcUrl) {
    return fallback
  }

  return [
    {
      id: DEFAULT_ENDPOINT_ID,
      name: legacyRpcUrl === DEFAULT_URL ? 'Local Anvil' : 'Primary Endpoint',
      rpcUrl: legacyRpcUrl,
      startBlock: legacyStartBlock,
    },
  ]
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function areStatsEqual(left: ExplorerStats, right: ExplorerStats) {
  return (
    left.blockCount === right.blockCount &&
    left.transactionCount === right.transactionCount &&
    left.logCount === right.logCount &&
    left.latestBlockNumber === right.latestBlockNumber
  )
}

function areChainMetaEqual(left: ChainMeta | null, right: ChainMeta | null) {
  if (left === right) {
    return true
  }

  if (!left || !right) {
    return false
  }

  return (
    left.chainId === right.chainId &&
    left.clientVersion === right.clientVersion &&
    left.latestBlockNumber === right.latestBlockNumber &&
    left.latestIndexedBlock === right.latestIndexedBlock &&
    left.latestIndexedHash === right.latestIndexedHash &&
    left.rpcUrl === right.rpcUrl &&
    left.forkConfig?.forkBlockNumber === right.forkConfig?.forkBlockNumber
  )
}

export function ExplorerProvider(props: { children: ComponentChildren }) {
  const [storedInitialEndpoints] = useState<ExplorerEndpoint[]>(readInitialEndpoints)
  const [endpoints, setEndpoints] = useState<ExplorerEndpoint[]>(storedInitialEndpoints)
  const [activeEndpointId, setActiveEndpointIdState] = useState(() => {
    const stored = window.localStorage.getItem(ACTIVE_ENDPOINT_STORAGE_KEY)
    return stored && storedInitialEndpoints.some((endpoint) => endpoint.id === stored)
      ? stored
      : storedInitialEndpoints[0].id
  })
  const [abiApiUrl, setAbiApiUrl] = useState(
    () => window.localStorage.getItem(ABI_API_STORAGE_KEY) ?? DEFAULT_ABI_API_URL,
  )
  const [status, setStatus] = useState<ExplorerStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('Waiting to connect')
  const [error, setError] = useState<string | null>(null)
  const [chainMeta, setChainMeta] = useState<ChainMeta | null>(null)
  const [stats, setStats] = useState<ExplorerStats>(EMPTY_STATS)
  const [refreshKey, setRefreshKey] = useState(0)
  const [snapshots, setSnapshots] = useState<string[]>([])
  const [connectionVersion, setConnectionVersion] = useState(0)
  const activeEndpoint = endpoints.find((endpoint) => endpoint.id === activeEndpointId) ?? endpoints[0] ?? createDefaultEndpoint()
  const rpcUrl = activeEndpoint.rpcUrl
  const startBlock = activeEndpoint.startBlock
  const activeScopeKey = createEndpointScopeKey(activeEndpoint)

  setActiveChainScope(activeScopeKey)

  useEffect(() => {
    window.localStorage.setItem(ENDPOINTS_STORAGE_KEY, JSON.stringify(endpoints))
    window.localStorage.removeItem(LEGACY_RPC_STORAGE_KEY)
    window.localStorage.removeItem(LEGACY_START_BLOCK_STORAGE_KEY)
  }, [endpoints])

  useEffect(() => {
    const hasActiveEndpoint = endpoints.some((endpoint) => endpoint.id === activeEndpointId)

    if (hasActiveEndpoint) {
      window.localStorage.setItem(ACTIVE_ENDPOINT_STORAGE_KEY, activeEndpointId)
      return
    }

    const fallbackId = endpoints[0]?.id ?? createDefaultEndpoint().id
    setActiveEndpointIdState(fallbackId)
  }, [activeEndpointId, endpoints])

  useEffect(() => {
    window.localStorage.setItem(ABI_API_STORAGE_KEY, abiApiUrl)
  }, [abiApiUrl])

  function resetConnectionState() {
    setSnapshots([])
    setChainMeta(null)
    setStats(EMPTY_STATS)
    setError(null)
    setStatus('idle')
    setStatusMessage('Waiting to connect')
  }

  async function switchEndpoint(nextEndpointId: string) {
    if (!endpoints.some((endpoint) => endpoint.id === nextEndpointId) || nextEndpointId === activeEndpointId) {
      return
    }

    resetConnectionState()
    setRefreshKey((current) => current + 1)
    setActiveEndpointIdState(nextEndpointId)
    setConnectionVersion((current) => current + 1)
  }

  function updateActiveEndpoint(updater: (current: ExplorerEndpoint) => ExplorerEndpoint) {
      setEndpoints((current) =>
        current.map((endpoint) => (endpoint.id === activeEndpoint.id ? updater(endpoint) : endpoint)),
      )
  }

  useEffect(() => {
    let cancelled = false
    const client = createAnvilClient(rpcUrl)
    let hasConnectedOnce = false
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5

    function applyProgress(progress: SyncProgress) {
      if (cancelled) {
        return
      }

      if (!hasConnectedOnce) {
        setStatus(progress.phase === 'ready' ? 'ready' : progress.phase)
        setStatusMessage(progress.message)
        return
      }

      if (progress.phase === 'syncing') {
        setStatus('syncing')
        setStatusMessage(progress.message)
      }
    }

    async function loadStats(bumpRefreshKey: boolean) {
      const nextStats = await getExplorerStats()

      if (cancelled) {
        return
      }

      setStats((current) => (areStatsEqual(current, nextStats) ? current : nextStats))

      if (bumpRefreshKey) {
        setRefreshKey((current) => current + 1)
      }
    }

    async function loadCachedState() {
      const [cachedChainMeta, cachedStats] = await Promise.all([getChainMeta(), getExplorerStats()])

      if (cancelled) {
        return
      }

      setChainMeta(cachedChainMeta ?? null)
      setStats(cachedStats)

      if (cachedChainMeta) {
        setStatus('syncing')
        setStatusMessage(`Loaded cached chain at block ${cachedChainMeta.latestIndexedBlock}`)
      }
    }

    async function run() {
      await loadCachedState()

      while (!cancelled) {
        try {
          setError(null)
          const result = await syncChain(client, rpcUrl, startBlock, applyProgress)

          if (cancelled) {
            return
          }

          setChainMeta((current) => (areChainMetaEqual(current, result.meta) ? current : result.meta))
          await loadStats(result.changed)
          hasConnectedOnce = true
          consecutiveFailures = 0
          setStatus('ready')
          setStatusMessage(
            result.changed
              ? `Indexed through block ${result.meta.latestIndexedBlock}`
              : `Watching block ${result.meta.latestBlockNumber}`,
          )
        } catch (caughtError: unknown) {
          if (cancelled) {
            return
          }

          consecutiveFailures++
          const message =
            caughtError instanceof Error ? caughtError.message : 'Failed to connect to Anvil'
          setError(message)
          setStatus('error')
          logger.error('Sync cycle failed', caughtError)

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            setStatusMessage('Connection failed — use Reconnect to retry')
            return
          }

          setStatusMessage('Waiting to reconnect')
        }

        await wait(2000)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [activeScopeKey, rpcUrl, startBlock, connectionVersion])

  useEffect(() => {
    let cancelled = false
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5

    async function run() {
      while (!cancelled) {
        try {
          const changed = await syncUploadedAbis(abiApiUrl)

          if (cancelled) {
            return
          }

          consecutiveFailures = 0

          if (changed) {
            setRefreshKey((current) => current + 1)
          }
        } catch {
          consecutiveFailures++
          logger.warn(`ABI endpoint failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`)

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.warn('ABI endpoint polling stopped — save endpoint to retry')
            return
          }
        }

        await wait(3000)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [abiApiUrl])

  async function runAction(action: () => Promise<void>) {
    setStatus('syncing')
    setError(null)

    try {
      await action()
      setConnectionVersion((current) => current + 1)
    } catch (caughtError: unknown) {
      const message = caughtError instanceof Error ? caughtError.message : 'RPC action failed'
      setError(message)
      setStatus('error')
      throw caughtError
    }
  }

  const value: ExplorerContextValue = {
    activeEndpointId,
    endpoints,
    abiApiUrl,
    chainMeta,
    error,
    refreshKey,
    rpcUrl,
    startBlock,
    setActiveEndpointId: switchEndpoint,
    setAbiApiUrl,
    setRpcUrl(value) {
      updateActiveEndpoint((current) => ({
        ...current,
        rpcUrl: value,
      }))
    },
    setStartBlock(value) {
      updateActiveEndpoint((current) => ({
        ...current,
        startBlock: value,
      }))
    },
    async saveEndpoint(input) {
      const rpcUrl = input.rpcUrl.trim()
      const name = input.name.trim()

      if (!rpcUrl) {
        throw new Error('RPC URL is required')
      }

      const endpointId = input.id?.trim() || `endpoint-${Date.now()}`

      setEndpoints((current) => {
        const nextEndpoint: ExplorerEndpoint = {
          id: endpointId,
          name: name || 'Untitled Endpoint',
          rpcUrl,
          startBlock: input.startBlock,
        }

        const existingIndex = current.findIndex((endpoint) => endpoint.id === endpointId)

        if (existingIndex === -1) {
          return [...current, nextEndpoint]
        }

        return current.map((endpoint) => (endpoint.id === endpointId ? nextEndpoint : endpoint))
      })

      return endpointId
    },
    async deleteEndpoint(endpointId) {
      if (endpoints.length <= 1) {
        throw new Error('At least one endpoint must remain')
      }

      const nextActiveId = endpointId === activeEndpointId ? endpoints.find((endpoint) => endpoint.id !== endpointId)?.id : activeEndpointId

      setEndpoints((current) => current.filter((endpoint) => endpoint.id !== endpointId))

      if (endpointId === activeEndpointId && nextActiveId) {
        await resetConnectionState()
        setActiveEndpointIdState(nextActiveId)
        setConnectionVersion((current) => current + 1)
      }
    },
    snapshots,
    status,
    stats,
    statusMessage,
    actions: {
      reconnect() {
        setConnectionVersion((current) => current + 1)
      },
      refresh() {
        setRefreshKey((current) => current + 1)
      },
      async resetChainData() {
        await resetExplorerData()
        resetConnectionState()
        setRefreshKey((current) => current + 1)
        setConnectionVersion((current) => current + 1)
      },
      async resetData() {
        await resetExplorerDataIncludingAbis()
        setSnapshots([])
        setRefreshKey((current) => current + 1)
        setChainMeta(null)
        setStats(EMPTY_STATS)
        setError(null)
        setStatus('idle')
        setStatusMessage('Waiting to connect')
        setConnectionVersion((current) => current + 1)
      },
      async loadTrace(txHash) {
        const client = createAnvilClient(rpcUrl)
        return getTrace(client, txHash)
      },
      async mineBlocks(count) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await mineBlocks(client, count)
        })
      },
      async setBalance(address, amountEth) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await setBalance(client, address, amountEth)
        })
      },
      async createSnapshot() {
        const client = createAnvilClient(rpcUrl)
        const snapshotId = await createSnapshot(client)
        setSnapshots((current) => [snapshotId, ...current])
        return snapshotId
      },
      async revertSnapshot(snapshotId) {
        const client = createAnvilClient(rpcUrl)
        const reverted = await revertSnapshot(client, snapshotId)

        if (reverted) {
          setSnapshots((current) => current.filter((item) => item !== snapshotId))
          setConnectionVersion((current) => current + 1)
        }

        return reverted
      },
    },
  }

  return <ExplorerContext.Provider value={value}>{props.children}</ExplorerContext.Provider>
}

export function useExplorer() {
  const context = useContext(ExplorerContext)

  if (!context) {
    throw new Error('useExplorer must be used inside ExplorerProvider')
  }

  return context
}
