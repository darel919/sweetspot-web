export function nextPowerOfTwo(value: number): number {
  let result = 1
  while (result < value) result *= 2
  return result
}

/** In-place radix-2 FFT. The sign is negative for the forward transform. */
export function fftInPlace(real: Float64Array, imaginary: Float64Array, inverse = false): void {
  const length = real.length
  if (length === 0 || (length & (length - 1)) !== 0 || imaginary.length !== length) {
    throw new Error('FFT requires equal non-empty power-of-two arrays.')
  }

  for (let index = 1, reverse = 0; index < length; index++) {
    let bit = length >> 1
    for (; reverse & bit; bit >>= 1) reverse ^= bit
    reverse ^= bit
    if (index < reverse) {
      const realValue = real[index]
      real[index] = real[reverse]
      real[reverse] = realValue
      const imaginaryValue = imaginary[index]
      imaginary[index] = imaginary[reverse]
      imaginary[reverse] = imaginaryValue
    }
  }

  for (let width = 2; width <= length; width *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / width
    const sine = Math.sin(angle)
    const cosine = Math.cos(angle)
    for (let start = 0; start < length; start += width) {
      let currentCosine = 1
      let currentSine = 0
      const half = width >> 1
      for (let offset = 0; offset < half; offset++) {
        const left = start + offset
        const right = left + half
        const rightReal = real[right] * currentCosine - imaginary[right] * currentSine
        const rightImaginary = real[right] * currentSine + imaginary[right] * currentCosine
        real[right] = real[left] - rightReal
        imaginary[right] = imaginary[left] - rightImaginary
        real[left] += rightReal
        imaginary[left] += rightImaginary
        const nextCosine = currentCosine * cosine - currentSine * sine
        currentSine = currentCosine * sine + currentSine * cosine
        currentCosine = nextCosine
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < length; index++) {
      real[index] /= length
      imaginary[index] /= length
    }
  }
}
