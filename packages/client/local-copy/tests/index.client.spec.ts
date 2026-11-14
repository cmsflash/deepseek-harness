/** The node-half entry: an empty apply so the Loader registers it everywhere (§4.0). */

// @vitest-environment jsdom
import { describe, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('local copy node half', () => {
  it('registers nothing on the GUI process', () => {
    apply()
  })
})
