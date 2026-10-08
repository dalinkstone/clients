// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Configuration } from '@daytona/api-client'
import { createApiResponse } from './helpers'
import { SnapshotService } from '../Snapshot'
import type { BuildContextStorageConfig } from '../index'
import { Image } from '../Image'
import { DaytonaForbiddenError, DaytonaInvalidArgumentError, DaytonaNotFoundError } from '../errors/DaytonaError'

const mockProcessStreamingResponse = jest.fn()
const mockDynamicImport = jest.fn()

jest.mock(
  '@daytona/api-client',
  () => ({
    SnapshotState: {
      ACTIVE: 'active',
      ERROR: 'error',
      BUILD_FAILED: 'build_failed',
      PENDING: 'pending',
    },
  }),
  { virtual: true },
)

jest.mock('../utils/Stream', () => ({
  processStreamingResponse: (...args: unknown[]) => mockProcessStreamingResponse(...args),
}))

jest.mock('../utils/Import', () => ({
  dynamicImport: (...args: unknown[]) => mockDynamicImport(...args),
}))

describe('SnapshotService', () => {
  const cfg: Configuration = {
    basePath: 'http://api',
    baseOptions: { headers: { Authorization: 'Bearer token' } },
  } as unknown as Configuration

  const snapshotsApi = {
    getAllSnapshots: jest.fn(),
    getSnapshot: jest.fn(),
    removeSnapshot: jest.fn(),
    createSnapshot: jest.fn(),
    getSnapshotBuildLogsUrl: jest.fn(),
    activateSnapshot: jest.fn(),
  }
  const objectStorageApi = {
    getPushAccess: jest.fn(),
  }

  const service = new SnapshotService(cfg, snapshotsApi as unknown as never, objectStorageApi as unknown as never, 'eu')
  const storage: BuildContextStorageConfig = {
    regionId: 'customer-region',
    organizationId: 'org-1',
    endpointUrl: 'https://s3.us-east-1.amazonaws.com',
    bucketName: 'customer-build-contexts',
    region: 'us-east-1',
    accessKeyId: 'customer-key',
    secretAccessKey: 'customer-secret',
    sessionToken: 'customer-session',
  }

  const contextImage = () => {
    const image = Image.base('node:24-bookworm-slim')
    image.contextList.push(
      { sourcePath: '/tmp/file.txt', archivePath: 'file.txt' },
      { sourcePath: '/tmp/src', archivePath: 'src' },
    )
    return image
  }

  const customerService = () =>
    new SnapshotService(cfg, snapshotsApi as never, objectStorageApi as never, storage.regionId, storage, 'org-1')

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    mockDynamicImport.mockReset()
  })

  it('lists/gets/deletes snapshots', async () => {
    snapshotsApi.getAllSnapshots.mockResolvedValue(
      createApiResponse({ items: [{ id: 's1', name: 'snap1' }], total: 1, page: 1, totalPages: 1 }),
    )
    snapshotsApi.getSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snap1' }))
    snapshotsApi.removeSnapshot.mockResolvedValue(createApiResponse(undefined))

    await expect(service.list(1, 10)).resolves.toEqual({
      items: [{ id: 's1', name: 'snap1' }],
      total: 1,
      page: 1,
      totalPages: 1,
    })
    expect(snapshotsApi.getAllSnapshots).toHaveBeenCalledWith(undefined, 1, 10, undefined, undefined)
    await expect(service.get('snap1')).resolves.toEqual({ id: 's1', name: 'snap1' })
    await service.delete({ id: 's1' } as never)
  })

  it('lists snapshots with a query object including sourceSandboxId', async () => {
    snapshotsApi.getAllSnapshots.mockResolvedValue(
      createApiResponse({ items: [{ id: 's1', name: 'snap1' }], total: 1, page: 1, totalPages: 1 }),
    )

    await expect(service.list({ page: 2, limit: 5, sourceSandboxId: 'sandbox-1' })).resolves.toEqual({
      items: [{ id: 's1', name: 'snap1' }],
      total: 1,
      page: 1,
      totalPages: 1,
    })
    expect(snapshotsApi.getAllSnapshots).toHaveBeenCalledWith(undefined, 2, 5, undefined, 'sandbox-1')
  })

  it('deletes snapshot by name with a single resolution call', async () => {
    snapshotsApi.getSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snap1' }))
    snapshotsApi.removeSnapshot.mockResolvedValue(createApiResponse(undefined))

    await service.delete('snap1')

    expect(snapshotsApi.getSnapshot).toHaveBeenCalledTimes(1)
    expect(snapshotsApi.getSnapshot).toHaveBeenCalledWith('snap1')
    expect(snapshotsApi.removeSnapshot).toHaveBeenCalledTimes(1)
    expect(snapshotsApi.removeSnapshot).toHaveBeenCalledWith('s1')
  })

  it('deletes snapshot by UUID id without resolution', async () => {
    const id = '9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa'
    snapshotsApi.removeSnapshot.mockResolvedValue(createApiResponse(undefined))

    await service.delete(id)

    expect(snapshotsApi.getSnapshot).not.toHaveBeenCalled()
    expect(snapshotsApi.removeSnapshot).toHaveBeenCalledTimes(1)
    expect(snapshotsApi.removeSnapshot).toHaveBeenCalledWith(id)
  })

  it('falls back to name resolution when UUID-formatted name is not an id', async () => {
    const uuidName = '9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa'
    snapshotsApi.removeSnapshot
      .mockRejectedValueOnce(new DaytonaNotFoundError('not found'))
      .mockResolvedValueOnce(createApiResponse(undefined))
    snapshotsApi.getSnapshot.mockResolvedValue(createApiResponse({ id: 'real-id', name: uuidName }))

    await service.delete(uuidName)

    expect(snapshotsApi.removeSnapshot).toHaveBeenNthCalledWith(1, uuidName)
    expect(snapshotsApi.getSnapshot).toHaveBeenCalledWith(uuidName)
    expect(snapshotsApi.removeSnapshot).toHaveBeenNthCalledWith(2, 'real-id')
  })

  it('propagates non-404 errors from delete by UUID without resolution', async () => {
    const id = '9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa'
    snapshotsApi.removeSnapshot.mockRejectedValue(new DaytonaForbiddenError('forbidden'))

    await expect(service.delete(id)).rejects.toThrow('forbidden')
    expect(snapshotsApi.getSnapshot).not.toHaveBeenCalled()
    expect(snapshotsApi.removeSnapshot).toHaveBeenCalledTimes(1)
  })

  it('creates snapshot from image name with resources and region', async () => {
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse({ id: 's2', name: 'snap2', state: 'active' }))

    const snapshot = await service.create({
      name: 'snap2',
      image: 'python:3.12',
      resources: { cpu: 4, memory: 8 },
      entrypoint: ['python', 'main.py'],
    })

    expect(snapshot).toEqual({ id: 's2', name: 'snap2', state: 'active' })
    expect(snapshotsApi.createSnapshot).toHaveBeenCalled()
  })

  it('passes timeout values in milliseconds to snapshot creation', async () => {
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse({ id: 's2', name: 'snap2', state: 'active' }))

    await service.create({ name: 'snap2', image: 'python:3.12' }, { timeout: 12 })

    expect(snapshotsApi.createSnapshot).toHaveBeenCalledWith(expect.any(Object), undefined, { timeout: 12000 })
  })

  it('creates snapshot from declarative image using processImageContext', async () => {
    const contextSpy = jest.spyOn(SnapshotService, 'processImageContext').mockResolvedValue(['hash1'])
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse({ id: 's3', name: 'snap3', state: 'active' }))

    const image = Image.base('python:3.12').runCommands('echo hi')
    const snapshot = await service.create({ name: 'snap3', image })

    expect(snapshot.id).toBe('s3')
    expect(contextSpy).toHaveBeenCalled()
  })

  it('throws when the api returns no created snapshot', async () => {
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse(undefined))

    await expect(service.create({ name: 'snap-missing', image: 'python:3.12' })).rejects.toThrow(
      "Failed to create snapshot. Didn't receive a snapshot from the server API.",
    )
  })

  it('throws when terminal snapshot states indicate failure', async () => {
    snapshotsApi.createSnapshot.mockResolvedValue(
      createApiResponse({ id: 's4', name: 'snap4', state: 'error', errorReason: 'build failed' }),
    )

    await expect(service.create({ name: 'snap4', image: 'python:3.12' })).rejects.toThrow(
      'Failed to create snapshot. Name: snap4 Reason: build failed',
    )
  })

  it('returns empty context hashes when an image has no context files', async () => {
    await expect(
      SnapshotService.processImageContext(objectStorageApi as never, Image.base('python:3.12')),
    ).resolves.toEqual([])
  })

  it('uploads image contexts through object storage push credentials', async () => {
    const upload = jest.fn().mockResolvedValue('ctx-hash')
    const ObjectStorage = jest.fn().mockImplementation(() => ({ upload }))
    objectStorageApi.getPushAccess.mockResolvedValue(
      createApiResponse({
        storageUrl: 'https://s3.us-east-1.amazonaws.com',
        accessKey: 'key',
        secret: 'secret',
        sessionToken: 'session',
        bucket: 'bucket',
        organizationId: 'org-1',
        region: 'us-east-2',
      }),
    )
    mockDynamicImport.mockResolvedValue({ ObjectStorage })

    const image = Image.base('python:3.12')
    ;(image as unknown as { _contextList: Array<{ sourcePath: string; archivePath: string }> })._contextList = [
      { sourcePath: '/tmp/context', archivePath: '.' },
    ]

    await expect(SnapshotService.processImageContext(objectStorageApi as never, image)).resolves.toEqual(['ctx-hash'])
    expect(objectStorageApi.getPushAccess).toHaveBeenCalledTimes(1)
    expect(ObjectStorage).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-2' }), false)
    expect(upload).toHaveBeenCalledWith('/tmp/context', 'org-1', '.')
  })

  it('uploads snapshot contexts to customer storage without sending its descriptor to the API', async () => {
    const upload = jest.fn().mockResolvedValueOnce('file-hash').mockResolvedValueOnce('src-hash')
    const ObjectStorage = jest.fn().mockImplementation(() => ({ upload }))
    mockDynamicImport.mockResolvedValue({ ObjectStorage })
    snapshotsApi.createSnapshot.mockResolvedValue(
      createApiResponse({ id: 's1', name: 'customer-snapshot', state: 'active' }),
    )
    const image = contextImage()

    await customerService().create({ name: 'customer-snapshot', image })

    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
    expect(ObjectStorage).toHaveBeenCalledWith(
      {
        endpointUrl: storage.endpointUrl,
        bucketName: storage.bucketName,
        region: storage.region,
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
        sessionToken: storage.sessionToken,
      },
      true,
    )
    expect(upload).toHaveBeenNthCalledWith(1, '/tmp/file.txt', 'org-1', 'file.txt')
    expect(upload).toHaveBeenNthCalledWith(2, '/tmp/src', 'org-1', 'src')
    expect(snapshotsApi.createSnapshot).toHaveBeenCalledWith(
      {
        name: 'customer-snapshot',
        regionId: storage.regionId,
        sandboxClass: undefined,
        buildInfo: { dockerfileContent: image.dockerfile, contextHashes: ['file-hash', 'src-hash'] },
      },
      undefined,
      { timeout: 0 },
    )
    expect(upload.mock.invocationCallOrder[1]).toBeLessThan(snapshotsApi.createSnapshot.mock.invocationCallOrder[0])
  })

  it('supports an explicit matching snapshot region without a client default', async () => {
    mockDynamicImport.mockResolvedValue({
      ObjectStorage: jest.fn(() => ({ upload: jest.fn().mockResolvedValue('hash') })),
    })
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snapshot', state: 'active' }))
    const customer = new SnapshotService(cfg, snapshotsApi as never, objectStorageApi as never, undefined, storage)

    await customer.create({ name: 'snapshot', image: contextImage(), regionId: storage.regionId })

    expect(snapshotsApi.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: storage.regionId }),
      undefined,
      { timeout: 0 },
    )
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it('captures the storage descriptor before an asynchronous import', async () => {
    const ObjectStorage = jest.fn(() => ({ upload: jest.fn().mockResolvedValue('hash') }))
    mockDynamicImport.mockResolvedValue({ ObjectStorage })
    const mutableStorage = { ...storage }

    const processing = SnapshotService.processImageContext(
      objectStorageApi as never,
      contextImage(),
      mutableStorage,
      storage.regionId,
      storage.organizationId,
    )
    mutableStorage.endpointUrl = 'http://changed.example.com'
    mutableStorage.organizationId = 'another-org'
    mutableStorage.bucketName = 'another-bucket'
    await processing

    expect(ObjectStorage).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: storage.endpointUrl, bucketName: storage.bucketName }),
      true,
    )
    const upload = ObjectStorage.mock.results[0].value.upload
    expect(upload).toHaveBeenCalledWith('/tmp/file.txt', storage.organizationId, 'file.txt')
  })

  it('uses the same captured snapshot region for upload and metadata creation', async () => {
    mockDynamicImport.mockResolvedValue({
      ObjectStorage: jest.fn(() => ({ upload: jest.fn().mockResolvedValue('hash') })),
    })
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snapshot', state: 'active' }))
    const params = { name: 'snapshot', image: contextImage(), regionId: storage.regionId }

    const creation = customerService().create(params)
    params.regionId = 'another-region'
    await creation

    expect(snapshotsApi.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: storage.regionId }),
      undefined,
      { timeout: 0 },
    )
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it('rejects a snapshot region override before uploading or creating metadata', async () => {
    await expect(
      customerService().create({ name: 'snapshot', image: contextImage(), regionId: 'another-region' }),
    ).rejects.toThrow(DaytonaInvalidArgumentError)

    expect(mockDynamicImport).not.toHaveBeenCalled()
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
    expect(snapshotsApi.createSnapshot).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'another-region'])('requires an explicit matching upload target: %s', async (regionId) => {
    await expect(
      SnapshotService.processImageContext(objectStorageApi as never, contextImage(), storage, regionId),
    ).rejects.toThrow('Build context storage requires an explicit matching Daytona target')

    expect(mockDynamicImport).not.toHaveBeenCalled()
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it('rejects a known organization mismatch before uploading', async () => {
    await expect(
      SnapshotService.processImageContext(
        objectStorageApi as never,
        contextImage(),
        storage,
        storage.regionId,
        'org-2',
      ),
    ).rejects.toThrow('Build context storage organization does not match authentication')

    expect(mockDynamicImport).not.toHaveBeenCalled()
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it.each([
    'regionId',
    'organizationId',
    'endpointUrl',
    'bucketName',
    'region',
    'accessKeyId',
    'secretAccessKey',
  ] as const)('rejects a blank custom-storage %s before requesting hosted access', async (field) => {
    await expect(
      SnapshotService.processImageContext(
        objectStorageApi as never,
        contextImage(),
        { ...storage, [field]: ' ' },
        storage.regionId,
      ),
    ).rejects.toThrow(`buildContextStorage.${field} must not be blank`)

    expect(mockDynamicImport).not.toHaveBeenCalled()
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it.each([
    'http://s3.example.com',
    'https://user:secret@s3.example.com',
    'https://s3.example.com?credential=secret',
    'https://s3.example.com#secret',
    'https://s3.example.com\\path',
    'https://s3.example.com/ white-space',
    'invalid-endpoint-secret',
  ])('rejects unsafe storage endpoints without including their value in errors: %s', async (endpointUrl) => {
    await expect(
      SnapshotService.processImageContext(
        objectStorageApi as never,
        contextImage(),
        { ...storage, endpointUrl },
        storage.regionId,
      ),
    ).rejects.toThrow('buildContextStorage.endpointUrl must be HTTPS without userinfo, query, or fragment')

    expect(mockDynamicImport).not.toHaveBeenCalled()
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it.each(['../org-1', 'org-1/path', 'org-1\\path'])(
    'rejects an unsafe organization prefix: %s',
    async (organizationId) => {
      await expect(
        SnapshotService.processImageContext(
          objectStorageApi as never,
          contextImage(),
          { ...storage, organizationId },
          storage.regionId,
        ),
      ).rejects.toThrow('buildContextStorage.organizationId must be a safe organization prefix')

      expect(mockDynamicImport).not.toHaveBeenCalled()
      expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
    },
  )

  it('supports custom storage without a session token', async () => {
    const ObjectStorage = jest.fn(() => ({ upload: jest.fn().mockResolvedValue('hash') }))
    mockDynamicImport.mockResolvedValue({ ObjectStorage })

    await SnapshotService.processImageContext(
      objectStorageApi as never,
      contextImage(),
      { ...storage, sessionToken: undefined },
      storage.regionId,
    )

    expect(ObjectStorage).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: undefined }), true)
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it('does not fall back or create metadata when customer uploads fail', async () => {
    const upload = jest.fn().mockRejectedValue(new Error(`S3 failure involving ${storage.secretAccessKey}`))
    mockDynamicImport.mockResolvedValue({ ObjectStorage: jest.fn(() => ({ upload })) })

    await expect(customerService().create({ name: 'snapshot', image: contextImage() })).rejects.toThrow(
      /^Failed to upload build context to configured object storage$/,
    )

    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
    expect(snapshotsApi.createSnapshot).not.toHaveBeenCalled()
  })

  it('skips storage for empty contexts even without an explicit upload target', async () => {
    await expect(
      SnapshotService.processImageContext(objectStorageApi as never, Image.base('node:24-bookworm-slim'), storage),
    ).resolves.toEqual([])

    expect(mockDynamicImport).not.toHaveBeenCalled()
    expect(objectStorageApi.getPushAccess).not.toHaveBeenCalled()
  })

  it('streams build logs when onLogs is provided for build snapshots', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue({ ok: true } as never)
    snapshotsApi.createSnapshot.mockResolvedValue(createApiResponse({ id: 's5', name: 'snap5', state: 'building' }))
    snapshotsApi.getSnapshotBuildLogsUrl.mockResolvedValue(createApiResponse({ url: 'https://logs.daytona/snap5' }))
    snapshotsApi.getSnapshot.mockResolvedValue(createApiResponse({ id: 's5', name: 'snap5', state: 'active' }))
    mockProcessStreamingResponse.mockImplementation(async (_fetchLogs, onChunk: (chunk: string) => void) => {
      onChunk('log line')
    })

    const onLogs = jest.fn()
    await service.create({ name: 'snap5', image: Image.base('python:3.12').runCommands('echo hi') }, { onLogs })

    expect(snapshotsApi.getSnapshotBuildLogsUrl).toHaveBeenCalledWith('s5')
    expect(mockProcessStreamingResponse).toHaveBeenCalled()
    expect(onLogs).toHaveBeenCalledWith(expect.stringContaining('Creating snapshot snap5'))
    expect(onLogs).toHaveBeenCalledWith('log line')

    fetchSpy.mockRestore()
  })

  it('activates snapshots', async () => {
    snapshotsApi.activateSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snap1', state: 'active' }))

    await expect(service.activate({ id: 's1' } as never)).resolves.toEqual({ id: 's1', name: 'snap1', state: 'active' })
  })

  it('activates snapshots by name', async () => {
    snapshotsApi.getSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snap1' }))
    snapshotsApi.activateSnapshot.mockResolvedValue(createApiResponse({ id: 's1', name: 'snap1', state: 'active' }))

    await expect(service.activate('snap1')).resolves.toEqual({ id: 's1', name: 'snap1', state: 'active' })
    expect(snapshotsApi.getSnapshot).toHaveBeenCalledWith('snap1')
    expect(snapshotsApi.activateSnapshot).toHaveBeenCalledWith('s1')
  })
})
