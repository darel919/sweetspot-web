export interface CaptureChannelHandlers {
  onMessage: (event: MessageEvent<unknown>) => void
  onOpen: () => void
  onClose: () => void
  onError: () => void
  onBufferedAmountLow: () => void
}

export function bindCaptureChannel(
  channel: RTCDataChannel,
  bufferedAmountLowThreshold: number,
  isCurrent: () => boolean,
  handlers: CaptureChannelHandlers,
): void {
  channel.binaryType = 'arraybuffer'
  channel.bufferedAmountLowThreshold = bufferedAmountLowThreshold
  channel.onmessage = (event) => { if (isCurrent()) handlers.onMessage(event) }
  channel.onopen = () => { if (isCurrent()) handlers.onOpen() }
  channel.onclose = () => { if (isCurrent()) handlers.onClose() }
  channel.onerror = () => { if (isCurrent()) handlers.onError() }
  channel.onbufferedamountlow = () => { if (isCurrent()) handlers.onBufferedAmountLow() }
  if (!isCurrent()) channel.close()
}
