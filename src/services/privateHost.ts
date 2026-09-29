/**
 * D-1：私网/保留地址判定——**零 node 依赖**的共享叶子模块。
 *
 * 抽出来的原因：同一套 SSRF 判定原先只存在于主进程 `electron/ipc-handlers.ts`
 * （`isPrivateHostname` / `isPrivateIPv4` / `isPrivateIPv6`），而导入校验
 * （`src/services/importValidation.ts`）在渲染层、拿不到它 ⇒ 导入侧只验协议，
 * 放行了指向内网的 provider baseUrl，直到运行时 `llm:chatCompletion` 才由
 * `isHostAllowed` 拦下——「校验放行、使用时报错」，校验点与使用点不一致。
 * 抽到共享模块后两侧同源：渲染层直接 import，主进程走
 * `../src/services/privateHost` 相对导入（与 `../src/services/llmTimeouts` 同一约定，
 * 主进程构建无 @ alias 但可相对导入零依赖模块）。
 *
 * 硬约束：渲染层不能 import `node:net`，故原 `isIP()` 的「是否 IP 字面量」判定改为
 * 自实现。`isPrivateIPv4` 对畸形段本就保守判 true（宁可多判），语义与原来等价——
 * 差异由 `test\unit\privateHost.spec.ts` 逐条钉住。
 *
 * 注意本模块只做**字面量**判定：解析到内网的域名（nip.io / DNS rebinding）仍需
 * 运行时 `isHostAllowed` 的 DNS 解析把关，二者分工不变。
 */

/** 是否 IPv4 字面量（4 段十进制、每段 0-255） */
function isIPv4Literal(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 是否 IPv6 字面量（含冒号即按 IPv6 走——后续按私网段保守判定） */
function isIPv6Literal(host: string): boolean {
  return host.includes(':')
}

/** 是否私网/保留 IPv4（畸形段本就不确定 → 保守判 true，不因解析歧义放行） */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && (b === 0 || b === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51) return true
  if (a === 203 && b === 0) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/** 是否私网/保留 IPv6（含 IPv4 映射与 NAT64 两种内嵌形态） */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('100::')) return true
  if (lower.startsWith('2001:db8:')) return true
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])
  const nat64 = lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/)
  if (nat64) return isPrivateIPv4(nat64[1])
  return false
}

/**
 * 判定 hostname 是否指向内网/保留地址（字面量层面）。
 * 接受 URL.hostname 的括号形态（`[::1]`）。
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost') return true
  if (isIPv4Literal(host)) return isPrivateIPv4(host)
  if (isIPv6Literal(host)) return isPrivateIPv6(host)
  return false
}
