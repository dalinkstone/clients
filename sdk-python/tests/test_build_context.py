# Copyright Daytona Platforms Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import errno
import importlib
import inspect
import io
import tarfile
import traceback
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from daytona.common.daytona import CreateSandboxFromImageParams, DaytonaConfig
from daytona.common.errors import DaytonaError
from daytona.common.image import Image
from daytona.common.snapshot import CreateSnapshotParams

from .test_async_daytona import _make_async_daytona
from .test_daytona import _make_daytona
from .test_snapshot import TestAsyncSnapshotService as AsyncSnapshotHelper
from .test_snapshot import TestSyncSnapshotService as SyncSnapshotHelper

MARKER = "credential-text-must-not-reach-telemetry"


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def mode(request):
    asynchronous = request.param
    namespace = "_async" if asynchronous else "_sync"
    snapshot_module = importlib.import_module(f"daytona.{namespace}.snapshot")
    storage_module = importlib.import_module(f"daytona.{namespace}.object_storage")
    service_class = getattr(snapshot_module, "AsyncSnapshotService" if asynchronous else "SnapshotService")
    mock_class = AsyncMock if asynchronous else MagicMock
    return SimpleNamespace(
        asynchronous=asynchronous,
        snapshot_module=snapshot_module,
        storage_module=storage_module,
        service_class=service_class,
        mock_class=mock_class,
    )


async def result(value):
    return await value if inspect.isawaitable(value) else value


def access(bucket="customer-bucket"):
    return SimpleNamespace(
        bucket=bucket,
        organization_id="org",
        storage_url="https://storage.invalid",
        region="us-east-1",
        access_key="fake-key",
        secret=MARKER,
        session_token="fake-session",
    )


@pytest.fixture
def context_image(tmp_path):
    source = tmp_path / "context.txt"
    source.write_text("offline build context")
    image = Image.base("alpine:3.21")
    image._context_list = [SimpleNamespace(source_path=str(source), archive_path="context.txt")]
    return image


@pytest.fixture
def transport(mode, monkeypatch):
    objects = {}
    probes = []
    writes = []
    failure = SimpleNamespace(stage=None)

    class Store:
        def __init__(self, *, bucket, **_kwargs):
            self.bucket = bucket

        def head(self, key):
            if failure.stage == "head":
                raise OSError(MARKER)
            probes.append((self.bucket, key))
            if (self.bucket, key) not in objects:
                raise FileNotFoundError(key)

        async def head_async(self, key):
            self.head(key)

        def put(self, key, body, **_kwargs):
            data = b"".join(body)
            self.save(key, data)

        async def put_async(self, key, body, **_kwargs):
            data = b"".join([chunk async for chunk in body])
            self.save(key, data)

        def save(self, key, data):
            if failure.stage == "put":
                raise OSError(MARKER)
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                assert archive.extractfile("context.txt").read() == b"offline build context"
            objects[self.bucket, key] = data
            writes.append((self.bucket, key))

    monkeypatch.setattr(mode.storage_module, "S3Store", Store)
    return SimpleNamespace(objects=objects, probes=probes, writes=writes, failure=failure)


@pytest.mark.asyncio
async def test_region_query_and_bucket_scoped_hash_cache(mode, context_image, transport):
    api = mode.mock_class()
    hashes = []
    for region_id in ["a", "b", "a", None]:
        api.get_push_access.return_value = access(f"{region_id}-bucket")
        hashes.append(await result(mode.service_class.process_image_context(api, context_image, region_id)))
        api.get_push_access.assert_called_with(region_id=region_id)
    assert hashes[0] == hashes[1] == hashes[2] == hashes[3]
    key = f"org/{hashes[0][0]}/context.tar"
    assert transport.writes == [("a-bucket", key), ("b-bucket", key), ("None-bucket", key)]
    assert [bucket for bucket, _ in transport.probes] == ["a-bucket", "b-bucket", "a-bucket", "None-bucket"]


@pytest.mark.asyncio
@pytest.mark.parametrize("default,override", [("custom", None), ("custom", "override"), (None, None)])
async def test_snapshot_region_capture_and_credential_free_metadata(mode, context_image, transport, default, override):
    api = mode.mock_class()
    snapshots = mode.mock_class()
    helper = AsyncSnapshotHelper() if mode.asynchronous else SyncSnapshotHelper()
    dto = helper._make_snapshot_dto()
    dto.state = "active"
    snapshots.create_snapshot.return_value = dto
    params = CreateSnapshotParams(name="snapshot", image=context_image, region_id=override)

    def get_access(**_kwargs):
        params.region_id = "mutated"
        return access()

    api.get_push_access.side_effect = get_access
    service = mode.service_class(snapshots, api, default)
    await result(service.create(params))
    api.get_push_access.assert_called_once_with(region_id=override or default)
    payload = snapshots.create_snapshot.call_args.args[0]
    assert payload.region_id == (override or default)
    assert payload.build_info.context_hashes
    for secret in [MARKER, "fake-key", "fake-session", "customer-bucket", "storage_url"]:
        assert secret not in payload.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["custom", None])
async def test_sandbox_from_image_uses_captured_target(mode, context_image, transport, monkeypatch, target):
    monkeypatch.delenv("DAYTONA_TARGET", raising=False)
    with patch("daytona._utils.env.dotenv_values", return_value={}):
        client = (_make_async_daytona if mode.asynchronous else _make_daytona)(
            DaytonaConfig(api_key="fake", api_url="https://api.invalid", target=target)
        )
    api = mode.mock_class()
    sandbox_api = mode.mock_class()
    client._object_storage_api = api
    client._sandbox_api = sandbox_api

    def get_access(**_kwargs):
        client._target = "mutated"
        return access()

    api.get_push_access.side_effect = get_access
    sandbox_api.create_sandbox.side_effect = RuntimeError("metadata boundary reached")
    with pytest.raises(DaytonaError, match="metadata boundary reached"):
        await result(client.create(CreateSandboxFromImageParams(image=context_image)))
    api.get_push_access.assert_called_once_with(region_id=target)
    payload = sandbox_api.create_sandbox.call_args.args[0]
    assert payload.target == target
    assert payload.build_info.context_hashes
    for secret in [MARKER, "fake-key", "fake-session", "customer-bucket", "storage_url"]:
        assert secret not in payload.model_dump_json()
    if mode.asynchronous:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["access", "head", "put", "initialize"])
async def test_errors_are_safe_before_decorated_telemetry_and_never_retry(mode, context_image, transport, stage):
    api = mode.mock_class()
    api.get_push_access.return_value = access()
    if stage == "access":
        api.get_push_access.side_effect = RuntimeError(MARKER)
    elif stage == "initialize":
        mode.storage_module.S3Store = MagicMock(side_effect=RuntimeError(MARKER))
    else:
        transport.failure.stage = stage
    tracer = MagicMock()
    span = tracer.start_as_current_span.return_value.__enter__.return_value
    with patch("daytona._utils.otel_decorator.get_tracer", return_value=tracer):
        with pytest.raises(DaytonaError, match="Failed to") as caught:
            await result(mode.service_class.process_image_context(api, context_image, "custom"))
    api.get_push_access.assert_called_once_with(region_id="custom")
    assert MARKER not in "".join(traceback.format_exception(caught.value))
    assert span.record_exception.call_count > 0
    for call in span.record_exception.call_args_list:
        assert MARKER not in "".join(traceback.format_exception(call.args[0]))
    for call in span.set_status.call_args_list:
        assert MARKER not in str(call.args[0].description)


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["_compute_hash_for_path_md5", "_upload_as_tar"])
async def test_local_file_errors_remain_actionable(mode, context_image, transport, method):
    api = mode.mock_class()
    api.get_push_access.return_value = access()
    storage_class = getattr(mode.storage_module, "AsyncObjectStorage" if mode.asynchronous else "ObjectStorage")
    error = PermissionError(errno.EACCES, "Permission denied", context_image._context_list[0].source_path)
    with patch.object(storage_class, method, side_effect=error):
        with pytest.raises(PermissionError) as caught:
            await result(mode.service_class.process_image_context(api, context_image, "custom"))
    assert caught.value is error
    assert not transport.writes


@pytest.mark.asyncio
@pytest.mark.parametrize("bucket", [None, "", " ", "\t"])
async def test_empty_access_bucket_fails_without_fallback(mode, context_image, transport, bucket):
    api = mode.mock_class()
    api.get_push_access.return_value = access(bucket)
    with pytest.raises(DaytonaError, match="must specify a bucket"):
        await result(mode.service_class.process_image_context(api, context_image, "custom"))
    api.get_push_access.assert_called_once_with(region_id="custom")
    assert not transport.probes
    assert not transport.writes


@pytest.mark.asyncio
async def test_empty_context_and_blank_region(mode, context_image, transport):
    api = mode.mock_class()
    assert await result(mode.service_class.process_image_context(api, Image.base("alpine"), "custom")) == []
    with pytest.raises(DaytonaError, match="region must not be blank"):
        await result(mode.service_class.process_image_context(api, context_image, " \t"))
    api.get_push_access.assert_not_called()


@pytest.mark.parametrize("package", ["daytona_api_client", "daytona_api_client_async"])
@pytest.mark.parametrize("region_id", ["custom region", None])
def test_generated_query_preserves_organization_header(package, region_id):
    module = importlib.import_module(f"{package}.api.object_storage_api")
    api_client = MagicMock()
    api = module.ObjectStorageApi(api_client)
    api._get_push_access_serialize(
        x_daytona_organization_id="org",
        region_id=region_id,
        _request_auth=None,
        _content_type=None,
        _headers=None,
        _host_index=0,
    )
    serialized = api_client.param_serialize.call_args.kwargs
    assert serialized["query_params"] == ([] if region_id is None else [("regionId", region_id)])
    assert serialized["header_params"]["X-Daytona-Organization-ID"] == "org"
    for method in ["get_push_access", "get_push_access_with_http_info", "get_push_access_without_preload_content"]:
        assert "region_id" in inspect.signature(getattr(api, method)).parameters


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["snapshot", "sandbox"])
@pytest.mark.parametrize("stage", ["access", "head", "put"])
async def test_upload_failure_stops_both_create_paths(mode, context_image, transport, monkeypatch, kind, stage):
    api = mode.mock_class()
    api.get_push_access.return_value = access()
    if stage == "access":
        api.get_push_access.side_effect = RuntimeError(MARKER)
    else:
        transport.failure.stage = stage
    metadata_api = mode.mock_class()
    client = None
    try:
        with pytest.raises(DaytonaError, match="Failed to"):
            if kind == "snapshot":
                service = mode.service_class(metadata_api, api, "custom")
                await result(service.create(CreateSnapshotParams(name="snapshot", image=context_image)))
            else:
                monkeypatch.delenv("DAYTONA_TARGET", raising=False)
                with patch("daytona._utils.env.dotenv_values", return_value={}):
                    client = (_make_async_daytona if mode.asynchronous else _make_daytona)(
                        DaytonaConfig(api_key="fake", api_url="https://api.invalid", target="custom")
                    )
                client._object_storage_api = api
                client._sandbox_api = metadata_api
                await result(client.create(CreateSandboxFromImageParams(image=context_image)))
        api.get_push_access.assert_called_once_with(region_id="custom")
        metadata_api.create_snapshot.assert_not_called()
        metadata_api.create_sandbox.assert_not_called()
    finally:
        if client is not None and mode.asynchronous:
            await client.close()
