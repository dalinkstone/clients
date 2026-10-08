# Copyright Daytona Platforms Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import io
import tarfile
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from daytona.common.errors import DaytonaError, DaytonaValidationError
from daytona.common.image import Image
from daytona.common.snapshot import CreateSnapshotParams, Snapshot


class TestSyncSnapshotService:
    def _make_service(self):
        from daytona._sync.snapshot import SnapshotService

        mock_snapshots_api = MagicMock()
        mock_object_storage_api = MagicMock()
        return SnapshotService(mock_snapshots_api, mock_object_storage_api, "us"), mock_snapshots_api

    def _make_snapshot_dto(self, name="test-snapshot"):
        dto = MagicMock()
        dto.id = "snap-123"
        dto.name = name
        dto.model_dump.return_value = {
            "id": "snap-123",
            "organization_id": "org-1",
            "general": False,
            "name": name,
            "image_name": "python:3.12",
            "ref": None,
            "state": "active",
            "size": None,
            "entrypoint": None,
            "cpu": 4,
            "gpu": 0,
            "mem": 8,
            "disk": 30,
            "build_info": None,
            "error_reason": None,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
            "last_used_at": "2025-01-01T00:00:00Z",
            "source_sandbox_id": None,
        }
        return dto

    def test_list(self):
        service, api = self._make_service()
        mock_response = MagicMock()
        mock_response.items = [self._make_snapshot_dto()]
        mock_response.total = 1
        mock_response.page = 1
        mock_response.total_pages = 1
        api.get_all_snapshots.return_value = mock_response
        result = service.list()
        assert result.total == 1
        assert len(result.items) == 1

    def test_list_passes_source_sandbox_id(self):
        service, api = self._make_service()
        mock_response = MagicMock()
        mock_response.items = []
        mock_response.total = 0
        mock_response.page = 1
        mock_response.total_pages = 0
        api.get_all_snapshots.return_value = mock_response
        service.list(source_sandbox_id="sandbox-1")
        api.get_all_snapshots.assert_called_once_with(limit=None, page=None, source_sandbox_id="sandbox-1")

    def test_list_invalid_page_raises(self):
        service, _ = self._make_service()
        with pytest.raises(DaytonaError, match="page must be a positive integer"):
            service.list(page=0)

    def test_list_invalid_limit_raises(self):
        service, _ = self._make_service()
        with pytest.raises(DaytonaError, match="limit must be a positive integer"):
            service.list(limit=0)

    def test_get(self):
        service, api = self._make_service()
        api.get_snapshot.return_value = self._make_snapshot_dto()
        result = service.get("test-snapshot")
        assert isinstance(result, Snapshot)

    def test_delete(self):
        service, api = self._make_service()
        api.remove_snapshot.return_value = None
        snap = Snapshot.model_validate(
            {
                "id": "snap-123",
                "organization_id": "org-1",
                "general": False,
                "name": "test-snapshot",
                "image_name": "python:3.12",
                "ref": None,
                "state": "active",
                "size": None,
                "entrypoint": None,
                "cpu": 4,
                "gpu": 0,
                "mem": 8,
                "disk": 30,
                "build_info": None,
                "error_reason": None,
                "created_at": "2025-01-01T00:00:00Z",
                "updated_at": "2025-01-01T00:00:00Z",
                "last_used_at": "2025-01-01T00:00:00Z",
                "source_sandbox_id": None,
            }
        )
        service.delete(snap)
        api.remove_snapshot.assert_called_once_with("snap-123")

    def test_delete_by_name(self):
        service, api = self._make_service()
        api.get_snapshot.return_value = self._make_snapshot_dto()
        api.remove_snapshot.return_value = None

        service.delete("test-snapshot")

        api.get_snapshot.assert_called_once_with("test-snapshot")
        api.remove_snapshot.assert_called_once_with("snap-123")

    def test_delete_by_uuid_id_skips_resolution(self):
        service, api = self._make_service()
        api.remove_snapshot.return_value = None
        snapshot_id = "9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa"

        service.delete(snapshot_id)

        api.get_snapshot.assert_not_called()
        api.remove_snapshot.assert_called_once_with(snapshot_id)

    def test_delete_by_uuid_name_falls_back_to_resolution(self):
        from daytona_api_client.exceptions import NotFoundException

        service, api = self._make_service()
        uuid_name = "9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa"
        api.remove_snapshot.side_effect = [NotFoundException(), None]
        api.get_snapshot.return_value = self._make_snapshot_dto(name=uuid_name)

        service.delete(uuid_name)

        api.get_snapshot.assert_called_once_with(uuid_name)
        assert api.remove_snapshot.call_args_list[0].args == (uuid_name,)
        assert api.remove_snapshot.call_args_list[1].args == ("snap-123",)

    def test_delete_by_uuid_propagates_non_404(self):
        from daytona_api_client.exceptions import ForbiddenException

        service, api = self._make_service()
        api.remove_snapshot.side_effect = ForbiddenException()

        with pytest.raises(DaytonaError):
            service.delete("9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa")

        api.get_snapshot.assert_not_called()

    def test_activate(self):
        service, api = self._make_service()
        api.activate_snapshot.return_value = self._make_snapshot_dto(name="active-snapshot")

        result = service.activate(Snapshot.model_validate(self._make_snapshot_dto().model_dump()))

        assert result.name == "active-snapshot"

    def test_activate_by_name(self):
        service, api = self._make_service()
        api.get_snapshot.return_value = self._make_snapshot_dto()
        api.activate_snapshot.return_value = self._make_snapshot_dto(name="active-snapshot")

        result = service.activate("test-snapshot")

        assert result.name == "active-snapshot"
        api.activate_snapshot.assert_called_once_with("snap-123")

    def test_process_image_context_returns_empty_for_images_without_context(self):
        assert (
            TestSyncSnapshotService._make_service(self)[0].process_image_context(MagicMock(), Image.base("python:3.12"))
            == []
        )

    def test_process_image_context_passes_region_to_object_storage(self):
        service, _ = self._make_service()
        object_storage_api = MagicMock()
        creds = object_storage_api.get_push_access.return_value
        creds.storage_url = "https://s3.example"
        creds.access_key = "key"
        creds.secret = "secret"
        creds.session_token = "token"
        creds.bucket = "bucket"
        creds.organization_id = "org-1"
        creds.region = "us-east-2"
        image = Image.base("python:3.12")
        image._context_list = [MagicMock(source_path="/tmp/ctx", archive_path=".")]

        with patch("daytona._sync.snapshot.ObjectStorage") as mock_storage_cls:
            mock_storage_cls.return_value.upload.return_value = "ctx-hash"

            assert service.process_image_context(object_storage_api, image) == ["ctx-hash"]
            assert mock_storage_cls.call_args.kwargs["region"] == "us-east-2"
            assert "sanitize_errors" not in mock_storage_cls.call_args.kwargs


class TestAsyncSnapshotService:
    def _make_service(self):
        from daytona._async.snapshot import AsyncSnapshotService

        mock_snapshots_api = AsyncMock()
        mock_object_storage_api = AsyncMock()
        return AsyncSnapshotService(mock_snapshots_api, mock_object_storage_api, "us"), mock_snapshots_api

    def _make_snapshot_dto(self, name="test-snapshot"):
        dto = MagicMock()
        dto.id = "snap-123"
        dto.name = name
        dto.model_dump.return_value = {
            "id": "snap-123",
            "organization_id": "org-1",
            "general": False,
            "name": name,
            "image_name": "python:3.12",
            "ref": None,
            "state": "active",
            "size": None,
            "entrypoint": None,
            "cpu": 4,
            "gpu": 0,
            "mem": 8,
            "disk": 30,
            "build_info": None,
            "error_reason": None,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
            "last_used_at": "2025-01-01T00:00:00Z",
            "source_sandbox_id": None,
        }
        return dto

    @pytest.mark.asyncio
    async def test_list(self):
        service, api = self._make_service()
        mock_response = MagicMock()
        mock_response.items = [self._make_snapshot_dto()]
        mock_response.total = 1
        mock_response.page = 1
        mock_response.total_pages = 1
        api.get_all_snapshots.return_value = mock_response
        result = await service.list()
        assert result.total == 1

    @pytest.mark.asyncio
    async def test_list_passes_source_sandbox_id(self):
        service, api = self._make_service()
        mock_response = MagicMock()
        mock_response.items = []
        mock_response.total = 0
        mock_response.page = 1
        mock_response.total_pages = 0
        api.get_all_snapshots.return_value = mock_response
        await service.list(source_sandbox_id="sandbox-1")
        api.get_all_snapshots.assert_called_once_with(limit=None, page=None, source_sandbox_id="sandbox-1")

    @pytest.mark.asyncio
    async def test_list_invalid_page_raises(self):
        service, _ = self._make_service()
        with pytest.raises(DaytonaError, match="page must be a positive integer"):
            await service.list(page=0)

    @pytest.mark.asyncio
    async def test_get(self):
        service, api = self._make_service()
        api.get_snapshot.return_value = self._make_snapshot_dto()
        result = await service.get("test-snapshot")
        assert isinstance(result, Snapshot)

    @pytest.mark.asyncio
    async def test_delete(self):
        service, api = self._make_service()
        snap = Snapshot.model_validate(
            {
                "id": "snap-123",
                "organization_id": "org-1",
                "general": False,
                "name": "test-snapshot",
                "image_name": "python:3.12",
                "ref": None,
                "state": "active",
                "size": None,
                "entrypoint": None,
                "cpu": 4,
                "gpu": 0,
                "mem": 8,
                "disk": 30,
                "build_info": None,
                "error_reason": None,
                "created_at": "2025-01-01T00:00:00Z",
                "updated_at": "2025-01-01T00:00:00Z",
                "last_used_at": "2025-01-01T00:00:00Z",
                "source_sandbox_id": None,
            }
        )
        await service.delete(snap)
        api.remove_snapshot.assert_called_once_with("snap-123")

    @pytest.mark.asyncio
    async def test_delete_by_name(self):
        service, api = self._make_service()
        api.get_snapshot.return_value = self._make_snapshot_dto()
        api.remove_snapshot.return_value = None

        await service.delete("test-snapshot")

        api.get_snapshot.assert_called_once_with("test-snapshot")
        api.remove_snapshot.assert_called_once_with("snap-123")

    @pytest.mark.asyncio
    async def test_delete_by_uuid_id_skips_resolution(self):
        service, api = self._make_service()
        api.remove_snapshot.return_value = None
        snapshot_id = "9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa"

        await service.delete(snapshot_id)

        api.get_snapshot.assert_not_called()
        api.remove_snapshot.assert_called_once_with(snapshot_id)

    @pytest.mark.asyncio
    async def test_delete_by_uuid_name_falls_back_to_resolution(self):
        from daytona_api_client_async.exceptions import NotFoundException

        service, api = self._make_service()
        uuid_name = "9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa"
        api.remove_snapshot.side_effect = [NotFoundException(), None]
        api.get_snapshot.return_value = self._make_snapshot_dto(name=uuid_name)

        await service.delete(uuid_name)

        api.get_snapshot.assert_called_once_with(uuid_name)
        assert api.remove_snapshot.call_args_list[0].args == (uuid_name,)
        assert api.remove_snapshot.call_args_list[1].args == ("snap-123",)

    @pytest.mark.asyncio
    async def test_delete_by_uuid_propagates_non_404(self):
        from daytona_api_client_async.exceptions import ForbiddenException

        service, api = self._make_service()
        api.remove_snapshot.side_effect = ForbiddenException()

        with pytest.raises(DaytonaError):
            await service.delete("9f0a2b52-6a5f-4bd6-9c1e-1c9a1cf7d3aa")

        api.get_snapshot.assert_not_called()

    @pytest.mark.asyncio
    async def test_activate_by_name(self):
        service, api = self._make_service()
        api.get_snapshot.return_value = self._make_snapshot_dto()
        api.activate_snapshot.return_value = self._make_snapshot_dto(name="active-snapshot")

        result = await service.activate("test-snapshot")

        assert result.name == "active-snapshot"
        api.activate_snapshot.assert_called_once_with("snap-123")

    @pytest.mark.asyncio
    async def test_activate(self):
        service, api = self._make_service()
        api.activate_snapshot.return_value = self._make_snapshot_dto(name="active-snapshot")

        result = await service.activate(Snapshot.model_validate(self._make_snapshot_dto().model_dump()))

        assert result.name == "active-snapshot"

    @pytest.mark.asyncio
    async def test_process_image_context_returns_empty_for_images_without_context(self):
        assert (
            await TestAsyncSnapshotService._make_service(self)[0].process_image_context(
                MagicMock(), Image.base("python:3.12")
            )
            == []
        )

    @pytest.mark.asyncio
    async def test_process_image_context_passes_region_to_object_storage(self):
        service, _ = self._make_service()
        object_storage_api = AsyncMock()
        creds = MagicMock()
        creds.storage_url = "https://s3.example"
        creds.access_key = "key"
        creds.secret = "secret"
        creds.session_token = "token"
        creds.bucket = "bucket"
        creds.organization_id = "org-1"
        creds.region = "us-east-2"
        object_storage_api.get_push_access.return_value = creds
        image = Image.base("python:3.12")
        image._context_list = [MagicMock(source_path="/tmp/ctx", archive_path=".")]

        with patch("daytona._async.snapshot.AsyncObjectStorage") as mock_storage_cls:
            mock_storage_cls.return_value.upload = AsyncMock(return_value="ctx-hash")

            assert await service.process_image_context(object_storage_api, image) == ["ctx-hash"]
            assert mock_storage_cls.call_args.kwargs["region"] == "us-east-2"
            assert "sanitize_errors" not in mock_storage_cls.call_args.kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
class TestBuildContextStorage:
    async def test_constructor_error_has_no_context_or_telemetry_secret(
        self, is_async, build_context_storage, span_exporter
    ):
        service, api, storage_api = self._make_service(is_async, build_context_storage)
        image = Image.base("python:3.12")
        image._context_list = [MagicMock(source_path="/tmp/ctx", archive_path="context")]
        module = "daytona._async.object_storage" if is_async else "daytona._sync.object_storage"
        with patch(f"{module}.S3Store", side_effect=ValueError("constructor-credential-marker")):
            with pytest.raises(DaytonaError) as caught:
                response = service.process_image_context(
                    storage_api, image, build_context_storage=build_context_storage, region_id="us"
                )
                if is_async:
                    await response
        assert caught.value.__context__ is None
        assert caught.value.__cause__ is None
        spans = span_exporter.get_finished_spans()
        assert spans
        assert all("constructor-credential-marker" not in span.to_json() for span in spans)
        storage_api.get_push_access.assert_not_called()
        api.create_snapshot.assert_not_called()

    def _make_service(self, is_async, config, default_region_id="us", organization_id=None):
        from daytona._async.snapshot import AsyncSnapshotService
        from daytona._sync.snapshot import SnapshotService

        cls = AsyncSnapshotService if is_async else SnapshotService
        mock_cls = AsyncMock if is_async else MagicMock
        api, storage_api = mock_cls(), mock_cls()
        api.create_snapshot.return_value = Snapshot.model_validate(
            TestSyncSnapshotService()._make_snapshot_dto().model_dump()
        )
        service = cls(
            api,
            storage_api,
            default_region_id,
            build_context_storage=config,
            organization_id=organization_id,
        )
        return service, api, storage_api

    @pytest.mark.parametrize("override", [False, True], ids=["default-target", "snapshot-target"])
    async def test_create_uploads_custom_contexts_before_metadata(
        self, is_async, override, build_context_storage, tmp_path
    ):
        if override:
            build_context_storage = build_context_storage.model_copy(update={"session_token": None})
        service, api, storage_api = self._make_service(
            is_async, build_context_storage, default_region_id="eu" if override else "us"
        )
        image = Image.base("python:3.12")
        contents = [b"first", b"second"]
        for index, content in enumerate(contents):
            path = tmp_path / f"file-{index}.txt"
            path.write_bytes(content)
            image.add_local_file(str(path), f"/app/file-{index}.txt")
        hashes = [
            hashlib.md5(context.archive_path.encode() + content).hexdigest()
            for context, content in zip(image._context_list, contents)
        ]
        keys = [f"org-1/{context_hash}/context.tar" for context_hash in hashes]
        captured, events = {}, []
        store = MagicMock()

        def head(key):
            events.append(("head", key))
            raise FileNotFoundError()

        def consume(key, chunks, **_kwargs):
            captured[key] = b"".join(chunks)
            events.append(("put", key))

        async def consume_async(key, chunks, **_kwargs):
            captured[key] = b"".join([chunk async for chunk in chunks])
            events.append(("put", key))

        if is_async:
            store.head_async = AsyncMock(side_effect=head)
            store.put_async = AsyncMock(side_effect=consume_async)
        else:
            store.head.side_effect = head
            store.put.side_effect = consume
        result = api.create_snapshot.return_value

        def create(_request):
            events.append(("create", None))
            return result

        api.create_snapshot.side_effect = create
        module = "daytona._async.object_storage" if is_async else "daytona._sync.object_storage"
        params = CreateSnapshotParams(name="test-snapshot", image=image, region_id="us" if override else None)
        with patch(f"{module}.S3Store", return_value=store) as store_cls:
            response = service.create(params)
            if is_async:
                response = await response
        assert response is result
        storage_api.get_push_access.assert_not_called()
        store_cls.assert_called_once_with(
            bucket="build-contexts",
            endpoint="https://s3.example.com",
            region="us-east-2",
            access_key_id="storage-access-value",
            secret_access_key="storage-secret-value",
            **({"session_token": "storage-session-value"} if not override else {}),
            client_options={"timeout": timedelta(minutes=2)},
            retry_config={"retry_timeout": timedelta(minutes=4)},
        )
        assert events == [(operation, key) for key in keys for operation in ("head", "put")] + [("create", None)]
        for key, context, content in zip(keys, image._context_list, contents):
            with tarfile.open(fileobj=io.BytesIO(captured[key])) as archive:
                assert archive.getnames() == [context.archive_path]
                assert archive.extractfile(context.archive_path).read() == content
        request = api.create_snapshot.call_args.args[0]
        assert request.region_id == "us"
        assert request.build_info.context_hashes == hashes
        assert request.build_info.dockerfile_content == image.dockerfile()
        for value in (
            "storage-access-value",
            "storage-secret-value",
            "storage-session-value",
            "s3.example.com",
            "build-contexts",
        ):
            assert value not in request.model_dump_json()

    @pytest.mark.parametrize(
        "update",
        [{"endpoint_url": "http://s3.example.com"}, {"bucket_name": " "}, {"organization_id": "../org"}],
        ids=["unsafe-endpoint", "blank-bucket", "unsafe-org-prefix"],
    )
    async def test_copied_descriptor_is_revalidated_before_storage(self, is_async, update, build_context_storage):
        from daytona._utils.errors import is_validation_error

        config = build_context_storage.model_copy(update=update)
        service, api, storage_api = self._make_service(is_async, config)
        image = Image.base("python:3.12")
        image._context_list = [MagicMock(source_path="/tmp/ctx", archive_path="context")]
        cls_path = "daytona._async.snapshot.AsyncObjectStorage" if is_async else "daytona._sync.snapshot.ObjectStorage"
        with patch(cls_path) as storage_cls:
            with pytest.raises(DaytonaError) as caught:
                response = service.create(CreateSnapshotParams(name="test-snapshot", image=image))
                if is_async:
                    await response
            assert is_validation_error(caught.value)
            storage_cls.assert_not_called()
        storage_api.get_push_access.assert_not_called()
        api.create_snapshot.assert_not_called()

    @pytest.mark.parametrize("failure", ["absent-target", "different-target", "different-org", "init", "upload"])
    async def test_create_fails_closed(self, is_async, failure, build_context_storage):
        service, api, storage_api = self._make_service(
            is_async,
            build_context_storage,
            default_region_id=None if failure == "absent-target" else "us",
            organization_id="other-org" if failure == "different-org" else None,
        )
        image = Image.base("python:3.12")
        image._context_list = [MagicMock(source_path="/tmp/ctx", archive_path="context")]
        params = CreateSnapshotParams(
            name="test-snapshot", image=image, region_id="eu" if failure == "different-target" else None
        )
        cls_path = "daytona._async.snapshot.AsyncObjectStorage" if is_async else "daytona._sync.snapshot.ObjectStorage"
        binding_failure = failure not in ("init", "upload")
        error_cls = DaytonaValidationError if binding_failure else DaytonaError
        with patch(cls_path) as storage_cls:
            if failure == "init":
                storage_cls.side_effect = ValueError("storage-secret-value")
            storage_cls.return_value.upload = (AsyncMock if is_async else MagicMock)(
                side_effect=PermissionError("storage-secret-value")
            )
            with pytest.raises(error_cls) as caught:
                response = service.create(params)
                if is_async:
                    await response
            if binding_failure:
                storage_cls.assert_not_called()
            else:
                assert "configured object storage" in str(caught.value)
            assert "storage-secret-value" not in str(caught.value)
        storage_api.get_push_access.assert_not_called()
        api.create_snapshot.assert_not_called()

    @pytest.mark.parametrize("image", ["python:3.12", Image.base("python:3.12")], ids=["string", "empty-context"])
    async def test_no_context_does_not_initialize_storage(self, is_async, image, build_context_storage):
        service, api, storage_api = self._make_service(is_async, build_context_storage, default_region_id=None)
        cls_path = "daytona._async.snapshot.AsyncObjectStorage" if is_async else "daytona._sync.snapshot.ObjectStorage"
        with patch(cls_path) as storage_cls:
            response = service.create(CreateSnapshotParams(name="test-snapshot", image=image))
            if is_async:
                await response
        storage_cls.assert_not_called()
        storage_api.get_push_access.assert_not_called()
        api.create_snapshot.assert_called_once()
