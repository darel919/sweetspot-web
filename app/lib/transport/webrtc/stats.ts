export interface PeerStatsSnapshot {
  selectedCandidateType: string | null
  selectedCandidateProtocol: string | null
  rttMs: number | null
  bytesSent: number | null
  bytesReceived: number | null
}

export async function readPeerStats(peer: RTCPeerConnection): Promise<PeerStatsSnapshot | null> {
  const reports = await peer.getStats()
  let selectedPair: RTCIceCandidatePairStats | null = null
  reports.forEach((report) => {
    if (report.type !== 'candidate-pair') return
    const pair = report as RTCIceCandidatePairStats & { selected?: boolean }
    if (pair.selected === true || (pair.nominated === true && pair.state === 'succeeded')) selectedPair = pair
  })
  if (!selectedPair) return null
  const localCandidate = reports.get(selectedPair.localCandidateId) as RTCIceCandidateStats | undefined
  const remoteCandidate = reports.get(selectedPair.remoteCandidateId) as RTCIceCandidateStats | undefined
  return {
    selectedCandidateType: localCandidate?.candidateType ?? remoteCandidate?.candidateType ?? null,
    selectedCandidateProtocol: localCandidate?.protocol ?? remoteCandidate?.protocol ?? null,
    rttMs: typeof selectedPair.currentRoundTripTime === 'number'
      ? selectedPair.currentRoundTripTime * 1_000
      : null,
    bytesSent: typeof selectedPair.bytesSent === 'number' ? selectedPair.bytesSent : null,
    bytesReceived: typeof selectedPair.bytesReceived === 'number' ? selectedPair.bytesReceived : null,
  }
}
