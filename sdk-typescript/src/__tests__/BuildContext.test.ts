// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api'
import type { StorageAccessDto } from '@daytona/api-client'
import {
  ObjectStorageApi,
  ObjectStorageApiAxiosParamCreator,
  ObjectStorageApiFactory,
  ObjectStorageApiFp,
} from '@daytona/api-client'
import axios, { AxiosError, AxiosHeaders } from 'axios'
import type { InternalAxiosRequestConfig } from 'axios'
import { Daytona } from '../Daytona'
import { Image } from '../Image'
import { ObjectStorage } from '../ObjectStorage'
import { SnapshotService } from '../Snapshot'
import {
  createAxiosDaytonaError,
  DaytonaAuthenticationError,
  DaytonaConnectionTimeoutError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
} from '../errors/DaytonaError'

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
    const options = { timeout: 5000, headers: { Authorization: marker } }
    const legacy = await creator.getPushAccess('org', options)
    expect(legacy.url).toBe('/object-storage/push-access')
    expect(legacy.options).toMatchObject(options)
    expect((await creator.getPushAccess('org', 'custom', options)).options).toMatchObject(options)
  })

  it('preserves legacy options and regional requests through every public generated interface', async () => {
    const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => ({
      data: access(),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }))
    const http = axios.create({ adapter })
    const options = { timeout: 5000, headers: { Authorization: marker } }
    const interfaces = [
      ObjectStorageApiFactory(undefined, 'https://api.invalid', http),
      new ObjectStorageApi(undefined, 'https://api.invalid', http),
    ]
    for (const api of interfaces) {
      await api.getPushAccess('org', options)
      await api.getPushAccess('org', 'custom', options)
    }
    const fp = ObjectStorageApiFp()
    await (
      await fp.getPushAccess('org', options)
    )(http, 'https://api.invalid')
    await (
      await fp.getPushAccess('org', 'custom', options)
    )(http, 'https://api.invalid')
    expect(adapter).toHaveBeenCalledTimes(6)
    for (const [index, [config]] of adapter.mock.calls.entries()) {
      expect(config.url).toBe(`https://api.invalid/object-storage/push-access${index % 2 ? '?regionId=custom' : ''}`)
      expect(config.timeout).toBe(5000)
      expect(config.headers.get('Authorization')).toBe(marker)
      expect(config.headers.get('X-Daytona-Organization-ID')).toBe('org')
    }
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

  it.each([' ', '\t'])('rejects a blank provider bucket %j without storage or API fallback', async (bucket) => {
    await expect(
      client('custom', async () => ({ ...access(), bucket }) as StorageAccessDto).create({ image: image() }),
    ).rejects.toThrow('must specify a bucket')
    expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
    expect(mockLists).toEqual([])
    expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
  })

  it.each([' ', '\t'])('rejects a blank override region %j before invoking the provider', async (target) => {
    const provider = jest.fn(async () => access())
    await expect(client(target, provider).create({ image: image() })).rejects.toThrow(/region/)
    expect(provider).not.toHaveBeenCalled()
    expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
    expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
  })

  it('skips access for string images and images without local context', async () => {
    const daytona = client('custom')
    for (const value of ['alpine:3.21', Image.base('alpine:3.21')]) {
      await daytona.create({ image: value })
      await daytona.snapshot.create({ name: 'snapshot', image: value })
    }
    expect(mockAccessApi.getPushAccess).not.toHaveBeenCalled()
  })

  it('preserves actionable local file errors during tar upload', async () => {
    const error = Object.assign(new Error(`EACCES: permission denied, open '${__filename}'`), {
      code: 'EACCES',
      path: __filename,
      syscall: 'open',
    })
    jest.spyOn(ObjectStorage.prototype as any, 'uploadAsTar').mockRejectedValue(error)
    const daytona = client('custom')
    await expect(daytona.snapshot.create({ name: 'snapshot', image: image() })).rejects.toBe(error)
    await expect(daytona.create({ image: image() })).rejects.toBe(error)
    expect(mockSnapshotApi.createSnapshot).not.toHaveBeenCalled()
    expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
  })

  it('sanitizes each failure boundary before telemetry without fallback', async () => {
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
      const provider =
        failure === 'provider'
          ? async () => {
              throw new Error(marker)
            }
          : undefined
      const operation = SnapshotService.processImageContext(mockAccessApi as never, image(), provider, 'custom')
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
  })

  it.each(['snapshot', 'sandbox'])('stops %s creation after an upload failure', async (kind) => {
    mockFailure = 'upload'
    const daytona = client('custom')
    await expect(
      kind === 'snapshot'
        ? daytona.snapshot.create({ name: 'snapshot', image: image() })
        : daytona.create({ image: image() }),
    ).rejects.toThrow('Failed to upload build context')
    expect(mockAccessApi.getPushAccess).toHaveBeenCalledTimes(1)
    expect(mockSnapshotApi.createSnapshot).not.toHaveBeenCalled()
    expect(mockSandboxApi.createSandbox).not.toHaveBeenCalled()
  })

  it.each([
    [401, DaytonaAuthenticationError],
    [429, DaytonaRateLimitError],
    [504, DaytonaTimeoutError],
    [undefined, DaytonaConnectionTimeoutError],
  ] as const)('retains safe recovery classification for status %s', async (status, ErrorClass) => {
    const raw = new AxiosError(
      marker,
      status === undefined ? 'ETIMEDOUT' : undefined,
      undefined,
      undefined,
      status === undefined
        ? undefined
        : {
            status,
            data: { message: marker, code: marker, source: marker },
            statusText: marker,
            headers: { Authorization: marker },
            config: { headers: new AxiosHeaders() },
          },
    )
    for (const error of [raw, createAxiosDaytonaError(raw)]) {
      mockAccessApi.getPushAccess.mockRejectedValue(error)
      const safe = await SnapshotService.processImageContext(
        mockAccessApi as never,
        image(),
        undefined,
        'custom',
      ).catch((failure) => failure)
      expect(safe).toBeInstanceOf(ErrorClass)
      expect(safe.statusCode).toBe(status)
      expect(safe.headers).toBeUndefined()
      expect(safe.code).toBeUndefined()
      expect(safe.source).toBeUndefined()
      expect(safe.cause).toBeUndefined()
      expect(`${safe.message}\n${safe.stack}\n${JSON.stringify(safe)}`).not.toContain(marker)
    }
  })
})
