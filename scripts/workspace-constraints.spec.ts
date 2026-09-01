import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GENERATED_REMOTE_RUNTIME_DEPENDENCIES,
  generatedRemoteDependencyErrors,
} from './check-workspace-constraints.ts'

const root = join(import.meta.dirname, '..')

/** A manifest exporting the canonical generated `./remote` pair. */
function remoteManifest(dependencies: Record<string, string>) {
  return {
    name: '@deepseek-ai/dsh-fixture',
    exports: {
      './remote': {
        types: './lib/typert.remote-client.d.ts',
        default: './lib/typert.remote-client.js',
      },
    },
    dependencies,
  }
}

/** Every workspace package that exports a generated `./remote` artifact. */
function remotePackageDirectories(): string[] {
  return [
    'packages/extensions/cordis-host-runner',
    'packages/feedback/message-feedback',
    'packages/goal/goal',
    'packages/host/plugin-inventory',
    'packages/interaction/commands',
    'packages/tts/read-aloud',
  ]
}

describe('generated remote dependency policy', () => {
  it('rejects a remote package that omits a runtime dependency the artifact imports', () => {
    const errors = generatedRemoteDependencyErrors(remoteManifest({}), '@deepseek-ai/dsh-fixture')
    expect(errors).toHaveLength(GENERATED_REMOTE_RUNTIME_DEPENDENCIES.length)
    expect(errors[0]).toContain('must declare "zod" in dependencies')
  })

  it('accepts a remote package that declares every one', () => {
    expect(generatedRemoteDependencyErrors(remoteManifest({ zod: '^4.4.3' }), 'pkg')).toEqual([])
  })

  it('ignores a package that exports no generated remote', () => {
    const manifest = { name: 'plain', exports: { '.': './lib/index.js' }, dependencies: {} }
    expect(generatedRemoteDependencyErrors(manifest, 'plain')).toEqual([])
  })

  it('ignores a `./remote` export that is not the generated pair', () => {
    const manifest = {
      name: 'hand-written',
      exports: { './remote': { types: './lib/other.d.ts', default: './lib/other.js' } },
      dependencies: {},
    }
    expect(generatedRemoteDependencyErrors(manifest, 'hand-written')).toEqual([])
  })

  it('holds for every shipped remote package', () => {
    for (const directory of remotePackageDirectories()) {
      const manifest: unknown = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))
      expect(generatedRemoteDependencyErrors(manifest as never, directory)).toEqual([])
    }
  })
})
