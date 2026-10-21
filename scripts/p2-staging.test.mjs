import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateStagingTarget } from './p2-staging.mjs'

const daily = 'aaaaaaaaaaaaaaaaaaaa'
const staging = 'bbbbbbbbbbbbbbbbbbbb'
const config = { P2_STAGING_PROJECT_REF: staging, P2_STAGING_DISPOSABLE: 'true' }

test('rejects the daily database even if explicitly labeled disposable', () => {
  assert.throws(
    () => validateStagingTarget({ ...config, P2_STAGING_PROJECT_REF: daily }, new Set([daily])),
    /daily project/,
  )
})
test('rejects unknown protection context instead of guessing the daily target', () => {
  assert.throws(() => validateStagingTarget(config, new Set()), /Cannot identify/)
})
test('rejects absent, malformed and URL-shaped project references', () => {
  for (const value of ['', 'tin-p2-staging', `https://${staging}.supabase.co`, '../daily'])
    assert.throws(
      () => validateStagingTarget({ ...config, P2_STAGING_PROJECT_REF: value }, new Set([daily])),
      /20-character/,
    )
})
test('requires an explicit disposable target', () => {
  assert.throws(
    () => validateStagingTarget({ P2_STAGING_PROJECT_REF: staging }, new Set([daily])),
    /DISPOSABLE/,
  )
})
test('accepts a distinct staging reference and trims surrounding whitespace', () => {
  assert.equal(
    validateStagingTarget({ ...config, P2_STAGING_PROJECT_REF: ` ${staging} ` }, new Set([daily])),
    staging,
  )
})
