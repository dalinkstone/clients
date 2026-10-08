# Copyright Daytona Platforms Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_storage():
    from daytona._sync.object_storage import ObjectStorage

    with patch("daytona._sync.object_storage.S3Store") as mock_store_cls:
        mock_store = MagicMock()
        mock_store_cls.return_value = mock_store
        storage = ObjectStorage(
            "https://s3.example", "key", "secret", "token", bucket_name="bucket", region="us-east-2"
        )
    return storage, mock_store


class TestObjectStorage:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
    @pytest.mark.parametrize("sanitize_errors", [False, True], ids=["hosted", "custom"])
    async def test_upload_sanitizes_before_telemetry(self, is_async, sanitize_errors, span_exporter, tmp_path):
        from daytona._async.object_storage import AsyncObjectStorage
        from daytona._sync.object_storage import ObjectStorage
        from daytona.common.errors import DaytonaError

        cls = AsyncObjectStorage if is_async else ObjectStorage
        path = tmp_path / "context.txt"
        path.write_text("context", encoding="utf-8")
        original = PermissionError("backend-credential-marker")
        store = MagicMock()
        if is_async:
            store.head_async = AsyncMock(side_effect=original)
        else:
            store.head.side_effect = original
        with patch(f"{cls.__module__}.S3Store", return_value=store):
            storage = cls(
                "https://s3.example.com",
                "key",
                "secret",
                None,
                "bucket",
                region="us-east-2",
                sanitize_errors=sanitize_errors,
            )
        with pytest.raises(DaytonaError if sanitize_errors else PermissionError) as caught:
            response = storage.upload(str(path), "org-1")
            if is_async:
                await response
        spans = span_exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].events
        if sanitize_errors:
            assert caught.value.__context__ is None
            assert caught.value.__cause__ is None
            assert "backend-credential-marker" not in str(caught.value)
            assert "backend-credential-marker" not in spans[0].to_json()
        else:
            assert caught.value is original
            assert "backend-credential-marker" in spans[0].to_json()

    @pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
    @pytest.mark.parametrize("token", [None, ""])
    def test_constructor_omits_absent_session_token(self, is_async, token):
        from daytona._async.object_storage import AsyncObjectStorage
        from daytona._sync.object_storage import ObjectStorage

        cls = AsyncObjectStorage if is_async else ObjectStorage
        with patch(f"{cls.__module__}.S3Store") as mock_store_cls:
            cls("https://s3.example.com", "key", "secret", token, "bucket", region="us-east-2")
        assert "session_token" not in mock_store_cls.call_args.kwargs
        assert mock_store_cls.call_args.kwargs["access_key_id"] == "key"
        assert mock_store_cls.call_args.kwargs["secret_access_key"] == "secret"

    def test_constructor_configures_store(self):
        from daytona._sync.object_storage import ObjectStorage

        with patch("daytona._sync.object_storage.S3Store") as mock_store_cls:
            ObjectStorage("https://s3.us-west-2.amazonaws.com", "key", "secret", "token", region="ap-south-1")

        assert mock_store_cls.call_args.kwargs["region"] == "ap-south-1"
        assert mock_store_cls.call_args.kwargs["session_token"] == "token"
        assert mock_store_cls.call_args.kwargs["client_options"]["timeout"] == timedelta(minutes=2)
        assert mock_store_cls.call_args.kwargs["retry_config"]["retry_timeout"] == timedelta(minutes=4)

    def test_retry_budget_stays_within_credential_lifetime(self):
        from daytona._sync import object_storage

        assert object_storage.UPLOAD_RETRY_TIMEOUT < timedelta(minutes=5)

    def test_chunk_size_respects_s3_minimum_part_size(self):
        from daytona._sync import object_storage

        assert object_storage.UPLOAD_CHUNK_SIZE >= 5 * 1024 * 1024

    def test_constructor_requires_region(self):
        from daytona._sync.object_storage import ObjectStorage

        with pytest.raises(TypeError):
            ObjectStorage(
                "https://s3.us-west-2.amazonaws.com", "key", "secret", "token"
            )  # pylint: disable=missing-kwoa

    def test_upload_missing_path_raises(self):
        storage, _store = _make_storage()

        with pytest.raises(FileNotFoundError, match="Path does not exist"):
            storage.upload("/missing/path", "org-1")

    def test_compute_archive_base_path_trims_root_prefixes(self):
        from daytona._sync.object_storage import ObjectStorage

        assert ObjectStorage.compute_archive_base_path("/workspace/project") == "workspace/project"
        windows_style = ObjectStorage.compute_archive_base_path(r"\\workspace\\project")
        assert windows_style.startswith("workspace")
        assert not windows_style.startswith("\\")

    def test_file_exists_in_s3_true_when_head_succeeds(self):
        storage, store = _make_storage()

        assert storage._file_exists_in_s3("org/hash/context.tar") is True
        store.head.assert_called_once_with("org/hash/context.tar")

    def test_file_exists_in_s3_false_when_head_raises_not_found(self):
        storage, store = _make_storage()
        store.head.side_effect = FileNotFoundError()

        assert storage._file_exists_in_s3("org/hash/context.tar") is False

    def test_compute_hash_for_file_changes_with_contents(self, tmp_path: Path):
        storage, _store = _make_storage()
        file_path = tmp_path / "file.txt"
        file_path.write_text("one", encoding="utf-8")

        first_hash = storage._compute_hash_for_path_md5(str(file_path))
        file_path.write_text("two", encoding="utf-8")
        second_hash = storage._compute_hash_for_path_md5(str(file_path))

        assert first_hash != second_hash

    def test_compute_hash_for_directory_changes_with_new_file(self, tmp_path: Path):
        storage, _store = _make_storage()
        directory = tmp_path / "dir"
        directory.mkdir()
        (directory / "a.txt").write_text("a", encoding="utf-8")

        first_hash = storage._compute_hash_for_path_md5(str(directory))
        (directory / "b.txt").write_text("b", encoding="utf-8")
        second_hash = storage._compute_hash_for_path_md5(str(directory))

        assert first_hash != second_hash

    def test_upload_returns_existing_hash_without_uploading(self, tmp_path: Path):
        storage, _store = _make_storage()
        file_path = tmp_path / "file.txt"
        file_path.write_text("hello", encoding="utf-8")
        storage._compute_hash_for_path_md5 = MagicMock(return_value="hash123")
        storage._file_exists_in_s3 = MagicMock(return_value=True)
        storage._upload_as_tar = MagicMock()

        result = storage.upload(str(file_path), "org-1")

        assert result == "hash123"
        storage._file_exists_in_s3.assert_called_once_with("org-1/hash123/context.tar")
        storage._upload_as_tar.assert_not_called()

    def test_upload_uses_archive_base_path_when_uploading(self, tmp_path: Path):
        storage, _store = _make_storage()
        file_path = tmp_path / "file.txt"
        file_path.write_text("hello", encoding="utf-8")
        storage._compute_hash_for_path_md5 = MagicMock(return_value="hash123")
        storage._file_exists_in_s3 = MagicMock(return_value=False)
        storage._upload_as_tar = MagicMock()

        result = storage.upload(str(file_path), "org-1", archive_base_path="custom/base")

        assert result == "hash123"
        storage._compute_hash_for_path_md5.assert_called_once_with(str(file_path), "custom/base")
        storage._upload_as_tar.assert_called_once_with("org-1/hash123/context.tar", str(file_path), "custom/base")

    def test_upload_as_tar_streams_content_to_store(self, tmp_path: Path):
        storage, store = _make_storage()
        file_path = tmp_path / "file.txt"
        file_path.write_text("hello world", encoding="utf-8")

        captured: dict[str, bytes] = {}

        def consume_stream(key: str, chunks, **_kwargs):
            captured[key] = b"".join(chunks)

        store.put.side_effect = consume_stream

        storage._upload_as_tar("org/hash/context.tar", str(file_path), "base/file.txt")

        assert "org/hash/context.tar" in captured
        assert len(captured["org/hash/context.tar"]) > 0
        assert store.put.call_args.kwargs["max_concurrency"] == 4
        assert store.put.call_args.kwargs["chunk_size"] == 5 * 1024 * 1024
