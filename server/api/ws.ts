import { defineWebSocketHandler, type Peer } from 'h3'
import {
  MAX_PAYLOAD_BYTES,
  KNOWN_TYPES,
  SESSION_ONLY_TYPES,
  isDeviceTargeted,
  isValidPairCode,
  pairRoom,
  type Envelope,
  type ErrorPayload,
  type PeerEventPayload,
  type Role,
  type WelcomePayload,
} from '../../shared/types/protocol'

const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MAX_MESSAGES = 60

interface Room {
  name: string
  device?: Peer
  clients: Set<Peer>
}

interface PeerContext {
  role: Role
  room: string
  helloDone: boolean
  messageTimestamps: number[]
}

const rooms = new Map<string, Room>()

function getRoom(name: string): Room {
  let room = rooms.get(name)
  if (!room) {
    room = { name, clients: new Set() }
    rooms.set(name, room)
  }
  return room
}

function dropPeer(peer: Peer<PeerContext>) {
  const room = rooms.get(peer.context.room)
  if (!room) return
  if (peer.context.role === 'device') {
    if (room.device === peer) room.device = undefined
  } else {
    room.clients.delete(peer)
  }
  if (!room.device && room.clients.size === 0) rooms.delete(peer.context.room)
  broadcastRelayEvent(room, peer, 'session.peerLeft')
}

function broadcastRelayEvent(
  room: Room,
  from: Peer,
  type: 'session.peerJoined' | 'session.peerLeft',
) {
  const data = JSON.stringify({
    v: 1,
    id: relayId(),
    type,
    ts: Date.now(),
    payload: { role: from.context.role } satisfies PeerEventPayload,
  })
  for (const client of room.clients) {
    if (client !== from) client.send(data)
  }
  if (room.device && room.device !== from) room.device.send(data)
}

function welcomeState(room: Room): WelcomePayload {
  return {
    room: room.name,
    peers: { deviceOnline: !!room.device, clients: room.clients.size },
  }
}

let relayCounter = 0

function relayId(): string {
  return `relay_${Date.now().toString(36)}_${(relayCounter++).toString(36)}`
}

function sendError(peer: Peer<PeerContext>, code: ErrorPayload['code'], message?: string) {
  peer.send(
    JSON.stringify({
      v: 1,
      id: relayId(),
      type: 'session.error',
      ts: Date.now(),
      payload: { code, message },
    }),
  )
}

function rateLimited(peer: Peer<PeerContext>): boolean {
  const now = Date.now()
  const stamps = peer.context.messageTimestamps
  while (stamps.length && now - stamps[0] > RATE_LIMIT_WINDOW_MS) stamps.shift()
  stamps.push(now)
  return stamps.length > RATE_LIMIT_MAX_MESSAGES
}

export default defineWebSocketHandler({
  open(peer) {
    const ctx = (peer.context ??= {} as PeerContext)
    ctx.role = 'client'
    ctx.room = ''
    ctx.helloDone = false
    ctx.messageTimestamps = []
  },

  message(rawPeer, rawMessage) {
    const peer = rawPeer as Peer<PeerContext>

    if (rateLimited(peer)) {
      sendError(peer, 'rate_limited', 'too many messages')
      peer.close()
      return
    }

    let text: string
    try {
      text = rawMessage.text()
    } catch {
      sendError(peer, 'bad_envelope', 'binary frames are not accepted')
      peer.close()
      return
    }

    if (text.length > MAX_PAYLOAD_BYTES) {
      sendError(peer, 'payload_too_large')
      peer.close()
      return
    }

    let env: Partial<Envelope>
    try {
      env = JSON.parse(text)
    } catch {
      sendError(peer, 'bad_envelope', 'message is not valid JSON')
      return
    }

    if (env.v !== 1 || typeof env.id !== 'string' || typeof env.type !== 'string') {
      sendError(peer, 'bad_envelope', 'envelope requires v=1, id and type strings')
      return
    }

    if (env.type === 'ping' || env.type === 'pong') {
      if (env.type === 'ping') peer.send(JSON.stringify({ ...env, type: 'pong', ts: Date.now() }))
      return
    }

    if (!KNOWN_TYPES.has(env.type)) {
      sendError(peer, 'unknown_type', `unsupported message type "${env.type}"`)
      return
    }

    if (!peer.context.helloDone) {
      if (env.type !== 'session.hello') {
        sendError(peer, 'bad_envelope', 'first message must be session.hello')
        peer.close()
        return
      }
      const payload = env.payload as { role?: Role; room?: string } | undefined
      const role = payload?.role
      const roomName = payload?.room
      if ((role !== 'device' && role !== 'client') || typeof roomName !== 'string' || !isValidPairCode(roomName)) {
        sendError(peer, 'bad_envelope', 'session.hello requires role device|client and a valid pair-code room')
        peer.close()
        return
      }
      const room = getRoom(pairRoom(roomName))
      peer.context.role = role
      peer.context.room = pairRoom(roomName)

      if (role === 'device') {
        if (room.device) {
          sendError(peer, 'bad_envelope', 'another device already owns this room')
          peer.close()
          return
        }
        room.device = peer
      } else {
        room.clients.add(peer)
      }

      peer.context.helloDone = true
      peer.send(JSON.stringify({ v: 1, id: relayId(), type: 'session.welcome', ts: Date.now(), payload: welcomeState(room) }))
      broadcastRelayEvent(room, peer, 'session.peerJoined')
      return
    }

    if (SESSION_ONLY_TYPES.has(env.type)) {
      sendError(peer, 'bad_envelope', `"${env.type}" is only allowed once after connect`)
      return
    }

    if (isDeviceTargeted(env.type)) {
      if (peer.context.role !== 'client') {
        sendError(peer, 'bad_envelope', `only clients may send "${env.type}"`)
        return
      }
      const room = rooms.get(peer.context.room)
      if (!room?.device) {
        sendError(peer, 'not_in_room', 'no device online in this room')
        return
      }
      room.device.send(text)
      return
    }

    const room = rooms.get(peer.context.room)
    if (!room) {
      sendError(peer, 'not_in_room', 'peer is not in a room')
      return
    }

    if (peer.context.role === 'device') {
      for (const client of room.clients) client.send(text)
    } else {
      if (room.device) room.device.send(text)
    }
  },

  close(peer) {
    dropPeer(peer as Peer<PeerContext>)
  },

  error(peer) {
    dropPeer(peer as Peer<PeerContext>)
  },
})
