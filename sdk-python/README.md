# Daytona Python SDK

The official Python SDK for [Daytona](https://daytona.io), a secure and elastic infrastructure for running AI-generated code. Daytona provides full composable computers — [sandboxes](https://www.daytona.io/docs/en/sandboxes/) — that you can manage programmatically using the Daytona SDK.

The SDK provides an interface for sandbox management, file system operations, Git operations, language server protocol support, process and code execution, and computer use. For more information, see the [documentation](https://www.daytona.io/docs/en/python-sdk/).

## Installation

Install the package using **pip**:

```bash
pip install daytona
```

## Get API key

Generate an API key from the [Daytona Dashboard ↗](https://app.daytona.io/dashboard/keys) to authenticate SDK requests and access Daytona services. For more information, see the [API keys](https://www.daytona.io/docs/en/api-keys/) documentation.

## Configuration

Configure the SDK using [environment variables](https://www.daytona.io/docs/en/configuration/#environment-variables) or by passing a [configuration object](https://www.daytona.io/docs/en/configuration/#configuration-in-code):

- `DAYTONA_API_KEY`: Your Daytona [API key](https://www.daytona.io/docs/en/api-keys/)
- `DAYTONA_API_URL`: The Daytona [API URL](https://www.daytona.io/docs/en/tools/api/)
- `DAYTONA_TARGET`: Your target [region](https://www.daytona.io/docs/en/regions/) environment (e.g. `us`, `eu`)

```python
from daytona import Daytona, DaytonaConfig

# Initialize with environment variables
daytona = Daytona()

# Initialize with configuration object
config = DaytonaConfig(
    api_key="YOUR_API_KEY",
    api_url="YOUR_API_URL",
    target="us"
)
```

## Create a sandbox

Create a sandbox to run your code securely in an isolated environment.

```python
from daytona import Daytona, DaytonaConfig

config = DaytonaConfig(api_key="YOUR_API_KEY")
daytona = Daytona(config)
sandbox = daytona.create()
response = sandbox.process.code_run('print("Hello World")')
```

### Use your own build-context bucket

For local files added to an `Image`, configure an S3-compatible bucket that matches
the build-context storage configured on the runners for your exact Daytona target:

```python
from daytona import BuildContextStorageConfig, CreateSandboxFromImageParams, Daytona, DaytonaConfig, Image

daytona = Daytona(DaytonaConfig(
    api_key="YOUR_DAYTONA_API_KEY",
    target="YOUR_DAYTONA_REGION_ID",
    build_context_storage=BuildContextStorageConfig(
        region_id="YOUR_DAYTONA_REGION_ID",  # Exact Daytona target, not the AWS region
        organization_id="YOUR_ORGANIZATION_ID",
        endpoint_url="https://s3.example.com",
        bucket_name="your-build-context-bucket",
        region="us-east-1",  # AWS signing region
        access_key_id="YOUR_STORAGE_ACCESS_KEY_ID",
        secret_access_key="YOUR_STORAGE_SECRET_ACCESS_KEY",
        # session_token="YOUR_OPTIONAL_SESSION_TOKEN",
    ),
))
sandbox = daytona.create(CreateSandboxFromImageParams(
    image=Image.base("python:3.12").add_local_dir("./src", "/app"),
))
```

The same configuration works with `AsyncDaytona` and `daytona.snapshot.create`.
Set an explicit matching target (or `CreateSnapshotParams.region_id` for a snapshot).
Uploads use explicit credentials only, not an ambient SDK IAM credential chain;
runner IAM/IRSA credentials and bucket configuration are separate. Prefer
short-lived, narrowly scoped credentials (with a session token when required) that
remain valid for the upload. Grant the SDK
object HEAD/read and upload/multipart permissions under
`YOUR_ORGANIZATION_ID/<context-hash>/context.tar`, and grant runners read access to
that same bucket and prefix. Manage retention/lifecycle rules yourself, keeping
contexts available for builds that still need them. Configuration, permission, and
upload failures never fall back to hosted uploads. String images and images without
local contexts do not initialize storage.

Only context archives move to your bucket. Daytona's control plane still receives
build metadata, including Dockerfile content and context hashes; storage credentials
and the storage descriptor are not sent in create requests.
Snapshot registry/image storage is configured separately; this option only controls
local build-context archives.

## Examples and guides

Daytona provides [examples](https://www.daytona.io/docs/en/getting-started/#examples) and [guides](https://www.daytona.io/docs/en/guides/) for common sandbox operations, best practices, and a wide range of topics, from basic usage to advanced topics, showcasing various types of integrations between Daytona and other tools.

### Create a sandbox with custom resources

Create a sandbox with [custom resources](https://www.daytona.io/docs/en/sandboxes/#resources) (CPU, memory, disk).

```python
from daytona import Daytona, CreateSandboxFromImageParams, Image, Resources

daytona = Daytona()
sandbox = daytona.create(
    CreateSandboxFromImageParams(
        image=Image.debian_slim("3.12"),
        resources=Resources(cpu=2, memory=4, disk=8)
    )
)
```

### Create an ephemeral sandbox

Create an [ephemeral sandbox](https://www.daytona.io/docs/en/sandboxes/#ephemeral-sandboxes) that is automatically deleted when stopped.

```python
from daytona import Daytona, CreateSandboxFromSnapshotParams

daytona = Daytona()
sandbox = daytona.create(
    CreateSandboxFromSnapshotParams(ephemeral=True, auto_stop_interval=5)
)
```

### Create a sandbox from a snapshot

Create a sandbox from a [snapshot](https://www.daytona.io/docs/en/snapshots/).

```python
from daytona import Daytona, CreateSandboxFromSnapshotParams

daytona = Daytona()
sandbox = daytona.create(
    CreateSandboxFromSnapshotParams(
        snapshot="my-snapshot-name",
        language="python"
    )
)
```

### Execute Commands

Execute commands in the sandbox.

```python
# Execute a shell command
response = sandbox.process.exec('echo "Hello, World!"')
print(response.result)

# Run Python code
response = sandbox.process.code_run('''
x = 10
y = 20
print(f"Sum: {x + y}")
''')
print(response.result)
```

### File Operations

Upload, download, and search files in the sandbox.

```python
# Upload a file
sandbox.fs.upload_file(b'Hello, World!', 'path/to/file.txt')

# Download a file
content = sandbox.fs.download_file('path/to/file.txt')

# Search for files
matches = sandbox.fs.find_files(root_dir, 'search_pattern')
```

### Git Operations

Clone, list branches, and add files to the sandbox.

```python
# Clone a repository
sandbox.git.clone('https://github.com/example/repo', 'path/to/clone')

# List branches
branches = sandbox.git.branches('path/to/repo')

# Add files
sandbox.git.add('path/to/repo', ['file1.txt', 'file2.txt'])
```

### Language Server Protocol

Create and start a language server to get code completions, document symbols, and more.

```python
# Create and start a language server
lsp = sandbox.create_lsp_server('python', 'path/to/project')
lsp.start()

# Notify the lsp for the file
lsp.did_open('path/to/file.py')

# Get document symbols
symbols = lsp.document_symbols('path/to/file.py')

# Get completions
completions = lsp.completions('path/to/file.py', {"line": 10, "character": 15})
```

Code in [\_sync](./src/daytona/_sync/) directory shouldn't be edited directly. It should be generated from the corresponding async code in the [\_async](./src/daytona/_async/) directory using the SDK generation scripts in the [scripts](./scripts/) directory.

## List method return shapes

Each `list` method returns a different shape depending on the resource. The table below shows the exact return type and how to access the elements.

| Method | Return type (sync) | Return type (async) | Shape | Access elements |
| --- | --- | --- | --- | --- |
| `daytona.snapshot.list(page?, limit?)` | `PaginatedSnapshots` | `PaginatedSnapshots` | Paginated wrapper | `result.items` |
| `daytona.secret.list(cursor?, limit?, ...)` | `ListSecretsResponse` | `ListSecretsResponse` | Cursor-paginated wrapper | `page.items` |
| `daytona.volume.list()` | `list[Volume]` | `list[Volume]` | Bare list | iterate directly |
| `daytona.list(query?)` | `Iterator[Sandbox]` | `AsyncIterator[Sandbox]` | Lazy iterator | `for sandbox in daytona.list()` |

`PaginatedSnapshots` and `ListSecretsResponse` are **wrapper objects**, not lists. Calling list methods like `.append()` directly on them raises `AttributeError`. Always go through `.items`:

```python
# snapshots — page-number pagination
result = daytona.snapshot.list(page=1, limit=20)
# result.items       → list[Snapshot]
# result.total       → int (total across all pages)
# result.page        → int (current page, 1-indexed)
# result.total_pages → int
for snapshot in result.items:
    print(snapshot.name)

# secrets — cursor pagination
cursor = None
while True:
    page = daytona.secret.list(cursor=cursor, limit=50)
    # page.items       → list[Secret]
    # page.total       → int
    # page.next_cursor → str | None (None = no more pages)
    for secret in page.items:
        print(secret.name)
    if page.next_cursor is None:
        break
    cursor = page.next_cursor

# volumes — bare list, iterate directly
volumes = daytona.volume.list()
for vol in volumes:
    print(vol.name)

# sandboxes — lazy iterator, fetches pages on demand
from daytona import ListSandboxesQuery

for sandbox in daytona.list(ListSandboxesQuery(labels={"env": "dev"})):
    print(sandbox.id)
```

The async client (`AsyncDaytona`) uses the same field names. Replace `for sandbox in` with `async for sandbox in` for the sandbox iterator.
