# Daytona TypeScript SDK

The official TypeScript SDK for [Daytona](https://daytona.io), a secure and elastic infrastructure for running AI-generated code. Daytona provides full composable computers — [sandboxes](https://www.daytona.io/docs/en/sandboxes/) — that you can manage programmatically using the Daytona SDK.

The SDK provides an interface for sandbox management, file system operations, Git operations, language server protocol support, process and code execution, and computer use. For more information, see the [documentation](https://www.daytona.io/docs/en/typescript-sdk/).

## Installation

Install the package using **npm**:

```bash
npm install @daytona/sdk
```

or using **yarn**:

```bash
yarn add @daytona/sdk
```

## Get API key

Generate an API key from the [Daytona Dashboard ↗](https://app.daytona.io/dashboard/keys) to authenticate SDK requests and access Daytona services. For more information, see the [API keys](https://www.daytona.io/docs/en/api-keys/) documentation.

## Configuration

Configure the SDK using [environment variables](https://www.daytona.io/docs/en/configuration/#environment-variables) or by passing a [configuration object](https://www.daytona.io/docs/en/configuration/#configuration-in-code):

- `DAYTONA_API_KEY`: Your Daytona [API key](https://www.daytona.io/docs/en/api-keys/)
- `DAYTONA_API_URL`: The Daytona [API URL](https://www.daytona.io/docs/en/tools/api/)
- `DAYTONA_TARGET`: Your target [region](https://www.daytona.io/docs/en/regions/) environment (e.g. `us`, `eu`)

```typescript
import { Daytona } from '@daytona/sdk'

// Initialize with environment variables
const daytona = new Daytona();

// Initialize with configuration object
const daytona = new Daytona({
  apiKey: 'YOUR_API_KEY',
  apiUrl: 'YOUR_API_URL',
  target: 'us',
});
```

### Use your own build-context bucket

For local files added to an `Image`, configure an S3-compatible bucket that matches
the build-context storage configured on the runners for your exact Daytona target:

```typescript
import { Daytona, Image } from '@daytona/sdk'

const daytona = new Daytona({
  apiKey: 'YOUR_DAYTONA_API_KEY',
  target: 'YOUR_DAYTONA_REGION_ID',
  buildContextStorage: {
    regionId: 'YOUR_DAYTONA_REGION_ID', // Exact Daytona target, not the AWS region
    organizationId: 'YOUR_ORGANIZATION_ID',
    endpointUrl: 'https://s3.us-east-1.amazonaws.com',
    bucketName: 'your-build-context-bucket',
    region: 'us-east-1', // AWS signing region
    accessKeyId: 'YOUR_STORAGE_ACCESS_KEY_ID',
    secretAccessKey: 'YOUR_STORAGE_SECRET_ACCESS_KEY',
    // sessionToken: 'YOUR_OPTIONAL_SESSION_TOKEN',
  },
})

await daytona.snapshot.create({
  name: 'customer-image-v1',
  image: Image.base('node:24-bookworm-slim').addLocalDir('./src', '/app'),
})
```

The same configuration applies to `daytona.create` with an `Image`. Set an explicit
matching target (or `regionId` for a snapshot). Credentials are supplied explicitly;
runner IAM/IRSA credentials and bucket configuration are separate. Prefer scoped,
short-lived credentials that remain valid for the whole upload. Grant the SDK
prefix-restricted list and upload/multipart permissions, and grant runners read
access to `YOUR_ORGANIZATION_ID/<context-hash>/context.tar` in that bucket. Manage
retention/lifecycle rules yourself, keeping contexts available for builds that
still need them. Configuration, permission, and upload failures never fall back to
hosted uploads. String images and images without local contexts do not initialize
storage.

Only context archives move to your bucket. Daytona's control plane still receives
build metadata, including Dockerfile content and context hashes; storage credentials
and the storage descriptor are not sent in create requests. Snapshot image storage
is configured separately through your region's registry.

## Create a sandbox

Create a sandbox to run your code securely in an isolated environment.

```typescript
import { Daytona } from '@daytona/sdk'

const daytona = new Daytona({apiKey: "YOUR_API_KEY"});
const sandbox = await daytona.create({
  language: 'typescript'
});
const response = await sandbox.process.codeRun('console.log("Hello World!")');
console.log(response.result);
```

## Examples and guides

Daytona provides [examples](https://www.daytona.io/docs/en/getting-started/#examples) and [guides](https://www.daytona.io/docs/en/guides/) for common sandbox operations, best practices, and a wide range of topics, from basic usage to advanced topics, showcasing various types of integrations between Daytona and other tools.

### Create a sandbox with custom resources

Create a sandbox with [custom resources](https://www.daytona.io/docs/en/sandboxes/#resources) (CPU, memory, disk).

```typescript
import { Daytona, Image } from '@daytona/sdk';

const daytona = new Daytona();
const sandbox = await daytona.create({
    image: Image.debianSlim('3.12'),
    resources: { cpu: 2, memory: 4, disk: 8 }
});
```

### Create an ephemeral sandbox

Create an [ephemeral sandbox](https://www.daytona.io/docs/en/sandboxes/#ephemeral-sandboxes) that is automatically deleted when stopped.

```typescript
import { Daytona } from '@daytona/sdk';

const daytona = new Daytona();
const sandbox = await daytona.create({
    ephemeral: true,
    autoStopInterval: 5
});
```

### Create a sandbox from a snapshot

Create a sandbox from a [snapshot](https://www.daytona.io/docs/en/snapshots/).

```typescript
import { Daytona } from '@daytona/sdk';

const daytona = new Daytona();
const sandbox = await daytona.create({
    snapshot: 'my-snapshot-name',
    language: 'typescript'
});
```

### Execute commands

Execute commands in the sandbox.

```typescript
// Execute a shell command
const response = await sandbox.process.executeCommand('echo "Hello, World!"')
console.log(response.result)

// Run TypeScript code
const response = await sandbox.process.codeRun(`
const x = 10
const y = 20
console.log(\`Sum: \${x + y}\`)
`)
console.log(response.result)
```

### File operations

Upload, download, and search files in the sandbox.

```typescript
// Upload a file
await sandbox.fs.uploadFile(Buffer.from('Hello, World!'), 'path/to/file.txt')

// Download a file
const content = await sandbox.fs.downloadFile('path/to/file.txt')

// Search for files
const matches = await sandbox.fs.findFiles(root_dir, 'search_pattern')
```

### Git operations

Clone, list branches, and add files to the sandbox.

```typescript
// Clone a repository
await sandbox.git.clone('https://github.com/example/repo', 'path/to/clone')

// List branches
const branches = await sandbox.git.branches('path/to/repo')

// Add files
await sandbox.git.add('path/to/repo', ['file1.txt', 'file2.txt'])
```

### Language server protocol

Create and start a language server to get code completions, document symbols, and more.

```typescript
// Create and start a language server
const lsp = await sandbox.createLspServer('typescript', 'path/to/project')
await lsp.start()

// Notify the lsp for the file
await lsp.didOpen('path/to/file.ts')

// Get document symbols
const symbols = await lsp.documentSymbols('path/to/file.ts')

// Get completions
const completions = await lsp.completions('path/to/file.ts', {
  line: 10,
  character: 15,
})
```

## List method return shapes

Each `list` method returns a different shape depending on the resource. The table below shows the exact return type and how to access the elements.

| Method | Return type | Shape | Access elements |
| --- | --- | --- | --- |
| `daytona.snapshot.list(page?, limit?)` | `Promise<PaginatedSnapshots>` | Paginated wrapper | `result.items.forEach(...)` |
| `daytona.secret.list(query?)` | `Promise<ListSecretsResponse>` | Cursor-paginated wrapper | `page.items.forEach(...)` |
| `daytona.volume.list()` | `Promise<Volume[]>` | Bare array | `volumes.forEach(...)` |
| `daytona.list(query?)` | `AsyncIterableIterator<Sandbox>` | Lazy iterator | `for await (const s of daytona.list())` |

`PaginatedSnapshots` and `ListSecretsResponse` are **wrapper objects**, not arrays. Calling `.map()` or `.forEach()` directly on them throws `TypeError: result.map is not a function`. Always go through `.items`:

```typescript
// snapshots — page-number pagination
const result = await daytona.snapshot.list(1, 20)
// result.items  → Snapshot[]
// result.total  → number (total across all pages)
// result.page   → number (current page, 1-indexed)
// result.totalPages → number
result.items.forEach(snapshot => console.log(snapshot.name))

// secrets — cursor pagination
let cursor: string | undefined
do {
  const page = await daytona.secret.list({ cursor, limit: 50 })
  // page.items      → Secret[]
  // page.total      → number
  // page.nextCursor → string | null (null = no more pages)
  page.items.forEach(secret => console.log(secret.name))
  cursor = page.nextCursor ?? undefined
} while (cursor)

// volumes — bare array, iterate directly
const volumes = await daytona.volume.list()
volumes.forEach(vol => console.log(vol.name))

// sandboxes — lazy async iterator, fetches pages on demand
for await (const sandbox of daytona.list({ labels: { env: 'dev' } })) {
  console.log(sandbox.id)
}
```
