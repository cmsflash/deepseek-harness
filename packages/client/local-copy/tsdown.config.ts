/** Client bundle of the local-copy plugin, with its worker embedded as source. */

import { join } from 'node:path'
import { Rolldown, type UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'])

/**
 * The dynamic client factory has no module URL from which to resolve a Worker file,
 * so the page receives the minified IIFE bundle of `src/client/worker/index.ts`
 * as a string and creates the worker from a Blob URL.
 */
const workerSource: NonNullable<UserConfig['plugins']> = [{
  name: 'dsh-local-copy-worker-source',
  resolveId(source) { return source === './worker/index.ts?raw' ? '\0dsh-local-copy-worker-source' : null },
  async load(id) {
    if (id !== '\0dsh-local-copy-worker-source') return null
    const parent = this
    const worker = await Rolldown.rolldown({
      input: join(import.meta.dirname, 'src/client/worker/index.ts'), platform: 'browser',
      resolve: { mainFields: ['browser', 'module', 'main'], aliasFields: [['browser']] },
      transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
      plugins: [{
        name: 'dsh-local-copy-worker-dependencies',
        async resolveId(source, importer) {
          // The outer build's license analysis must also see imports embedded in Worker text.
          if (importer?.startsWith(join(import.meta.dirname, 'src')) && !source.startsWith('.')) await parent.resolve(source, importer)
          return null
        },
      }],
    })
    try {
      const result = await worker.generate({ format: 'iife', minify: true })
      const chunk = result.output[0]
      if (chunk?.type !== 'chunk') throw new Error('Local copy worker did not emit a JavaScript chunk')
      for (const path of Object.keys(chunk.modules)) this.addWatchFile(path)
      return `export default ${JSON.stringify(chunk.code)};`
    } finally { await worker.close() }
  },
}]

export default (options: Parameters<typeof bundle>[0]): UserConfig[] => bundle(options).map(config =>
  config.name?.endsWith('/client') === true ? {
    ...config,
    plugins: [config.plugins, workerSource],
  } : config,
)
