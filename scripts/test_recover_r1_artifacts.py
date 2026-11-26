import base64
import hashlib
import importlib.util
import json
import io
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.error import HTTPError
import zipfile

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

SPEC = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("recover-r1-artifacts.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def asset(asset_id, name, data):
    return {"id": asset_id, "name": name, "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest(), "state": "uploaded"}


class FakeGitHub:
    """Memory-only release API. No subprocess, network or user directories."""
    def __init__(self, release_id=m.HELPER_RELEASE):
        self.release_id = release_id
        self.assets = {}
        self.data = {}
        self.mutations = []
        self.tag = m.OLD_HELPER
        self.release = {"id": release_id, "tag_name": m.HELPER_TAG, "draft": False, "prerelease": True, "target_commitish": "main", "body": "old notes"}
        self.fail_upload_name = None
        self.next_id = 100
        self.on_delete = None

    def add(self, name, data):
        self.next_id += 1
        self.assets[name] = asset(self.next_id, name, data)
        self.data[name] = data

    def listing(self, endpoint, field=None):
        if endpoint == "releases":
            return [dict(self.release)]
        if endpoint == f"releases/{self.release_id}/assets":
            return [dict(a) for a in self.assets.values()]
        raise AssertionError(endpoint)

    def repo(self, endpoint, method="GET", body=None):
        if method != "GET":
            self.mutations.append((method, endpoint, body))
        if method == "DELETE":
            target = next(a for a in self.assets.values() if endpoint == f"releases/assets/{a['id']}")
            if self.on_delete:
                self.on_delete(target["name"])
            del self.assets[target["name"]]
            del self.data[target["name"]]
            return None
        if endpoint.startswith("git/ref/tags/"):
            return {"object": {"type": "commit", "sha": self.tag}}
        if endpoint.startswith("git/refs/tags/"):
            self.tag = body["sha"]
            return {}
        if endpoint == f"releases/{self.release_id}":
            if method == "PATCH":
                self.release.update(body)
            return {**self.release, "assets": self.listing(f"releases/{self.release_id}/assets")}
        if endpoint == "releases/latest":
            return dict(self.release)
        if endpoint == "releases" and method == "POST":
            self.release.update(body)
            return dict(self.release)
        raise AssertionError((endpoint, method))

    def upload(self, release_id, path):
        assert release_id == self.release_id
        self.mutations.append(("UPLOAD", path.name, None))
        if path.name == self.fail_upload_name:
            self.fail_upload_name = None
            # Simulate a failed upload creating a GitHub starter record.
            self.add(path.name, b"")
            self.assets[path.name]["state"] = "starter"
            raise OSError("fixture upload failed")
        self.add(path.name, path.read_bytes())
        return self.assets[path.name]


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-r1-recovery-test-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_cancelled_overall_run_accepts_only_exact_successful_job(self):
        spec = m.RUNS["desktop-original"]
        run = {"id": spec[0], "repository": {"full_name": m.REPO}, "head_repository": {"full_name": m.REPO}, "head_sha": spec[1], "event": spec[2], "head_branch": spec[3], "path": ".github/workflows/" + spec[4], "run_attempt": 1, "status": "completed", "conclusion": "cancelled"}
        m.validate_run(run, spec)
        job = {"id": 123, "status": "completed", "conclusion": "success", "name": "Linux"}
        self.assertEqual(m.require_job([job], 123, "Linux"), job)
        for change in ({"head_sha": "a" * 40}, {"event": "pull_request"}, {"run_attempt": 2}, {"repository": {"full_name": "other/fork"}}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                m.validate_run({**run, **change}, spec)
        with self.assertRaises(RuntimeError):
            m.require_job([{**job, "conclusion": "cancelled"}], 123)

    def test_download_accept_distinguishes_actions_redirects_and_release_entities(self):
        api = m.GitHub.__new__(m.GitHub)
        cases = [
            ("actions/artifacts/15086239867/zip", "application/vnd.github+json"),
            ("actions/jobs/139722946978/logs", "application/vnd.github+json"),
            ("actions/runs/45764776182/logs", "application/vnd.github+json"),
            ("releases/assets/687510727", "application/octet-stream"),
        ]
        for index, (endpoint, expected_accept) in enumerate(cases):
            with self.subTest(endpoint=endpoint):
                api.open = Mock(return_value=io.BytesIO(b"fixture"))
                api.download(endpoint, self.root / f"download-{index}")
                api.open.assert_called_once_with(f"/repos/{m.REPO}/{endpoint}", accept=expected_accept)

    def test_api_http_failure_reports_safe_path_status_body_without_token_or_signed_url(self):
        api = m.GitHub.__new__(m.GitHub)
        api.token = "fixture-private-token"
        body = json.dumps({"message": "Unsupported Media Type", "token": api.token, "documentation_url": "https://docs.github.com/rest", "download": "https://store.blob.core.windows.net/file?sig=fixture-secret"}).encode()
        api.opener = Mock()
        api.opener.open.side_effect = HTTPError("https://api.github.com/private?secret=query-secret", 415, "Unsupported Media Type", {}, io.BytesIO(body))
        with self.assertRaises(RuntimeError) as caught:
            api.open(f"/repos/{m.REPO}/actions/artifacts/1/zip?secret=query-secret")
        message = str(caught.exception)
        self.assertIn(f"GET /repos/{m.REPO}/actions/artifacts/1/zip: HTTP 415", message)
        self.assertIn("Unsupported Media Type", message)
        for secret in (api.token, "https://", "fixture-secret", "query-secret"):
            self.assertNotIn(secret, message)
        self.assertLess(len(message), 1200)

    def test_download_redirect_keeps_auth_off_storage_and_sanitizes_storage_failure(self):
        api = m.GitHub.__new__(m.GitHub)
        api.token = "fixture-token"
        endpoint = "actions/artifacts/1/zip"
        location = "https://fixture.blob.core.windows.net/file?sig=never-log-me"
        redirect = lambda: HTTPError("https://api.github.com/fixture", 302, "Found", {"Location": location}, io.BytesIO())
        api.opener = Mock()
        api.opener.open.side_effect = [redirect(), io.BytesIO(b"fixture")]
        api.download(endpoint, self.root / "redirected")
        first, second = [call.args[0] for call in api.opener.open.call_args_list]
        self.assertEqual(first.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(first.get_header("Authorization"), "Bearer fixture-token")
        self.assertIsNone(second.get_header("Authorization"))
        api.opener.open.side_effect = [redirect(), HTTPError(location, 403, "Forbidden", {}, io.BytesIO((location + " " + api.token).encode()))]
        with self.assertRaises(RuntimeError) as caught:
            api.download(endpoint, self.root / "failed")
        message = str(caught.exception)
        self.assertIn("actions/artifacts/1/zip: HTTP 403", message)
        self.assertNotIn("never-log-me", message)
        self.assertNotIn(api.token, message)
        self.assertNotIn("https://", message)
        self.assertFalse((self.root / "failed").exists())

    def test_download_rejects_wrong_server_digest_and_size(self):
        api = m.GitHub.__new__(m.GitHub)
        data = b"artifact zip fixture"
        api.open = lambda *args, **kwargs: io.BytesIO(data)
        destination = self.root / "download"
        expected = hashlib.sha256(data).hexdigest()
        api.download("actions/artifacts/1/zip", destination, expected, len(data))
        self.assertEqual(destination.read_bytes(), data)
        for index, (checksum, size) in enumerate([("0" * 64, len(data)), (expected, len(data) + 1)]):
            with self.assertRaisesRegex(RuntimeError, "mismatch"):
                api.download("actions/artifacts/1/zip", self.root / f"bad-{index}", checksum, size)

    def backup_fixture(self):
        record = {"id": 123, "name": "remote-r1-desktop-recovery-456", "expired": False,
                  "workflow_run": {"id": 456, "head_sha": "a" * 40},
                  "digest": "sha256:" + "b" * 64, "size_in_bytes": 10}
        api = Mock()
        api.listing.return_value = [record]
        api.repo.return_value = record
        env = {"RECOVERY_BACKUP_ARTIFACT_ID": "123", "GITHUB_RUN_ID": "456", "GITHUB_SHA": "a" * 40,
               "RECOVERY_BACKUP_ARTIFACT_DIGEST": "b" * 64}
        now = [0.0]
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds
        return api, record, env, now, sleeps, sleep

    def test_uploaded_backup_404_retries_metadata_and_zip_only_after_positive_inventory(self):
        api, record, env, now, sleeps, sleep = self.backup_fixture()
        endpoint = f"/repos/{m.REPO}/actions/artifacts/123"
        missing = lambda path: m.http_failure(path, "GET", 404, b"Not Found", "")
        api.repo.side_effect = [missing(endpoint), record, record]
        api.download.side_effect = [missing(endpoint + "/zip"), None]
        with patch.dict(m.os.environ, env), patch.object(m.time, "monotonic", side_effect=lambda: now[0]), patch.object(m.time, "sleep", side_effect=sleep):
            self.assertEqual(m.download_uploaded_backup(api, "desktop", self.root), self.root / "durable-backup.zip")
        self.assertEqual(sleeps, [2, 4])
        api.listing.assert_called_once_with("actions/runs/456/artifacts", "artifacts")
        self.assertEqual(api.repo.call_count, 3)
        self.assertEqual(api.download.call_count, 2)
        self.assertTrue(all(call.args == ("actions/artifacts/123",) and not call.kwargs for call in api.repo.call_args_list))

    def test_uploaded_backup_visibility_retries_stop_within_two_minutes(self):
        api, record, env, now, sleeps, sleep = self.backup_fixture()
        api.download.side_effect = m.http_failure(f"/repos/{m.REPO}/actions/artifacts/123/zip", "GET", 404, b"missing", "")
        with patch.dict(m.os.environ, env), patch.object(m.time, "monotonic", side_effect=lambda: now[0]), patch.object(m.time, "sleep", side_effect=sleep), self.assertRaisesRegex(RuntimeError, "after 120 seconds"):
            m.download_uploaded_backup(api, "desktop", self.root)
        self.assertEqual(sleeps, [2, 4, 8, 16, 30, 30, 30])
        self.assertEqual(sum(sleeps), 120)
        self.assertEqual(api.download.call_count, 7)

    def test_backup_retry_requires_exact_unexpired_current_run_upload(self):
        for change in ("absent", "id", "expired", "run", "digest"):
            api, record, env, _, _, _ = self.backup_fixture()
            if change == "absent": api.listing.return_value = []
            elif change == "id": record["id"] = 789
            elif change == "expired": record["expired"] = True
            elif change == "run": record["workflow_run"]["id"] = 789
            else: record["digest"] = "sha256:" + "c" * 64
            with self.subTest(change=change), patch.dict(m.os.environ, env), patch.object(m.time, "sleep") as sleep, self.assertRaises(RuntimeError):
                m.download_uploaded_backup(api, "desktop", self.root)
            sleep.assert_not_called()
            api.download.assert_not_called()
            api.repo.assert_not_called()

    def test_backup_retry_does_not_swallow_other_status_paths_or_mutations(self):
        for status, method, path in ((403, "GET", "actions/artifacts/123/zip"), (404, "GET", "actions/artifacts/999/zip"), (404, "PATCH", "actions/artifacts/123")):
            api, _, env, _, _, _ = self.backup_fixture()
            api.download.side_effect = m.http_failure(f"/repos/{m.REPO}/{path}", method, status, b"fixture", "")
            with self.subTest(status=status, method=method, path=path), patch.dict(m.os.environ, env), patch.object(m.time, "sleep") as sleep, self.assertRaises(m.GitHubHttpError):
                m.download_uploaded_backup(api, "desktop", self.root)
            sleep.assert_not_called()
            api.download.assert_called_once()

    def test_backup_read_http_timeout_respects_remaining_budget(self):
        api = m.GitHub.__new__(m.GitHub)
        api.backup_read_deadline = 120
        with patch.object(m.time, "monotonic", return_value=115):
            self.assertEqual(api.read_timeout(), 5)
        with patch.object(m.time, "monotonic", return_value=120), self.assertRaisesRegex(RuntimeError, "deadline"):
            api.read_timeout()

    def test_final_notes_follow_later_user_scope_without_touching_tag_snapshot(self):
        import subprocess
        original = subprocess.check_output(["git", "show", f"{m.SOURCE}:docs/release-notes/{m.TAG}-remote-zh.md"], cwd=Path(__file__).parents[1]).decode("utf-8")
        result = m.final_desktop_notes(original, "2026-11-26T00:00:00Z")
        self.assertNotIn("Windows/macOS 目前为锁定工具链契约审查", result)
        self.assertNotIn("macOS.dmg", result)
        self.assertNotIn("45755465267", result)
        self.assertIn("本版不提供 macOS 桌面包或 macOS Helper", result)
        self.assertIn("后续也停止构建和发布", result)
        self.assertIn("不删除任何历史桌面 release", result)
        self.assertIn("三份 updater", result)
        self.assertIn("13 个", result)
        self.assertIn(m.SOURCE, result)
        self.assertIn("Windows 安装版重新运行 MSI", result)
        self.assertIn("没有执行真实安装", result)

    def test_exact_platform_allowlists_have_11_desktop_and_4_helper_files(self):
        desktop = [name for row in m.ARTIFACTS["desktop"] for name in row[4]]
        helper = [name for row in m.ARTIFACTS["helper"] for name in row[4]]
        self.assertEqual(len(set(desktop)), 11)
        self.assertEqual(len(set(helper)), 4)
        self.assertEqual(set(m.ARTIFACT_PINS), {row[3] for rows in m.ARTIFACTS.values() for row in rows})
        self.assertFalse(any("macOS" in name for name in m.ARTIFACT_PINS))
        self.assertEqual(set(m.RUNS), {"desktop-original", "helper-original"})
        self.assertEqual(sum(name.endswith(".sig") for name in desktop), 3)
        self.assertTrue(all(name.startswith(m.PREFIX) for name in desktop))
        self.assertTrue(all(m.SOURCE[:8] in name or "-latest-" in name for name in helper))

    def test_zip_extraction_requires_flat_exact_list_and_regular_files(self):
        for names, mode in [(["../escape"], 0), (["/absolute"], 0), (["C:escape"], 0), (["safe", "safe"], 0), (["safe"], stat.S_IFLNK | 0o777)]:
            archive = self.root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as zipped:
                for name in names:
                    info = zipfile.ZipInfo(name)
                    info.external_attr = mode << 16
                    zipped.writestr(info, b"fixture")
            with self.subTest(names=names), self.assertRaises(RuntimeError):
                m.safe_extract(archive, self.root / "out", ["safe"])
            self.assertFalse((self.root / "out").exists())
        with zipfile.ZipFile(self.root / "good.zip", "w") as zipped:
            zipped.writestr("safe", b"fixture")
        m.safe_extract(self.root / "good.zip", self.root / "out", ["safe"])
        self.assertEqual((self.root / "out/safe").read_bytes(), b"fixture")

    def test_durable_backup_checks_nested_bytes_not_just_artifact_id(self):
        (self.root / "backup/assets").mkdir(parents=True)
        (self.root / "evidence").mkdir()
        (self.root / "plan.json").write_text("plan")
        (self.root / "backup/assets/old-helper").write_bytes(b"old immutable bytes")
        (self.root / "evidence/run.json").write_text("evidence")
        files = ["plan.json", "backup/assets/old-helper", "evidence/run.json"]
        archive = self.root / "backup.zip"
        for wrong in (False, True):
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("backup/assets/", b"")
                for name in files:
                    zipped.writestr(name, b"wrong" if wrong and name.endswith("old-helper") else (self.root / name).read_bytes())
            if wrong:
                with self.assertRaisesRegex(RuntimeError, "size mismatch|content differs"):
                    m.verify_backup_archive(archive, self.root)
            else:
                m.verify_backup_archive(archive, self.root)

    def signing_fixture(self, algorithm):
        private = Ed25519PrivateKey.generate()
        key_id = bytes.fromhex("E490AF071AC1237F")[::-1]
        public_packet = b"Ed" + key_id + private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        public = base64.b64encode(b"untrusted comment: fixture\n" + base64.b64encode(public_packet) + b"\n").decode()
        data = b"fixture signed artifact\x00" * 4096
        file = self.root / "artifact"
        file.write_bytes(data)
        message = hashlib.blake2b(data).digest() if algorithm == b"ED" else data
        signature = private.sign(message)
        packet = algorithm + key_id + signature
        comment = b"timestamp:1\tfile:artifact"
        global_signature = private.sign(signature + comment)
        lines = [b"untrusted comment: fixture", base64.b64encode(packet), b"trusted comment: " + comment, base64.b64encode(global_signature)]
        armored = base64.b64encode(b"\n".join(lines)).decode()
        return file, public, armored, lines

    def test_minisign_verifies_prehashed_and_raw_and_trusted_comment(self):
        for algorithm in (b"ED", b"Ed"):
            with self.subTest(algorithm=algorithm):
                file, public, signature, lines = self.signing_fixture(algorithm)
                self.assertEqual(m.verify_minisign(file, signature, public)["artifactSignature"], "valid")
                lines[2] += b" altered"
                with self.assertRaises(InvalidSignature):
                    m.verify_minisign(file, base64.b64encode(b"\n".join(lines)).decode(), public)
                file.write_bytes(file.read_bytes() + b"tampered")
                with self.assertRaises(InvalidSignature):
                    m.verify_minisign(file, signature, public)

    def test_signature_rejects_wrong_key_id_and_malformed_armor(self):
        file, public, signature, _ = self.signing_fixture(b"ED")
        lines = base64.b64decode(public).splitlines()
        key = bytearray(base64.b64decode(lines[1])); key[2] ^= 1
        lines[1] = base64.b64encode(key)
        with self.assertRaises(RuntimeError):
            m.verify_minisign(file, signature, base64.b64encode(b"\n".join(lines)).decode())
        with self.assertRaises(Exception):
            m.verify_minisign(file, "not armor", public)

    def helper_fixture(self):
        api = FakeGitHub()
        assets = self.root / "assets"; assets.mkdir()
        backup = self.root / "backup/assets"; backup.mkdir(parents=True)
        old_hashes = {}
        for platform in m.LEGACY_PLATFORMS:
            old = ("old-" + platform).encode()
            old_hashes[platform] = hashlib.sha256(old).hexdigest()
            for version in (m.OLD_HELPER[:8], "latest"):
                name = f"cc-switch-remote-helper-{version}-{platform}"
                api.add(name, old)
                if name in m.OLD_ASSET_IDS:
                    api.assets[name]["id"] = m.OLD_ASSET_IDS[name]
                (backup / name).write_bytes(old)
            if platform not in m.PLATFORMS:
                continue
            for version in (m.SOURCE[:8], "latest"):
                (assets / f"cc-switch-remote-helper-{version}-{platform}").write_bytes(("new-" + platform).encode())
        before = m.helper_state(api)
        plan = {"assets": m.manifest(assets), "backupManifest": m.manifest(backup), "helperBefore": before}
        return api, plan, old_hashes

    def test_helper_promotes_full_set_before_deleting_old_versioned_assets(self):
        api, plan, old_hashes = self.helper_fixture()
        def deletion(name):
            if name in m.OLD_ASSET_IDS:
                self.assertEqual(api.tag, m.SOURCE)
                for candidate, item in plan["assets"].items():
                    self.assertTrue(m.matches(api.assets[candidate], item))
        api.on_delete = deletion
        with patch.object(m, "OLD_HASHES", old_hashes):
            m.apply_helper(api, self.root, plan)
        self.assertEqual(set(api.assets), set(plan["assets"]))
        self.assertEqual(len(api.assets), 4)
        self.assertFalse(any("macOS" in name for name in api.assets))
        self.assertEqual(api.tag, m.SOURCE)
        self.assertTrue(api.release["prerelease"])
        self.assertEqual(api.release["make_latest"], "false")
        plan["helperBefore"] = m.helper_state(api)
        api.mutations.clear()
        m.apply_helper(api, self.root, plan)
        self.assertEqual(api.mutations, [])

    def test_helper_failed_alias_upload_restores_previous_bytes_notes_and_tag(self):
        api, plan, old_hashes = self.helper_fixture()
        api.fail_upload_name = "cc-switch-remote-helper-latest-Linux-arm64"
        with patch.object(m, "OLD_HASHES", old_hashes), self.assertRaisesRegex(RuntimeError, "prior aliases/tag restored"):
            m.apply_helper(api, self.root, plan)
        self.assertEqual(api.tag, m.OLD_HELPER)
        self.assertEqual(api.release["body"], "old notes")
        for name, item in plan["backupManifest"].items():
            self.assertTrue(m.matches(api.assets[name], item))
        self.assertFalse(any(method == "DELETE" and m.OLD_HELPER[:8] in str(body) for method, _, body in api.mutations))

    def test_helper_owner_preadvanced_tag_and_existing_candidates_need_no_ref_patch(self):
        api, plan, old_hashes = self.helper_fixture()
        api.tag = m.SOURCE
        for name in plan["assets"]:
            if "-latest-" not in name:
                api.add(name, (self.root / "assets" / name).read_bytes())
        plan["helperBefore"] = m.helper_state(api)
        original_repo = api.repo
        def deny_ref_patch(endpoint, **kwargs):
            self.assertFalse(endpoint.startswith("git/refs/") and kwargs.get("method") == "PATCH")
            return original_repo(endpoint, **kwargs)
        api.repo = deny_ref_patch
        with patch.object(m, "OLD_HASHES", old_hashes):
            m.apply_helper(api, self.root, plan)
        self.assertEqual(api.tag, m.SOURCE)
        self.assertEqual(set(api.assets), set(plan["assets"]))
        self.assertEqual([name for method, name, _ in api.mutations if method == "UPLOAD"],
                         [f"cc-switch-remote-helper-latest-{platform}" for platform in m.PLATFORMS])

    def test_helper_denied_promotion_restores_aliases_without_repatching_unchanged_old_tag(self):
        api, plan, old_hashes = self.helper_fixture()
        original_repo = api.repo
        ref_patches = []
        def deny_ref_patch(endpoint, **kwargs):
            if endpoint.startswith("git/refs/") and kwargs.get("method") == "PATCH":
                ref_patches.append(kwargs["body"]["sha"])
                raise m.http_failure(f"/repos/{m.REPO}/{endpoint}", "PATCH", 403, b"Resource not accessible by integration", "")
            return original_repo(endpoint, **kwargs)
        api.repo = deny_ref_patch
        with patch.object(m, "OLD_HASHES", old_hashes), self.assertRaisesRegex(RuntimeError, "prior aliases/tag restored"):
            m.apply_helper(api, self.root, plan)
        self.assertEqual(ref_patches, [m.SOURCE])
        self.assertEqual(api.tag, m.OLD_HELPER)
        self.assertEqual(api.release["body"], "old notes")
        for name, item in plan["backupManifest"].items():
            self.assertTrue(m.matches(api.assets[name], item))

    def test_helper_owner_prepared_metadata_skips_patch_but_verifies_and_promotes_assets(self):
        api, plan, old_hashes = self.helper_fixture()
        api.tag = m.SOURCE
        desired = m.helper_target_metadata()
        api.release.update(desired)
        for name in plan["assets"]:
            if "-latest-" not in name:
                api.add(name, (self.root / "assets" / name).read_bytes())
        plan["helperBefore"] = m.helper_state(api)
        original_repo = api.repo
        metadata_reads = []
        def deny_metadata_and_ref_patch(endpoint, **kwargs):
            self.assertFalse(kwargs.get("method") == "PATCH", "Preset metadata/tag must not require write permission")
            if endpoint == f"releases/{m.HELPER_RELEASE}":
                metadata_reads.append(endpoint)
            return original_repo(endpoint, **kwargs)
        api.repo = deny_metadata_and_ref_patch
        with patch.object(m, "OLD_HASHES", old_hashes):
            m.apply_helper(api, self.root, plan)
        self.assertGreaterEqual(len(metadata_reads), 2)  # Snapshot and fresh promotion check.
        self.assertEqual(api.tag, m.SOURCE)
        self.assertTrue(all(api.release[key] == value for key, value in desired.items()))
        self.assertEqual(set(api.assets), set(plan["assets"]))
        self.assertTrue(all(m.matches(api.assets[name], item) for name, item in plan["assets"].items()))
        self.assertEqual([name for method, name, _ in api.mutations if method == "UPLOAD"],
                         [f"cc-switch-remote-helper-latest-{platform}" for platform in m.PLATFORMS])

    def test_helper_rollback_skips_unchanged_metadata_patch_and_restores_backup_bytes(self):
        api, plan, old_hashes = self.helper_fixture()
        api.tag = m.SOURCE
        api.release.update(m.helper_target_metadata())
        plan["helperBefore"] = m.helper_state(api)
        api.fail_upload_name = "cc-switch-remote-helper-latest-Linux-arm64"
        original_repo = api.repo
        def deny_metadata_and_ref_patch(endpoint, **kwargs):
            self.assertFalse(kwargs.get("method") == "PATCH", "Unchanged rollback metadata/tag must not be rewritten")
            return original_repo(endpoint, **kwargs)
        api.repo = deny_metadata_and_ref_patch
        with patch.object(m, "OLD_HASHES", old_hashes), self.assertRaisesRegex(RuntimeError, "prior aliases/tag restored"):
            m.apply_helper(api, self.root, plan)
        self.assertEqual(api.tag, plan["helperBefore"]["tagSha"])
        for key in ("body", "target_commitish", "prerelease"):
            self.assertEqual(api.release[key], plan["helperBefore"]["release"][key])
        for name, item in plan["backupManifest"].items():
            self.assertTrue(m.matches(api.assets[name], item), name)
        self.assertFalse(any(method == "PATCH" for method, _, _ in api.mutations))

    def test_helper_stops_before_mutation_when_release_changed_since_backup(self):
        api, plan, _ = self.helper_fixture()
        api.add("foreign", b"unknown")
        with self.assertRaisesRegex(RuntimeError, "changed since backup"):
            m.apply_helper(api, self.root, plan)
        self.assertFalse(api.mutations)

    def desktop_fixture(self, draft=True):
        api = FakeGitHub(321)
        assets = self.root / "assets"; assets.mkdir()
        (assets / "fixture.msi").write_bytes(b"candidate")
        expected = m.manifest(assets)
        body = m.MARKER + " pub_date=2026-11-26T00:00:00Z -->"
        api.release.update(tag_name=m.TAG, target_commitish=m.SOURCE, prerelease=False, draft=draft, body=body)
        plan = {"assets": expected, "body": body, "existingReleaseId": 321}
        (self.root / "evidence").mkdir()
        return api, plan

    def test_only_fixed_empty_owner_draft_can_initialize_notes_without_tag_or_target_patch(self):
        api, plan = self.desktop_fixture()
        api.release_id = m.OWNER_DRAFT_ID
        api.release.update(id=m.OWNER_DRAFT_ID, body=m.OWNER_DRAFT_MARKER, name="CC Switch Remote 4.0.21 Remote r1")
        owner = dict(api.release)
        for change in ({"id": 999}, {"body": m.OWNER_DRAFT_MARKER + " extra"}, {"draft": False},
                       {"prerelease": True}, {"target_commitish": "a" * 40}, {"tag_name": "other"}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                m.desktop_notes_date(api, {**owner, **change})
        api.add("fixture.msi", b"candidate")
        with self.assertRaisesRegex(RuntimeError, "no assets"):
            m.desktop_notes_date(api, owner)
        api.assets.clear(); api.data.clear()
        pub_date, initialize = m.desktop_notes_date(api, owner)
        self.assertTrue(initialize)
        self.assertRegex(pub_date, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        plan.update(existingReleaseId=m.OWNER_DRAFT_ID, initializeOwnerDraft=True,
                    body=f"Full verified notes\n{m.MARKER} pub_date={pub_date} -->\n")
        self.assertFalse(api.mutations, "Preparation must remain read-only")
        with patch.object(m, "publication_preflight"):
            m.apply_desktop(api, self.root, self.root, plan)
        method, endpoint, payload = api.mutations[0]
        self.assertEqual((method, endpoint), ("PATCH", f"releases/{m.OWNER_DRAFT_ID}"))
        self.assertEqual(set(payload), {"body", "name"})
        self.assertEqual(payload["body"], plan["body"])
        self.assertFalse(any(method == "POST" for method, _, _ in api.mutations))
        for method, _, body in api.mutations:
            if method == "PATCH":
                self.assertNotIn("target_commitish", body)
                self.assertNotIn("tag_name", body)
        self.assertEqual(api.release["body"], plan["body"])
        self.assertFalse(api.release["draft"])
        self.assertEqual(m.desktop_notes_date(api, api.release), (pub_date, False))
        self.assertTrue(m.matches(api.assets["fixture.msi"], plan["assets"]["fixture.msi"]))

    def test_desktop_draft_is_published_only_after_upload_hash_and_fresh_inventory(self):
        api, plan = self.desktop_fixture()
        checks = []
        def preflight(*args):
            checks.append(len(api.assets))
        with patch.object(m, "publication_preflight", preflight):
            m.apply_desktop(api, self.root, self.root, plan)
        self.assertEqual(checks, [0, 1])
        self.assertFalse(api.release["draft"])
        self.assertEqual(api.release["make_latest"], "true")
        self.assertEqual(api.mutations[-1][0], "PATCH")

    def test_desktop_newer_inventory_leaves_uploaded_draft_unpublished(self):
        api, plan = self.desktop_fixture()
        with patch.object(m, "publication_preflight", side_effect=[None, RuntimeError("new release appeared")]), self.assertRaisesRegex(RuntimeError, "new release appeared"):
            m.apply_desktop(api, self.root, self.root, plan)
        self.assertTrue(api.release["draft"])
        self.assertEqual(len(api.assets), 1)
        self.assertFalse(any(method == "DELETE" for method, _, _ in api.mutations))

    def test_desktop_complete_matching_release_is_idempotent_and_mismatch_is_not_recreated(self):
        api, plan = self.desktop_fixture(draft=False)
        api.add("fixture.msi", b"candidate")
        m.apply_desktop(api, self.root, self.root, plan)
        self.assertFalse(api.mutations)
        api.assets["fixture.msi"]["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(RuntimeError, "differs"):
            m.apply_desktop(api, self.root, self.root, plan)
        self.assertFalse(api.mutations)

    def test_resume_only_discards_starter_never_a_valid_different_asset(self):
        api, plan = self.desktop_fixture()
        file = self.root / "assets/fixture.msi"
        api.add(file.name, b"")
        api.assets[file.name]["state"] = "starter"
        m.ensure_upload(api, 321, file, plan["assets"][file.name])
        self.assertTrue(m.matches(api.assets[file.name], plan["assets"][file.name]))
        api.assets[file.name]["digest"] = "sha256:" + "1" * 64
        count = len(api.mutations)
        with self.assertRaises(RuntimeError):
            m.ensure_upload(api, 321, file, plan["assets"][file.name])
        self.assertEqual(len(api.mutations), count)


if __name__ == "__main__":
    unittest.main()
