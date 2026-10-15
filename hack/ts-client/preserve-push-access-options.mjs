// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import fs from 'node:fs'

// Only push-access gained a parameter before its previously exported options slot.
const file = process.argv[2]
const source = fs.readFileSync(file, 'utf8')
const signature = /regionId\?: string(?=[,)])/g
const matches = [...source.matchAll(signature)]
if (matches.length) {
  assert.equal(matches.length, 4, 'Unexpected push-access signatures')
  const boundary = '            const localVarPath = `/object-storage/push-access`;'
  assert.ok(source.includes(boundary), 'Missing push-access parameter creator')
  fs.writeFileSync(
    file,
    source.replace(signature, 'regionId?: string | RawAxiosRequestConfig').replace(
      boundary,
      `            if (typeof regionId === 'object' && regionId !== null) {
                options = regionId;
                regionId = undefined;
            }
${boundary}`,
    ),
  )
}
