# Region-Aware Build-Context Storage

Local files referenced by an SDK `Image` must be uploaded to the bucket read by
the runners building that image. This applies to TypeScript snapshot creation and
sandbox creation from an image, and to both synchronous and asynchronous Python.
String images and images without local contexts do not request upload access.
Registry image storage and registry push access are separate.

## Managed Setup

1. Deploy the server changes and database migration from
   [daytona-ai #1317](https://github.com/daytona/daytona-ai/pull/1317). Configure the
   owned region's `buildContextBucket`, `buildContextBucketRegion` (AWS S3 region),
   and `buildContextRoleArn` (upload role ARN). All three are required for a custom
   bucket. The managed path supports standard-partition AWS S3, not arbitrary
   S3-compatible endpoints.
2. Allow the API principal, or its configured broker role, to assume the upload
   role with `sts:ExternalId` equal to the authenticated Daytona organization ID.
   Grant prefix-scoped S3 access for `<organizationId>/*`, including bucket listing
   and upload/read permissions. No static customer AWS keys belong in SDK config.
3. Configure every eligible runner to read the same bucket, AWS region, and keys.
   Runner IAM/IRSA or static credentials are independent of the temporary upload
   credentials issued to the SDK.
4. Release the generated TypeScript and sync/async Python API clients containing
   the optional `regionId` query before releasing SDKs that depend on them. Update
   dependency versions through the repository release flow.
5. Set SDK `target` or `DAYTONA_TARGET` to the custom Daytona region ID, not the AWS
   region. Snapshot `regionId` (TypeScript) or `region_id` (Python) overrides it.

The SDK captures the region before upload and reuses it in create metadata.
TypeScript calls `getPushAccess(undefined, regionId)`: the first argument remains
the JWT organization header. Python calls `get_push_access(region_id=region_id)`.
Without an explicit target, the query is omitted while creation uses the server's
organization default. Set the target even when the custom region is that default;
the SDK does not discover it.

The server can select hosted storage for absent, unknown, shared, foreign, or
unconfigured regions. Invalid custom configuration or role-assumption failure
fails closed. Failed access or upload never triggers an SDK retry with hosted
credentials. The TypeScript `getBuildContextUploadAccess` callback is an optional
advanced override, requires a nonblank explicit target and bucket, and replaces
API discovery without fallback. The managed path needs no callback.

## Storage Contract

Keys remain `<organizationId>/<contextHash>/context.tar`. Create metadata contains
Dockerfile content and context hashes, never upload credentials or bucket details.
Identical content in different buckets still needs a probe/upload in each bucket.

Access, storage initialization, and transport failures use fixed safe errors before
SDK telemetry records them. Original transport errors are not attached as causes;
Python suppresses their displayed exception chain. Local filesystem errors retain
their diagnostics. Provider, application, and third-party logging are outside this
scoped handling.

Credentials are requested per context-processing operation and are not refreshed
mid-upload. Uploads and retries must fit their lifetime. Validate multipart and any
SSE-KMS permissions with the deployed server's session policy, role, bucket, and
key policies. Verify a local `COPY` build against the selected bucket and runner
before production rollout; mocked tests do not establish live IAM or runner access.

This change does not migrate old contexts. Retain old buckets for queued builds,
rebuilds, and rollback. Before moving builds to another bucket, re-upload or
replicate contexts and ensure every eligible runner can read them.
