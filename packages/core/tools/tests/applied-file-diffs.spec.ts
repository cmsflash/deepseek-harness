/**
 * The shared reading of a settled file mutation: which diffs one persisted
 * `tool/call` + `tool/result` record applied, and how many lines each moved.
 * Host digests and the browser's collapsed-step fold both read through it, so
 * a rule proved here holds for both figures.
 */
import { describe, expect, it } from 'vitest'
import { appliedFileDiffs, fileDiffLineDelta, type SettledToolCallRecord } from '../src/presentation.ts'

function write(content: string, over: Partial<SettledToolCallRecord> = {}): SettledToolCallRecord {
  return {
    name: 'write',
    argumentsRaw: JSON.stringify({ file_path: 'a.ts', content }),
    isError: false,
    meta: undefined,
    ...over,
  }
}

describe('appliedFileDiffs', () => {
  it('reads the applied hunks a successful result persisted', () => {
    const diffs = [{ path: 'a.ts', oldText: 'x\n', newText: 'x\ny\n' }, { path: 'a.ts', oldText: 'p\n', newText: 'q\n' }]
    expect(appliedFileDiffs({ name: 'edit', argumentsRaw: '{}', isError: false, meta: { diffs } })).toEqual(diffs)
  })

  it('applies nothing for a failed call, whatever its metadata claims', () => {
    const diffs = [{ path: 'a.ts', oldText: null, newText: 'x\n' }]
    expect(appliedFileDiffs(write('x\n', { isError: true, meta: { diffs } }))).toEqual([])
  })

  it('falls back to a write\'s whole content when its result persisted no hunk', () => {
    // A create: the tool persists `diffs: []` because there is no before-image.
    expect(appliedFileDiffs(write('one\ntwo\n', { meta: { diffs: [] } })))
      .toEqual([{ path: 'a.ts', oldText: null, newText: 'one\ntwo\n' }])
    // A result with no metadata at all reads the same way.
    expect(appliedFileDiffs(write('one\n'))).toEqual([{ path: 'a.ts', oldText: null, newText: 'one\n' }])
  })

  it('applies nothing for an edit with empty, absent, or malformed metadata', () => {
    for (const meta of [undefined, null, 'nope', [], { diffs: [] }, { diffs: 'x' }, { diffs: [{ path: 1 }] }, { diffs: [{ path: 'a', oldText: 2, newText: '' }] }]) {
      expect(appliedFileDiffs({ name: 'edit', argumentsRaw: '{"file_path":"a.ts"}', isError: false, meta })).toEqual([])
    }
  })

  it('rejects the whole metadata list when one hunk is malformed', () => {
    const meta = { diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }, { path: 7 }] }
    // The write fallback still applies: the call succeeded and names its content.
    expect(appliedFileDiffs(write('x', { meta }))).toEqual([{ path: 'a.ts', oldText: null, newText: 'x' }])
    expect(appliedFileDiffs({ name: 'edit', argumentsRaw: '{}', isError: false, meta })).toEqual([])
  })

  it('needs a write head with a path and string content for the fallback', () => {
    expect(appliedFileDiffs(write('x', { name: null, argumentsRaw: null }))).toEqual([])
    expect(appliedFileDiffs(write('x', { argumentsRaw: 'not json' }))).toEqual([])
    expect(appliedFileDiffs(write('x', { argumentsRaw: '[]' }))).toEqual([])
    expect(appliedFileDiffs(write('x', { argumentsRaw: JSON.stringify({ file_path: ' ', content: 'x' }) }))).toEqual([])
    expect(appliedFileDiffs(write('x', { argumentsRaw: JSON.stringify({ file_path: 'a.ts', content: 3 }) }))).toEqual([])
    expect(appliedFileDiffs(write('x', { name: 'bash' }))).toEqual([])
  })
})

describe('fileDiffLineDelta', () => {
  it('counts a created file as all additions', () => {
    expect(fileDiffLineDelta({ oldText: null, newText: 'one\ntwo\n' })).toEqual({ added: 2, removed: 0 })
  })

  it('counts a modified line as one addition and one removal', () => {
    expect(fileDiffLineDelta({ oldText: 'one\ntwo\n', newText: 'one\nTWO\n' })).toEqual({ added: 1, removed: 1 })
  })

  it('treats a reordered line as unchanged', () => {
    expect(fileDiffLineDelta({ oldText: 'one\ntwo\n', newText: 'two\none\n' })).toEqual({ added: 0, removed: 0 })
  })

  it('ignores a terminating newline on either side', () => {
    expect(fileDiffLineDelta({ oldText: 'one', newText: 'one\n' })).toEqual({ added: 0, removed: 0 })
    expect(fileDiffLineDelta({ oldText: 'one\n', newText: 'one' })).toEqual({ added: 0, removed: 0 })
  })

  it('distinguishes an empty file from an empty content line', () => {
    expect(fileDiffLineDelta({ oldText: null, newText: '' })).toEqual({ added: 0, removed: 0 })
    expect(fileDiffLineDelta({ oldText: null, newText: '\n' })).toEqual({ added: 1, removed: 0 })
    expect(fileDiffLineDelta({ oldText: '\n', newText: '' })).toEqual({ added: 0, removed: 1 })
    expect(fileDiffLineDelta({ oldText: 'a\n\n', newText: 'a\n' })).toEqual({ added: 0, removed: 1 })
  })

  it('cancels the context lines an applied hunk repeats on both sides', () => {
    expect(fileDiffLineDelta({ oldText: 'a\nb\nc\nd\n', newText: 'a\nb\nX\nd\n' })).toEqual({ added: 1, removed: 1 })
  })
})
