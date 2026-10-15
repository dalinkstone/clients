// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import fs from 'node:fs'

// Keep every legacy positional request option; the new region is keyword-only.
const file = process.argv[2]
const source = fs.readFileSync(file, 'utf8')
let count = 0
let output = source.replace(
  /((?:async )?def get_push_access(?:_with_http_info|_without_preload_content)?\([\s\S]*?)(        region_id:[^\n]*\n)([\s\S]*?)(    \) ->)/g,
  (_match, before, region, after, end) => {
    if (before.endsWith('        *,\n')) return _match
    count++
    return `${before}${after}        *,\n${region}${end}`
  },
)
if (count) assert.equal(count, 3, 'Unexpected push-access signatures')
output = output.replace(/[\t ]+$/gm, '').trimEnd() + '\n\n'
if (output !== source) fs.writeFileSync(file, output)
