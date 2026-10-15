// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api'
import type { StorageAccessDto } from '@daytona/api-client'
import { ObjectStorageApiAxiosParamCreator } from '@daytona/api-client'
import { Daytona } from '../Daytona'
import { Image } from '../Image'
import { ObjectStorage } from '../ObjectStorage'

const mockAccessApi = { getPushAccess: jest.fn() }
const mockSnapshotApi = { createSnapshot: jest.fn() }
const mockSandboxApi = { createSandbox: jest.fn() }
const mockObjects = new Set<string>()
const mockLists: Array<{ Bucket: string; Prefix: string }> = []
const mockWrites: Array<{ Bucket: string; Key: string }> = []
let mockFailure: 'list' | 'upload' | 'initialize' | undefined
const marker = 'credential-text-must-not-reach-telemetry'

jest.mock('../Sandbox', () => ({ Sandbox: jest.fn((dto) => dto) }))
jest.mock('../utils/EventDispatcher', () => ({ EventDispatcher: jest.fn(() => ({ ensureConnected: jest.fn() })) }))
jest.mock('../utils/EventSubscriptionManager', () => ({ EventSubscriptionManager: jest.fn() }))
jest.mock('../utils/Runtime', () => ({
  ...jest.requireActual('../utils/Runtime'),
  DaytonaEnvReader: class {
    get(name: string) {
      return process.env[name]
    }
    getFromProcessEnv(name: string) {
      return process.env[name]
    }
    getFromFile() {
      return undefined
    }
  },
  findDotenvFileDefiningEndpoint: () => undefined,
}))
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor() {
      if (mockFailure === 'initialize') throw new Error('credential-text-must-not-reach-telemetry')
    }
    async send(command: { input: { Bucket: string; Prefix: string } }) {
      if (mockFailure === 'list') {
        throw Object.assign(new Error('credential-text-must-not-reach-telemetry'), {
          code: 'ENOTFOUND',
          syscall: 'getaddrinfo',
        })
      }
      mockLists.push(command.input)
      return {
        Contents: [...mockObjects].filter((key) => key.startsWith(`${command.input.Bucket}/${command.input.Prefix}`)),
      }
    }
  },
  ListObjectsV2Command: class {
    constructor(public input: { Bucket: string; Prefix: string }) {}
  },
}))
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private options: { params: { Bucket: string; Key: string; Body: AsyncIterable<Buffer> } }) {}
    async done() {
      const { Bucket, Key, Body } = this.options.params
      const chunks: Buffer[] = []
      for await (const chunk of Body) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toContain('Offline build-context regression fixture.')
      if (mockFailure === 'upload') throw new Error('credential-text-must-not-reach-telemetry')
      mockObjects.add(`${Bucket}/${Key}`)
      mockWrites.push({ Bucket, Key })
    }
  },
}))
jest.mock('../utils/Import', () => ({
  ...jest.requireActual('../utils/Import'),
  dynamicImport: async (name: string) => {
    if (name === 'ObjectStorage') return require('../ObjectStorage')
    if (['fs', 'stream', 'tar'].includes(name)) return require(name)
    throw new Error(`Unexpected import: ${name}`)
  },
}))

const access = (bucket = 'customer-bucket'): StorageAccessDto => ({
  bucket,
  organizationId: 'org',
  storageUrl: 'https://storage.invalid',
  region: 'us-east-1',
  accessKey: 'fake-key',
  secret: marker,
  sessionToken: 'fake-session',
})
const image = () => Image.base('alpine:3.21').dockerfileCommands(['COPY build-context.txt /context.txt'], __dirname)
const client = (target?: string, provider?: (regionId: string) => Promise<StorageAccessDto>) => {
  const daytona = new Daytona({
    apiKey: 'fake',
    apiUrl: 'https://api.invalid',
    target,
    getBuildContextUploadAccess: provider,
  })
  Object.assign(daytona, { objectStorageApi: mockAccessApi, sandboxApi: mockSandboxApi })
  Object.assign(daytona.snapshot, { objectStorageApi: mockAccessApi, snapshotsApi: mockSnapshotApi })
  return daytona
}

describe('region-aware build-context uploads', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.DAYTONA_TARGET
    mockObjects.clear()
    mockLists.length = 0
    mockWrites.length = 0
    mockFailure = undefined
    mockAccessApi.getPushAccess.mockImplementation(async (_org, regionId) => ({
      data: access(`${regionId ?? 'hosted'}-bucket`),
    }))
    mockSnapshotApi.createSnapshot.mockResolvedValue({ data: { id: 'snapshot', state: 'active' } })
    mockSandboxApi.createSandbox.mockResolvedValue({
      data: {
        id: 'sandbox',
        state: 'started',
        labels: {},
        toolboxProxyUrl: 'https://toolbox.invalid',
      },
    })
  })
  afterEach(() => jest.restoreAllMocks())

  it('serializes region as a query, preserving the organization header and omitted-region behavior', async () => {
    const creator = ObjectStorageApiAxiosParamCreator()
    const request = await creator.getPushAccess('org', 'region with spaces')
    expect(request.url).toBe('/object-storage/push-access?regionId=region+with+spaces')
    expect(request.options.headers).toMatchObject({ 'X-Daytona-Organization-ID': 'org' })
    expect((await creator.getPushAccess()).url).toBe('/object-storage/push-access')
  })

  it.each(['snapshot', 'sandbox'])(
    'forwards a configured/default/missing region for %s and omits credentials from metadata',
    async (kind) => {
      for (const target of ['custom-region', undefined]) {
        const daytona = client(target)
        if (kind === 'snapshot') await daytona.snapshot.create({ name: 'snapshot', image: image() })
        else await daytona.create({ image: image() })
        expect(mockAccessApi.getPushAccess).toHaveBeenLastCalledWith(undefined, target)
        const api = kind === 'snapshot' ? mockSnapshotApi.createSnapshot : mockSandboxApi.createSandbox
        const payload = api.mock.calls[api.mock.calls.length - 1][0]
        expect(payload[kind === 'snapshot' ? 'regionId' : 'target']).toBe(target)
        const serialized = JSON.stringify(payload)
        for (const forbidden of [
          marker,
          'fake-key',
          'fake-session',
          'storageUrl',
          '-bucket',
          'getBuildContextUploadAccess',
        ]) {
          expect(serialized).not.toContain(forbidden)
        }
      }
    },
  )

  it('uses DAYTONA_TARGET and a snapshot override, captured before access awaits', async () => {
    process.env.DAYTONA_TARGET = 'env-region'
    const daytona = client()
    await daytona.create({ image: image() })
    expect(mockAccessApi.getPushAccess).toHaveBeenLastCalledWith(undefined, 'env-region')
    const params = { name: 'snapshot', image: image(), regionId: 'override' }
    mockAccessApi.getPushAccess.mockImplementation(async () => {
      params.regionId = 'mutated'
      return { data: access() }
    })
    await daytona.snapshot.create(params)
    expect(mockAccessApi.getPushAccess).toHaveBeenLastCalledWith(undefined, 'override')
    expect(mockSnapshotApi.createSnapshot.mock.calls[0][0].regionId).toBe('override')
    delete process.env.DAYTONA_TARGET
  })

  it('captures the sandbox target before upload, even if the client is mutated', async () => {
    const daytona = client('original')
    mockAccessApi.getPushAccess.mockImplementation(async () => {
      Object.assign(daytona, { target: 'mutated' })
      return { data: access() }
    })
    await daytona.create({ image: image() })
    expect(mockAccessApi.getPushAccess).toHaveBeenCalledWith(undefined, 'original')
    expect(mockSandboxApi.createSandbox.mock.calls[0][0].target).toBe('original')
  })

  it('probes each selected bucket for identical hashes instead of using a global hash cache', async () => {
    for (const target of ['a', 'b', 'a']) await client(target).snapshot.create({ name: 'snapshot', image: image() })
    expect(mockWrites.map(({ Bucket }) => Bucket)).toEqual(['a-bucket', 'b-bucket'])
    expect(mockWrites[0].Key).toBe(mockWrites[1].Key)
    expect(mockWrites[0].Key).toMatch(/^org\/[a-f0-9]+\/context.tar$/)
    expect(mockLists.map(({ Bucket }) => Bucket)).toEqual(['a-bucket', 'b-bucket', 'a-bucket'])
  })

  it.each(['snapshot', 'sandbox'])('keeps the advanced override optional and exclusive for %s', async (kind) => {
    const provider = jest.fn(async () => access())
    const daytona = client('custom', provider)
    if (kind === 'snapshot') await daytona.snapshot.create({ name: 'snapshot', image: image(), regionId: 'override' })
    else await daytona.create({ image: image() })
    expect(provider).toHaveBeenCalledWith(kind === 'snapshot' ? 'override' : 'custom')
    expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
  })

  it.each([undefined, '', ' ', '\t'])(
    'rejects an empty provider bucket %j without storage or API fallback',
    async (bucket) => {
      await expect(
        client('custom', async () => ({ ...access(), bucket }) as StorageAccessDto).create({ image: image() }),
      ).rejects.toThrow('must specify a bucket')
      expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
      expect(mockLists).toEqual([])
      expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, '', ' ', '\t'])(
    'rejects a missing/blank override region %j before invoking the provider',
    async (target) => {
      const provider = jest.fn(async () => access())
      await expect(client(target, provider).create({ image: image() })).rejects.toThrow(/region/)
      expect(provider).not.toHaveBeenCalled()
      expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
      expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
    },
  )

  it('skips access for string images and images without local context', async () => {
    const daytona = client('custom')
    for (const value of ['alpine:3.21', Image.base('alpine:3.21')]) {
      await daytona.create({ image: value })
      await daytona.snapshot.create({ name: 'snapshot', image: value })
    }
    expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
  })

  it.each(['computeHashForPathMd5', 'uploadAsTar'])(
    'preserves actionable local file errors from %s',
    async (method) => {
      const error = Object.assign(new Error(`EACCES: permission denied, open '${__filename}'`), {
        code: 'EACCES',
        path: __filename,
        syscall: 'open',
      })
      jest.spyOn(ObjectStorage.prototype as any, method).mockRejectedValue(error)
      const daytona = client('custom')
      await expect(daytona.snapshot.create({ name: 'snapshot', image: image() })).rejects.toBe(error)
      await expect(daytona.create({ image: image() })).rejects.toBe(error)
      expect(mockSnapshotApi.createSnapshot).not.toHaveBeenCalled()
      expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
    },
  )

  it.each(['snapshot', 'sandbox'])(
    'sanitizes provider/API/list/upload failures before %s telemetry without fallback',
    async (kind) => {
      const spans: Array<{ setStatus: jest.Mock; recordException: jest.Mock; end: jest.Mock }> = []
      jest.spyOn(trace, 'getTracer').mockReturnValue({
        startSpan: () => {
          const span = { setStatus: jest.fn(), recordException: jest.fn(), end: jest.fn() }
          spans.push(span)
          return span
        },
      } as never)
      for (const failure of ['provider', 'api', 'initialize', 'list', 'upload'] as const) {
        jest.clearAllMocks()
        spans.length = 0
        mockObjects.clear()
        mockFailure = failure === 'list' || failure === 'upload' || failure === 'initialize' ? failure : undefined
        mockAccessApi.getPushAccess.mockImplementation(async () => {
          if (failure === 'api') throw new Error(marker)
          return { data: access() }
        })
        const daytona = client(
          'custom',
          failure === 'provider'
            ? async () => {
                throw new Error(marker)
              }
            : undefined,
        )
        const operation =
          kind === 'snapshot'
            ? daytona.snapshot.create({ name: 'snapshot', image: image() })
            : daytona.create({ image: image() })
        await expect(operation).rejects.toThrow(
          failure === 'provider' || failure === 'api'
            ? 'Failed to obtain build-context upload access'
            : failure === 'initialize'
              ? 'Failed to initialize build-context storage'
              : 'Failed to upload build context to object storage',
        )
        expect(mockAccessApi.getPushAccess).toHaveBeenCalledTimes(failure === 'provider' ? 0 : 1)
        expect(mockSnapshotApi.createSnapshot).not.toHaveBeenCalled()
        expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
        const recorded = spans.flatMap((span) => [
          ...span.setStatus.mock.calls.map(([status]) => status.message),
          ...span.recordException.mock.calls.map(([error]) => `${error.message}\n${error.stack}\n${error.cause}`),
        ])
        expect(recorded.length).toBeGreaterThan(0)
        expect(recorded.join('\n')).not.toContain(marker)
      }
    },
  )
})
