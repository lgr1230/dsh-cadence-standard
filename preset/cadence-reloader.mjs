/**
 * cadence-reloader (V2.8) — in-preset code reloader, custom-built for preset
 * rows (dsh-super-injector's dev_reload_package cannot target them: preset
 * subtrees plug directly via agentCtx.plugin(PresetTree, …), so their modules
 * never enter the injector's loader-entry registry).
 *
 * How preset reload works (verified 2026-08-16):
 *  - Preset rows import through Node's internal ESM loader → live in
 *    `internal.loadCache` keyed by resolved file URLs — that is the cache
 *    to purge.
 *  - The roster re-mounts a preset when its composition file stamp
 *    ({mtimeMs, size}) changes; without a purge the re-import serves the OLD
 *    module (measured failure mode).
 *
 * So `cadence_reload` = VERIFY FIRST against a THROWAWAY temp copy (full
 * graph: bootstrap's relative './cadence-core' resolves inside the copy, so
 * linking errors are caught; the real cache is untouched on failure) → purge
 * the real URLs (Map.prototype.delete.call — verified on Node 24's LoadCache;
 * its own `.set()` throws and is never used) → bump the composition stamp
 * (update the `cadence-reload-stamp` line in agent.cordis.yml) → the NEXT
 * NEW session mounts the new code. Zero deps beyond node builtins (the
 * reloader must stay reloadable and importable anywhere).
 */

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'cadence-reloader'

/** The loader and tools registries must exist (the loader exposes the
 *  internal ESM loader whose loadCache this plugin purges). */
export const inject = ['loader', 'tools']

/** The preset's own files, in purge order (self last: harmless to purge). */
const FILES = ['cadence-bootstrap.mjs', 'cadence-core.mjs', 'cadence-reloader.mjs']
const YML_NAME = 'agent.cordis.yml'
const STAMP_PREFIX = '# cadence-reload-stamp: '

/** Minimal spec → JSON Schema (subset of defineTool; zero external imports). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec ?? {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx) {
  const presetDir = dirname(fileURLToPath(import.meta.url))
  const ymlPath = join(presetDir, YML_NAME)
  const realSuffixes = FILES.map((f) => realpathSync(join(presetDir, f)).replace(/\\/g, '/'))

  /** The internal ESM loader cache, or a descriptive throw. Node 24's
   *  `loadCache` is a LoadCache instance (duck-typed), not a Map. */
  function loadCacheOf() {
    const internal = ctx.loader?.internal
    const loadCache = internal?.loadCache
    if (typeof loadCache?.keys !== 'function' || typeof loadCache?.delete !== 'function') {
      throw new Error('internal ESM loader cache unavailable'
        + ` (ctx.loader=${typeof ctx.loader}, internal=${internal === undefined ? 'undefined' : 'ok'},`
        + ` loadCache=${typeof loadCache}${loadCache ? `/${loadCache.constructor?.name}` : ''})`)
    }
    return loadCache
  }

  /** Verify the FULL module graph of the preset from a throwaway temp copy:
   *  bootstrap's relative './cadence-core.mjs' resolves inside the copy, so
   *  syntax AND linking errors (missing exports, bad specifiers) are caught.
   *  The real ESM cache is never touched here. Throws on the first broken
   *  file; the temp dir is always removed. */
  async function verifyFresh() {
    const dir = mkdtempSync(join(tmpdir(), 'cadence-verify-'))
    try {
      for (const f of FILES) cpSync(join(presetDir, f), join(dir, f))
      for (const f of FILES) {
        await import(pathToFileURL(join(dir, f)).href)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Delete the preset's real module URLs from the internal ESM cache.
   *  Verified on Node 24's LoadCache: `Map.prototype.delete.call` works while
   *  the class's own `set()` throws — deletion only, never insertion. */
  function purgeReal() {
    const loadCache = loadCacheOf()
    const purged = []
    for (const u of [...loadCache.keys()]) {
      if (typeof u !== 'string') continue
      const d = decodeURIComponent(u).replace(/\\/g, '/')
      if (!realSuffixes.some((s) => d.endsWith(s))) continue
      try {
        Map.prototype.delete.call(loadCache, u)
      } catch {
        loadCache.delete(u)
      }
      purged.push(u)
    }
    return purged
  }

  /** Bump the composition stamp: refresh the stamp comment in agent.cordis.yml. */
  function bumpStamp() {
    const stamp = `${STAMP_PREFIX}${new Date().toISOString()}`
    let text = readFileSync(ymlPath, 'utf8')
    if (text.includes(STAMP_PREFIX)) {
      text = text.replace(/^# cadence-reload-stamp: .*$/m, stamp)
    } else {
      text = `${text.replace(/\s+$/, '')}\n\n${stamp}\n`
    }
    writeFileSync(ymlPath, text, 'utf8')
    return stamp
  }

  ctx.effect(() => ctx.tools.register({
    name: 'cadence_reload',
    description: "Reload this preset's code WITHOUT restarting the harness: verify the .mjs files parse, purge them from Node's ESM cache, then bump the composition stamp so the NEXT NEW session mounts the new code (existing sessions keep the generation they run on). On a verification failure the cache is NOT touched and the stamp is NOT bumped — the running generation is unaffected. Read-only for everything except the stamp comment in agent.cordis.yml.",
    parameters: toJsonSchema({}),
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      try {
        await verifyFresh()
      } catch (error) {
        return `ERROR: 新代码导入失败（语法/加载错误），缓存未触碰、组合戳未更新。运行中的 generation 不受影响。\n`
          + `原因: ${error && error.message ? error.message : String(error)}`
      }
      let purged = []
      try {
        purged = purgeReal()
      } catch (error) {
        return `ERROR: 缓存清除失败：${error && error.message ? error.message : String(error)}`
      }
      let stamp
      try {
        stamp = bumpStamp()
      } catch (error) {
        return `ERROR: 组合戳更新失败：${error && error.message ? error.message : String(error)}`
      }
      return [
        `OK: 新代码已验证可导入，缓存已清除（${purged.length} 个模块条目）。`,
        `组合戳已更新（${stamp}）——下一个【新会话】将挂载新代码；`,
        `已存在的会话继续使用其加入时的 generation。`,
        `验证：新会话中执行 trace_status，build= 行应显示新标记。`,
      ].join('\n')
    },
  }))
}
