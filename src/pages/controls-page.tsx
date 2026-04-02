import { useEffect, useState } from 'preact/hooks'
import { ErrorState, PageSection } from '../components/common.tsx'
import { useExplorer } from '../hooks/use-explorer.tsx'

type RouteProps = { path?: string }
const DEFAULT_RPC_PLACEHOLDER = 'http://127.0.0.1:8545'

export function ControlsPage(_: RouteProps) {
  const {
    actions,
    activeEndpointId,
    chainMeta,
    deleteEndpoint,
    endpoints,
    saveEndpoint,
    setActiveEndpointId,
    snapshots,
  } = useExplorer()
  const [mineCount, setMineCount] = useState('1')
  const [balanceAddress, setBalanceAddress] = useState('')
  const [balanceEth, setBalanceEth] = useState('100')
  const [snapshotId, setSnapshotId] = useState('')
  const [endpointDraftId, setEndpointDraftId] = useState<string | null>(activeEndpointId)
  const [endpointNameDraft, setEndpointNameDraft] = useState(
    () => endpoints.find((endpoint) => endpoint.id === activeEndpointId)?.name ?? 'Local Anvil',
  )
  const [rpcDraft, setRpcDraft] = useState(
    () => endpoints.find((endpoint) => endpoint.id === activeEndpointId)?.rpcUrl ?? DEFAULT_RPC_PLACEHOLDER,
  )
  const [startBlockDraft, setStartBlockDraft] = useState(() => {
    const activeEndpoint = endpoints.find((endpoint) => endpoint.id === activeEndpointId)
    return activeEndpoint?.startBlock !== null && activeEndpoint?.startBlock !== undefined
      ? String(activeEndpoint.startBlock)
      : ''
  })
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const activeEndpoint = endpoints.find((endpoint) => endpoint.id === activeEndpointId)
    setEndpointDraftId(activeEndpointId)
    setEndpointNameDraft(activeEndpoint?.name ?? 'Local Anvil')
    setRpcDraft(activeEndpoint?.rpcUrl ?? DEFAULT_RPC_PLACEHOLDER)
    setStartBlockDraft(
      activeEndpoint?.startBlock !== null && activeEndpoint?.startBlock !== undefined
        ? String(activeEndpoint.startBlock)
        : '',
    )
  }, [activeEndpointId, endpoints])

  async function run(action: () => Promise<void>) {
    setError(null)

    try {
      await action()
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Control call failed')
    }
  }

  function parseStartBlockDraft(value: string) {
    const trimmed = value.trim()
    if (trimmed === '') {
      return null
    }

    const parsed = Number.parseInt(trimmed, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  function handleNewEndpoint() {
    setEndpointDraftId(null)
    setEndpointNameDraft(`Endpoint ${endpoints.length + 1}`)
    setRpcDraft(DEFAULT_RPC_PLACEHOLDER)
    setStartBlockDraft('')
  }

  function handleEditEndpoint(endpointId: string) {
    const endpoint = endpoints.find((item) => item.id === endpointId)

    if (!endpoint) {
      return
    }

    setEndpointDraftId(endpoint.id)
    setEndpointNameDraft(endpoint.name)
    setRpcDraft(endpoint.rpcUrl)
    setStartBlockDraft(endpoint.startBlock !== null ? String(endpoint.startBlock) : '')
  }

  async function handleEndpointSubmit(event: Event) {
    event.preventDefault()
    const nextStartBlock = parseStartBlockDraft(startBlockDraft)
    const endpointId = await saveEndpoint({
      id: endpointDraftId ?? undefined,
      name: endpointNameDraft,
      rpcUrl: rpcDraft,
      startBlock: nextStartBlock,
    })

    if (endpointId === activeEndpointId) {
      await actions.resetChainData()
    } else {
      await setActiveEndpointId(endpointId)
    }

    setEndpointDraftId(endpointId)
    setResult(`Saved endpoint ${endpointNameDraft.trim() || 'Untitled Endpoint'}`)
  }

  async function handleDeleteEndpoint() {
    const targetId = endpointDraftId ?? activeEndpointId
    const target = endpoints.find((endpoint) => endpoint.id === targetId)
    await deleteEndpoint(targetId)
    setResult(`Removed endpoint ${target?.name ?? targetId}`)
  }

  return (
    <>
      {result && <p class="success-copy">{result}</p>}
      {error && <ErrorState message={error} />}

      <div class="config-grid">
        <PageSection title="Reset Explorer Data" description="Clear IndexedDB stores and restart indexing from the beginning">
          <button
            class="danger-button"
            onClick={() =>
              run(async () => {
                await actions.resetData()
                setResult('Cleared IndexedDB stores')
              })
            }
          >
            Reset IndexedDB
          </button>
        </PageSection>

        <PageSection
          title="Endpoint Management"
          description="Manage saved RPC endpoints and switch chains safely from one place"
        >
          <form class="sidebar-endpoint-form endpoint-management-form" onSubmit={handleEndpointSubmit}>
            <label>
              <span class="field-label">Saved Endpoints</span>
              <div class="endpoint-list">
                {endpoints.map((endpoint) => (
                  <div class={`endpoint-item ${endpoint.id === activeEndpointId ? 'is-active' : ''}`.trim()}>
                    <button type="button" class="endpoint-item-main" onClick={() => handleEditEndpoint(endpoint.id)}>
                      <strong>{endpoint.name}</strong>
                      <span>{endpoint.rpcUrl}</span>
                    </button>
                  </div>
                ))}
              </div>
            </label>
            <div class="button-row endpoint-actions-row">
              <button type="button" onClick={handleNewEndpoint}>New</button>
              <button type="button" onClick={handleDeleteEndpoint} disabled={endpoints.length <= 1}>
                Remove
              </button>
            </div>
            <label>
              <span class="field-label">Endpoint Name</span>
              <input value={endpointNameDraft} onInput={(event) => setEndpointNameDraft(event.currentTarget.value)} />
            </label>
            <label>
              <span class="field-label">RPC URL</span>
              <input
                value={rpcDraft}
                onInput={(event) => setRpcDraft(event.currentTarget.value)}
                placeholder={DEFAULT_RPC_PLACEHOLDER}
              />
            </label>
            <label>
              <span class="field-label">Start Block</span>
              <input
                value={startBlockDraft}
                onInput={(event) => setStartBlockDraft(event.currentTarget.value)}
                placeholder={chainMeta?.forkConfig ? String(chainMeta.forkConfig.forkBlockNumber) : '0'}
                type="number"
                min="0"
              />
            </label>
            <button type="submit">{endpointDraftId ? 'Save Endpoint' : 'Add Endpoint'}</button>
          </form>
        </PageSection>

        <PageSection title="Mine Blocks" description="Call anvil_mine and trigger a resync">
          <div class="inline-controls">
            <input value={mineCount} onInput={(event) => setMineCount(event.currentTarget.value)} />
            <button
              onClick={() =>
                run(async () => {
                  await actions.mineBlocks(Number.parseInt(mineCount, 10) || 1)
                  setResult(`Mined ${mineCount} block(s)`)
                })
              }
            >
              Mine
            </button>
          </div>
        </PageSection>

        <PageSection title="Set Balance" description="Call anvil_setBalance for a local test account">
          <div class="stack-form">
            <input
              value={balanceAddress}
              onInput={(event) => setBalanceAddress(event.currentTarget.value)}
              placeholder="0x..."
            />
            <input
              value={balanceEth}
              onInput={(event) => setBalanceEth(event.currentTarget.value)}
              placeholder="100"
            />
            <button
              onClick={() =>
                run(async () => {
                  await actions.setBalance(balanceAddress, balanceEth)
                  setResult(`Set balance for ${balanceAddress}`)
                })
              }
            >
              Set Balance
            </button>
          </div>
        </PageSection>

        <PageSection title="Snapshot / Revert" description="Local chain rewinds are reconciled back into IndexedDB">
          <div class="button-row">
            <button
              onClick={() =>
                run(async () => {
                  const nextSnapshotId = await actions.createSnapshot()
                  setSnapshotId(nextSnapshotId)
                  setResult(`Created snapshot ${nextSnapshotId}`)
                })
              }
            >
              Create Snapshot
            </button>
            <input
              value={snapshotId}
              onInput={(event) => setSnapshotId(event.currentTarget.value)}
              placeholder="snapshot id"
            />
            <button
              onClick={() =>
                run(async () => {
                  const reverted = await actions.revertSnapshot(snapshotId)
                  setResult(reverted ? `Reverted snapshot ${snapshotId}` : `Snapshot ${snapshotId} rejected`)
                })
              }
            >
              Revert
            </button>
          </div>

          {snapshots.length > 0 && (
            <ul class="snapshot-list">
              {snapshots.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      </div>
    </>
  )
}
