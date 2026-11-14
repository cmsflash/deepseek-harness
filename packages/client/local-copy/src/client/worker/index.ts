/** Browser worker entry: the local-copy main bound to the dedicated worker global. */

import { localCopyWorkerMain, type WorkerScope } from './main.ts'

const scope: WorkerScope = {
  postMessage: (message) => { globalThis.postMessage(message) },
  onmessage: null,
  indexedDB: globalThis.indexedDB,
  keyRange: globalThis.IDBKeyRange,
  fetch: (input, init) => globalThis.fetch(input, init),
  locks: globalThis.navigator.locks,
  onLine: () => navigator.onLine,
}
localCopyWorkerMain(scope)
globalThis.onmessage = (event) => { scope.onmessage?.(event) }
