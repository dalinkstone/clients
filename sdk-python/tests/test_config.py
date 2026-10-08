# Copyright Daytona Platforms Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from copy import deepcopy
from unittest.mock import patch

import pytest
from pydantic import SecretStr, ValidationError

from daytona import BuildContextStorageConfig, DaytonaConfig
from daytona._utils.env import DaytonaEnvReader


class TestBuildContextStorageConfig:
    @pytest.mark.parametrize(
        "invalid",
        [
            {"region_id": " "},
            {"region": ""},
            {"bucket_name": "\t"},
            {"organization_id": "../org"},
            {"organization_id": "org/other"},
            {"endpoint_url": "http://s3.example.com"},
            {"endpoint_url": "https://storage-secret-value@s3.example.com"},
            {"endpoint_url": "https://s3.example.com?token=storage-secret-value"},
            {"endpoint_url": "https://s3.example.com#storage-secret-value"},
            {"endpoint_url": "https:///missing-host"},
            {"access_key_id": None},
            {"secret_access_key": " "},
            {"access_key_id": SecretStr(" ")},
            {"secret_access_key": SecretStr(" ")},
        ],
    )
    def test_invalid_descriptor_has_redacted_errors(self, build_context_storage, invalid):
        values = build_context_storage.model_dump()
        values.update(invalid)
        for model, args in (
            (BuildContextStorageConfig, values),
            (DaytonaConfig, {"build_context_storage": values}),
        ):
            with pytest.raises(ValidationError) as caught:
                model(**args)
            assert "storage-secret-value" not in str(caught.value)
            assert "storage-access-value" not in repr(caught.value)
            assert "input_value" not in str(caught.value)
            for rendered in (repr(caught.value.errors()), caught.value.json()):
                assert "storage-secret-value" not in rendered
                assert "storage-access-value" not in rendered

    @pytest.mark.parametrize("invalid", ["missing-bucket", "endpoint", "endpoint-port", "field-type"])
    def test_structured_errors_redact_raw_inputs_without_mutation(self, invalid, build_context_storage):
        values = build_context_storage.model_dump()
        for name in ("access_key_id", "secret_access_key", "session_token"):
            values[name] = values[name].get_secret_value()
        if invalid == "missing-bucket":
            del values["bucket_name"]
        elif invalid == "endpoint":
            values["endpoint_url"] = "https://storage-access-value:storage-secret-value@s3.example.com"
        elif invalid == "endpoint-port":
            values["endpoint_url"] = "https://s3.example.com:storage-secret-value"
        else:
            values["secret_access_key"] = {"invalid": "storage-secret-value"}
        original = deepcopy(values)
        for model, args in (
            (BuildContextStorageConfig, values),
            (DaytonaConfig, {"build_context_storage": values}),
        ):
            with pytest.raises(ValidationError) as caught:
                model.model_validate(args)
            for rendered in (str(caught.value), repr(caught.value.errors()), caught.value.json()):
                for secret in ("storage-access-value", "storage-secret-value", "storage-session-value"):
                    assert secret not in rendered
            for detail in caught.value.errors():
                error = detail.get("ctx", {}).get("error")
                if error is not None:
                    assert error.__context__ is None
            assert values == original

    def test_config_and_copies_are_frozen(self, build_context_storage):
        for config in (build_context_storage, build_context_storage.model_copy()):
            with pytest.raises(ValidationError) as caught:
                config.region_id = "eu"
            assert caught.value.errors()[0]["type"] == "frozen_instance"
            assert config.region_id == "us"

    @pytest.mark.parametrize("missing", ["access_key_id", "secret_access_key", "organization_id", "bucket_name"])
    def test_required_fields(self, build_context_storage, missing):
        values = build_context_storage.model_dump()
        del values[missing]
        with pytest.raises(ValidationError):
            BuildContextStorageConfig(**values)

    @pytest.mark.parametrize("token", [None, "", " ", SecretStr(" ")])
    def test_session_token_is_optional(self, build_context_storage, token):
        values = build_context_storage.model_dump()
        values["session_token"] = token
        assert BuildContextStorageConfig(**values).session_token is None


class TestDaytonaEnvReader:
    def test_get_rejects_non_daytona_variable_names(self):
        reader = DaytonaEnvReader()

        with pytest.raises(ValueError, match="must start with 'DAYTONA_'"):
            reader.get("OTHER_VAR")

    def test_runtime_env_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("DAYTONA_API_KEY", "runtime")

        with patch.object(
            DaytonaEnvReader, "_load", side_effect=[{"DAYTONA_API_KEY": "local"}, {"DAYTONA_API_KEY": "env"}]
        ):
            reader = DaytonaEnvReader()

        assert reader.get("DAYTONA_API_KEY") == "runtime"

    def test_env_local_takes_precedence_over_env_file(self, monkeypatch):
        monkeypatch.delenv("DAYTONA_API_KEY", raising=False)

        with patch.object(
            DaytonaEnvReader, "_load", side_effect=[{"DAYTONA_API_KEY": "local"}, {"DAYTONA_API_KEY": "env"}]
        ):
            reader = DaytonaEnvReader()

        assert reader.get("DAYTONA_API_KEY") == "local"

    def test_get_returns_none_for_missing_variable(self, monkeypatch):
        monkeypatch.delenv("DAYTONA_API_KEY", raising=False)

        with patch.object(DaytonaEnvReader, "_load", side_effect=[{}, {}]):
            reader = DaytonaEnvReader()

        assert reader.get("DAYTONA_API_KEY") is None

    def test_load_filters_non_daytona_and_none_values(self):
        with patch(
            "daytona._utils.env.dotenv_values",
            return_value={"DAYTONA_API_KEY": "key", "OTHER": "nope", "DAYTONA_TARGET": None},
        ):
            assert DaytonaEnvReader._load(".env") == {"DAYTONA_API_KEY": "key"}


class TestDaytonaEnvReaderTrustSeparation:
    """The endpoint must be resolvable without consulting the working directory."""

    def test_get_from_process_env_ignores_dotenv_files(self, monkeypatch):
        monkeypatch.delenv("DAYTONA_API_URL", raising=False)

        with patch.object(
            DaytonaEnvReader,
            "_load",
            side_effect=[
                {"DAYTONA_API_URL": "http://local.example/api"},
                {"DAYTONA_API_URL": "http://env.example/api"},
            ],
        ):
            reader = DaytonaEnvReader()

        assert reader.get("DAYTONA_API_URL") == "http://local.example/api"
        assert reader.get_from_process_env("DAYTONA_API_URL") is None

    def test_get_from_process_env_reads_the_process_environment(self, monkeypatch):
        monkeypatch.setenv("DAYTONA_API_URL", "https://runtime.example/api")

        with patch.object(DaytonaEnvReader, "_load", side_effect=[{}, {"DAYTONA_API_URL": "http://env.example/api"}]):
            reader = DaytonaEnvReader()

        assert reader.get_from_process_env("DAYTONA_API_URL") == "https://runtime.example/api"

    def test_get_from_file_ignores_the_process_environment(self, monkeypatch):
        monkeypatch.setenv("DAYTONA_API_URL", "https://runtime.example/api")

        with patch.object(DaytonaEnvReader, "_load", side_effect=[{}, {"DAYTONA_API_URL": "http://env.example/api"}]):
            reader = DaytonaEnvReader()

        assert reader.get_from_file("DAYTONA_API_URL") == "http://env.example/api"

    def test_new_accessors_reject_non_daytona_variable_names(self):
        reader = DaytonaEnvReader()

        with pytest.raises(ValueError, match="must start with 'DAYTONA_'"):
            reader.get_from_process_env("OTHER_VAR")

        with pytest.raises(ValueError, match="must start with 'DAYTONA_'"):
            reader.get_from_file("OTHER_VAR")
