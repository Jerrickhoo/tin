// RFC 4122 UUIDv5 (SHA-1, name-based) via WebCrypto — available in browsers
// and Node 20+. Deterministic posting IDs are what make two-device recurring
// catch-up collide into one row instead of double-posting rent (ROADMAP 5.1).

/** Tin's fixed namespace for recurring postings (random, generated once). */
export const TIN_RECURRING_NAMESPACE = '5f0be0b2-f0aa-4dcf-9f39-4f4a30e5f524'

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export async function uuidv5(namespace: string, name: string): Promise<string> {
  const ns = uuidToBytes(namespace)
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(ns.length + nameBytes.length)
  input.set(ns)
  input.set(nameBytes, ns.length)

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input.buffer as ArrayBuffer))
  const b = digest.slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant

  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
