const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount))
}

function word(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24)
    | ((bytes[offset + 1] ?? 0) << 16)
    | ((bytes[offset + 2] ?? 0) << 8)
    | (bytes[offset + 3] ?? 0)
}

export class Sha256 {
  private readonly state = new Uint32Array(INITIAL_STATE)
  private readonly buffer = new Uint8Array(64)
  private readonly schedule = new Uint32Array(64)
  private bufferLength = 0
  private byteLength = 0

  update(input: ArrayBuffer | Uint8Array): this {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    this.byteLength += bytes.byteLength
    let offset = 0
    if (this.bufferLength > 0) {
      const copied = Math.min(64 - this.bufferLength, bytes.byteLength)
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength)
      this.bufferLength += copied
      offset += copied
      if (this.bufferLength === 64) {
        this.compress(this.buffer)
        this.bufferLength = 0
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.compress(bytes.subarray(offset, offset + 64))
      offset += 64
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0)
      this.bufferLength = bytes.byteLength - offset
    }
    return this
  }

  digestHex(): string {
    const copy = new Sha256()
    copy.state.set(this.state)
    copy.buffer.set(this.buffer)
    copy.bufferLength = this.bufferLength
    copy.byteLength = this.byteLength
    copy.buffer[copy.bufferLength++] = 0x80
    if (copy.bufferLength > 56) {
      copy.buffer.fill(0, copy.bufferLength)
      copy.compress(copy.buffer)
      copy.bufferLength = 0
    }
    copy.buffer.fill(0, copy.bufferLength, 56)
    const bits = copy.byteLength * 8
    const view = new DataView(copy.buffer.buffer)
    view.setUint32(56, Math.floor(bits / 0x1_0000_0000), false)
    view.setUint32(60, bits >>> 0, false)
    copy.compress(copy.buffer)
    return Array.from(copy.state, (value) => value.toString(16).padStart(8, '0')).join('')
  }

  private compress(bytes: Uint8Array): void {
    for (let index = 0; index < 16; index++) this.schedule[index] = word(bytes, index * 4)
    for (let index = 16; index < 64; index++) {
      const previous = this.schedule[index - 15] ?? 0
      const earlier = this.schedule[index - 2] ?? 0
      const smallSigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)
      const smallSigma1 = rotateRight(earlier, 17) ^ rotateRight(earlier, 19) ^ (earlier >>> 10)
      this.schedule[index] = (this.schedule[index - 16] + smallSigma0 + this.schedule[index - 7] + smallSigma1) >>> 0
    }
    let a = this.state[0] ?? 0
    let b = this.state[1] ?? 0
    let c = this.state[2] ?? 0
    let d = this.state[3] ?? 0
    let e = this.state[4] ?? 0
    let f = this.state[5] ?? 0
    let g = this.state[6] ?? 0
    let h = this.state[7] ?? 0
    for (let index = 0; index < 64; index++) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + bigSigma1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (this.schedule[index] ?? 0)) >>> 0
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (bigSigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    this.state[0] = (this.state[0] + a) >>> 0
    this.state[1] = (this.state[1] + b) >>> 0
    this.state[2] = (this.state[2] + c) >>> 0
    this.state[3] = (this.state[3] + d) >>> 0
    this.state[4] = (this.state[4] + e) >>> 0
    this.state[5] = (this.state[5] + f) >>> 0
    this.state[6] = (this.state[6] + g) >>> 0
    this.state[7] = (this.state[7] + h) >>> 0
  }
}

