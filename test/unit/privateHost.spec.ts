import { describe, it, expect } from 'vitest'
import { isPrivateHostname, isPrivateIPv4, isPrivateIPv6 } from '@/services/privateHost'

/**
 * D-1 修复的一部分：私网/保留地址判定从主进程 `electron/ipc-handlers.ts` 抽成
 * **零 node 依赖**的共享叶子模块，供渲染层（导入校验 `importValidation`）与主进程
 * （`isHostAllowed` / `safeFetch`）共用同一口径——校验点与使用点同源，杜绝
 * 「导入放行、运行时才拦」的不一致。
 *
 * 抽出的硬约束：渲染层不能 import `node:net`，故 `isIP()` 的判定改为自实现
 * （`isPrivateIPv4` 对非法段本就保守判 true，语义与原来等价）。
 */
describe('privateHost —— 私网/保留地址判定', () => {
  it('localhost 与私网 IPv4 字面量判为私网', () => {
    for (const h of [
      'localhost', '127.0.0.1', '0.0.0.0', '10.0.0.5', '10.255.255.255',
      '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
      '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '224.0.0.1',
    ]) {
      expect(isPrivateHostname(h), h).toBe(true)
    }
  })

  it('公网 IPv4 与普通域名不判为私网', () => {
    for (const h of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.63.0.1', 'api.example.com', 'api.openai.com']) {
      expect(isPrivateHostname(h), h).toBe(false)
    }
  })

  it('IPv6：回环/链路本地/唯一本地/映射私网判为私网（含 URL.hostname 的括号形态）', () => {
    for (const h of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '[::1]', '[fd00::1]']) {
      expect(isPrivateHostname(h), h).toBe(true)
    }
  })

  it('公网 IPv6 与文档示例段外地址不判为私网', () => {
    for (const h of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
      expect(isPrivateHostname(h), h).toBe(false)
    }
  })

  it('isPrivateIPv4 对畸形段保守判为私网（不因解析歧义放行）', () => {
    expect(isPrivateIPv4('1.2.3')).toBe(true)
    expect(isPrivateIPv4('999.1.1.1')).toBe(true)
    expect(isPrivateIPv4('a.b.c.d')).toBe(true)
    expect(isPrivateIPv4('8.8.8.8')).toBe(false)
  })

  it('isPrivateIPv6 覆盖 NAT64 映射的私网 IPv4', () => {
    expect(isPrivateIPv6('64:ff9b::192.168.1.1')).toBe(true)
    expect(isPrivateIPv6('64:ff9b::8.8.8.8')).toBe(false)
  })
})
