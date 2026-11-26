#!/usr/bin/env python3
"""One-off Remote r1 artifact recovery. No build/install/test or arbitrary-run input.

prepare is read-only on GitHub. apply requires the prepared evidence/rollback
backup to have been uploaded as a workflow artifact before its first mutation.
All network mutations are confined to apply and fixed fork release endpoints.
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
import zipfile

REPO = "PowerDi/cc-switch-remote"
TAG = "remote-v4.0.21-r1"
SOURCE = "c0b701e44bf89fb1d264236949a3af2745af1989"
OLD_HELPER = "ed4353caf8536d8a7b902e799ff5f59c082178d5"
HELPER_TAG = "remote-helper-latest"
HELPER_RELEASE = 411740731
PREFIX = f"CC-Switch-Remote-{TAG}-"
MARKER = f"<!-- remote-r1-artifact-recovery source={SOURCE}"
PLATFORMS = ("Linux-x86_64", "Linux-arm64")
LEGACY_PLATFORMS = (*PLATFORMS, "macOS-universal")
REQUIRED_PLATFORMS = "windows-x86_64,linux-x86_64,linux-aarch64"
OLD_ASSET_IDS = {
    "cc-switch-remote-helper-ed4353ca-Linux-arm64": 687510727,
    "cc-switch-remote-helper-ed4353ca-Linux-x86_64": 687510726,
    "cc-switch-remote-helper-ed4353ca-macOS-universal": 687510750,
    "cc-switch-remote-helper-latest-macOS-universal": 687510815,
}
OLD_HASHES = {
    "Linux-x86_64": "5b01a309a533dded203ef56ca91fa76a8d1a0839e735bd87916df0baaf818edb",
    "Linux-arm64": "0094f1002f11d6252c08ee75e8ac17841841f4f7cbcc1138eee71bf591a216bb",
    "macOS-universal": "0505f4ca79f6cbbfb630cd1a0e3d44a9f2bbb34e2bb9b2cb15c009f0385d091a",
}
# Exact original/repair run and job provenance. A cancelled overall run is NOT a
# reason to discard its successful platform jobs. Reruns/new runs need review.
RUNS = {
    "desktop-original": (45752512886, SOURCE, "push", TAG, "release.yml", 139683387535),
    "helper-original": (45752621175, SOURCE, "workflow_dispatch", TAG, "helper-artifacts.yml", None),
}
ARTIFACTS = {
    "desktop": [
        ("desktop-original", 139683524263, "release (windows-2022, windows)", "release-assets-Windows-X64", [PREFIX + s for s in ("Windows.msi", "Windows.msi.sig", "Windows-Portable.zip")]),
        ("desktop-original", 139683524221, "release (ubuntu-22.04, linux-x64)", "release-assets-Linux-X64", [PREFIX + "Linux-x86_64" + s for s in (".AppImage", ".AppImage.sig", ".deb", ".rpm")]),
        ("desktop-original", 139683524268, "release (ubuntu-22.04-arm, arm64, linux-arm64)", "release-assets-Linux-arm64", [PREFIX + "Linux-arm64" + s for s in (".AppImage", ".AppImage.sig", ".deb", ".rpm")]),
    ],
    "helper": [
        ("helper-original", 139683738343, "Build Helper (ubuntu-22.04)", "cc-switch-remote-helper-Linux-x86_64", []),
        ("helper-original", 139683737970, "Build Helper (ubuntu-22.04-arm)", "cc-switch-remote-helper-Linux-arm64", []),
    ],
}
for _, _, _, artifact, names in ARTIFACTS["helper"]:
    platform = artifact.removeprefix("cc-switch-remote-helper-")
    names.extend(f"cc-switch-remote-helper-{version}-{platform}" for version in (SOURCE[:8], "latest"))
# Reviewed Windows/Linux artifacts only; user withdrew macOS distribution.
ARTIFACT_PINS = {
    "release-assets-Windows-X64": (15086239867, 50336958, "feca89665a186dc1762b16fc0f3f729836fe450c2f4e77db45bdd8e59c1e711d"),
    "release-assets-Linux-X64": (15086459915, 169170202, "abf59754dc6cff53742a7ca65189a1ef2e60e36635a1344e09f1ccb952f4bf17"),
    "release-assets-Linux-arm64": (15087046836, 163381580, "16e0e6442c9fdfccbb3a840f5e8d18a1aeaef88b2fcfb68b420bf57e0e774010"),
    "cc-switch-remote-helper-Linux-x86_64": (15086626084, 20659710, "708c46b650a3e3e04c740c38a6a1ada23a44613cfd42feb9bfad692706af7f01"),
    "cc-switch-remote-helper-Linux-arm64": (15086317101, 19938034, "7c508271b0ab76ec0891cb57484f58825d1f0c3cf35c85e2cfa4706bbfee5d39"),
}
MAX_BYTES = 2 * 1024**3


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def file_hash(path, algorithm):
    # Ubuntu 22.04 system Python is 3.10 (hashlib.file_digest starts at 3.11).
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            algorithm.update(chunk)
    return algorithm


def sha256(path):
    return file_hash(path, hashlib.sha256()).hexdigest()


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value), "Missing/invalid GitHub SHA-256 digest")
    return value[7:]


def download_accept(endpoint):
    # Actions ZIP/log endpoints are JSON API requests which redirect to storage.
    # Only a Releases asset entity uses the octet-stream API representation.
    return "application/octet-stream" if re.fullmatch(r"releases/assets/\d+", endpoint) else "application/vnd.github+json"


class GitHubHttpError(RuntimeError):
    def __init__(self, message, endpoint, method, status):
        super().__init__(message)
        self.endpoint = endpoint
        self.method = method
        self.status = status


def http_failure(endpoint, method, status, body, token):
    # Use the original API path, never error.url/Location (signed storage URLs).
    path = urlparse(endpoint).path
    safe_path = re.sub(r"[^A-Za-z0-9_./-]", "_", path)
    text = (body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)).replace("\\/", "/")
    if token:
        text = text.replace(token, "[redacted-token]")
    text = re.sub(r"https?://[^\s\"'<>]+", "[redacted-url]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)Bearer\s+[^\s\"'<>]+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+", "[redacted-token]", text)
    text = " ".join(text.split())[:1024]
    return GitHubHttpError(f"GitHub {method} {safe_path}: HTTP {status}; body={text or '[empty]'}", safe_path, method, status)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self):
        self.token = os.environ["GH_TOKEN"]
        self.opener = build_opener(NoRedirect())

    def read_timeout(self):
        deadline = getattr(self, "backup_read_deadline", None)
        if deadline is None:
            return 120
        remaining = deadline - time.monotonic()
        require(remaining > 0, "Uploaded backup read-back exceeded the 120-second deadline")
        return min(120, remaining)

    def open(self, endpoint, method="GET", data=None, accept="application/vnd.github+json"):
        require(endpoint.startswith("/repos/"), "Only explicit GitHub repository endpoints are allowed")
        request = Request("https://api.github.com" + endpoint, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token, "Accept": accept,
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cc-switch-remote-r1-recovery",
            "Content-Type": "application/json",
        })
        try:
            return self.opener.open(request, timeout=self.read_timeout())
        except HTTPError as error:
            if error.code in (301, 302, 303, 307, 308):
                raise  # download() handles redirects without forwarding auth.
            raise http_failure(endpoint, method, error.code, error.read(4096), self.token) from None

    def api(self, endpoint, method="GET", body=None):
        with self.open(endpoint, method, None if body is None else json.dumps(body).encode()) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    def repo(self, endpoint, **kwargs):
        return self.api(f"/repos/{REPO}/{endpoint}", **kwargs)

    def listing(self, endpoint, field=None):
        result = []
        for page in range(1, 100):
            payload = self.repo(endpoint + ("&" if "?" in endpoint else "?") + f"per_page=100&page={page}")
            entries = payload[field] if field else payload
            require(isinstance(entries, list), "Invalid paginated GitHub response")
            result.extend(entries)
            if len(entries) < 100:
                return result
        raise RuntimeError("Pagination limit reached")

    def download(self, endpoint, destination, expected_hash=None, expected_size=None):
        destination.parent.mkdir(parents=True, exist_ok=True)
        api_endpoint = f"/repos/{REPO}/{endpoint}"
        try:
            response = self.open(api_endpoint, accept=download_accept(endpoint))
        except HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise
            location = error.headers["Location"]
            parsed = urlparse(location)
            require(parsed.scheme == "https" and not parsed.username and parsed.hostname and (
                parsed.hostname.endswith(".blob.core.windows.net") or parsed.hostname.endswith(".githubusercontent.com")
                or parsed.hostname.endswith(".github.com")
            ), "Unexpected artifact redirect host")
            # Never forward the repository token to signed storage URLs.
            try:
                response = self.opener.open(Request(location, headers={"User-Agent": "cc-switch-remote-r1-recovery"}), timeout=self.read_timeout())
            except HTTPError as storage_error:
                raise http_failure(api_endpoint, "GET redirected download", storage_error.code, storage_error.read(4096), self.token) from None
        total = 0
        with response, destination.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                require(total <= MAX_BYTES, "Download exceeds bounded artifact size")
                output.write(chunk)
        require(total > 0 and (expected_size is None or total == expected_size), "Downloaded size mismatch")
        if expected_hash:
            require(sha256(destination) == expected_hash, "Downloaded SHA-256 mismatch")

    def log(self, job_id, destination):
        self.download(f"actions/jobs/{job_id}/logs", destination)
        return destination.read_text(encoding="utf-8")

    def upload(self, release_id, file):
        # Stream directly on the runner; never interpolate filenames into a shell.
        connection = http.client.HTTPSConnection("uploads.github.com", timeout=300)
        endpoint = f"/repos/{REPO}/releases/{release_id}/assets?" + urlencode({"name": file.name})
        try:
            connection.putrequest("POST", endpoint)
            connection.putheader("Authorization", "Bearer " + self.token)
            connection.putheader("User-Agent", "cc-switch-remote-r1-recovery")
            connection.putheader("Content-Type", "application/octet-stream")
            connection.putheader("Content-Length", str(file.stat().st_size))
            connection.endheaders()
            with file.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    connection.send(chunk)
            response = connection.getresponse()
            raw = response.read()
            if response.status != 201:
                raise http_failure(endpoint, "POST", response.status, raw[:4096], self.token)
            return json.loads(raw)
        finally:
            connection.close()


def safe_extract(archive, destination, expected_names):
    """Only the exact, flat release allowlist. No extractall, links or traversal."""
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        require(len(entries) == len(expected_names) and {i.filename for i in entries} == set(expected_names), "Artifact file list mismatch/duplicate/path traversal")
        require(sum(i.file_size for i in entries) <= MAX_BYTES, "Expanded ZIP too large")
        for info in entries:
            require(info.filename == Path(info.filename).name and not any(c in info.filename for c in "/\\:\x00"), "Unsafe ZIP filename")
            mode = info.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG) and not info.is_dir() and not info.flag_bits & 1, "ZIP links/special/encrypted entries are forbidden")
            require(info.file_size > 0, "Empty artifact entry")
        destination.mkdir(parents=True, exist_ok=True)
        for info in entries:
            with zipped.open(info) as source, (destination / info.filename).open("xb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)


def verify_minisign(file, signature, public_key):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    key_lines = base64.b64decode(public_key, validate=True).decode().splitlines()
    require(len(key_lines) == 2 and key_lines[0].startswith("untrusted comment:"), "Invalid Tauri public key armor")
    public = base64.b64decode(key_lines[1], validate=True)
    require(len(public) == 42 and public[:2] == b"Ed", "Invalid minisign public key")
    require(public[2:10][::-1].hex().upper() == "E490AF071AC1237F", "Unexpected fork signing key ID")
    lines = base64.b64decode(signature.strip(), validate=True).decode().splitlines()
    require(len(lines) == 4 and lines[0].startswith("untrusted comment:") and lines[2].startswith("trusted comment: "), "Invalid signature armor")
    packet = base64.b64decode(lines[1], validate=True)
    require(len(packet) == 74 and packet[:2] in (b"ED", b"Ed") and packet[2:10] == public[2:10], "Invalid signature packet/key ID")
    verifier = Ed25519PublicKey.from_public_bytes(public[10:])
    if packet[:2] == b"ED":
        message = file_hash(file, hashlib.blake2b(digest_size=64)).digest()
    else:
        message = file.read_bytes()
    verifier.verify(packet[10:], message)
    verifier.verify(base64.b64decode(lines[3], validate=True), packet[10:] + lines[2][17:].encode())
    return {"asset": file.name, "sha256": sha256(file), "keyId": "E490AF071AC1237F", "artifactSignature": "valid", "trustedCommentSignature": "valid"}


def validate_run(run, spec):
    run_id, head, event, branch, workflow, _ = spec
    require(run["id"] == run_id and run["repository"]["full_name"] == REPO and run["head_repository"]["full_name"] == REPO, "Foreign run repository")
    require(run["head_sha"] == head and run["event"] == event and run["head_branch"] == branch, "Unexpected run source/head/event")
    require(run["path"] == f".github/workflows/{workflow}" and run["run_attempt"] == 1 and run["status"] == "completed", "Unexpected workflow/rerun or unfinished run")
    # Deliberately do not require run.conclusion == success: original mac jobs cancelled.


def require_job(jobs, job_id, name=None):
    matches = [j for j in jobs if j["id"] == job_id]
    require(len(matches) == 1, "Expected job missing/duplicate")
    job = matches[0]
    require(job["status"] == "completed" and job["conclusion"] == "success" and (name is None or job["name"] == name), "Required platform job did not succeed")
    return job


def collect(api, operation, work):
    evidence, assets = work / "evidence", work / "assets"
    evidence.mkdir(parents=True)
    run_data = {}
    for key in sorted({a[0] for a in ARTIFACTS[operation]}):
        spec = RUNS[key]
        run = api.repo(f"actions/runs/{spec[0]}")
        validate_run(run, spec)
        jobs = api.listing(f"actions/runs/{spec[0]}/jobs?filter=all", "jobs")
        require(all(j["run_id"] == spec[0] and j["head_sha"] == spec[1] for j in jobs), "Job provenance mismatch")
        publication_jobs = [j for j in jobs if j["name"] in ("Publish GitHub Release", "Publish Helper Release")]
        require(len(publication_jobs) == 1 and publication_jobs[0]["conclusion"] == "skipped", "Source run unexpectedly published or is unfinished")
        if spec[5]:
            require_job(jobs, spec[5])
        artifacts = api.listing(f"actions/runs/{spec[0]}/artifacts", "artifacts")
        write_json(evidence / f"run-{spec[0]}.json", {"run": run, "jobs": jobs, "artifacts": artifacts})
        run_data[key] = (run, jobs, artifacts)
    for key, job_id, job_name, artifact_name, names in ARTIFACTS[operation]:
        run, jobs, artifacts = run_data[key]
        job = require_job(jobs, job_id, job_name)
        matches = [a for a in artifacts if a["name"] == artifact_name]
        require(len(matches) == 1, "Required artifact name missing/ambiguous")
        artifact = matches[0]
        require((artifact["id"], artifact["size_in_bytes"], digest(artifact.get("digest"))) == ARTIFACT_PINS[artifact_name], "Artifact differs from reviewed immutable inventory")
        require(not artifact["expired"] and artifact["workflow_run"]["id"] == run["id"] and artifact["workflow_run"]["head_sha"] == run["head_sha"], "Artifact expired or source mismatch")
        require(artifact["workflow_run"]["repository_id"] == run["repository"]["id"] and artifact["workflow_run"]["head_repository_id"] == run["head_repository"]["id"], "Artifact belongs to foreign repository")
        require(job["started_at"] <= artifact["created_at"] <= job["completed_at"], "Artifact was not created during its pinned job")
        archive = work / f"{artifact['id']}.zip"
        api.download(f"actions/artifacts/{artifact['id']}/zip", archive, digest(artifact["digest"]), artifact["size_in_bytes"])
        safe_extract(archive, assets, names)
        archive.unlink()


def manifest(directory):
    require(directory.is_dir(), "Missing asset directory")
    require(all(f.is_file() and not f.is_symlink() for f in directory.iterdir()), "Non-regular asset file")
    return {p.name: {"size": p.stat().st_size, "sha256": sha256(p)} for p in sorted(directory.iterdir())}


def checked_asset_map(assets):
    require(len({a["name"] for a in assets}) == len(assets), "Duplicate release assets")
    return {a["name"]: a for a in assets}


def matches(asset, expected):
    return asset.get("state") == "uploaded" and asset.get("size") == expected["size"] and asset.get("digest") == "sha256:" + expected["sha256"]


def tag_sha(api, tag):
    ref = api.repo("git/ref/tags/" + tag)
    obj = ref["object"]
    for _ in range(4):
        if obj["type"] == "commit":
            return obj["sha"]
        require(obj["type"] == "tag", "Unexpected tag object")
        obj = api.repo("git/tags/" + obj["sha"])["object"]
    raise RuntimeError("Excessive annotated tag chain")


def command(args, cwd, **kwargs):
    return subprocess.check_output(args, cwd=cwd, text=True, encoding="utf-8", **kwargs).strip()


def guard(api, source):
    require(os.environ.get("GITHUB_REPOSITORY") == REPO, "Workflow must run in the fork")
    require(os.environ.get("GITHUB_REF") in ("refs/heads/main", "refs/heads/release/remote-v4.0.21-r1"), "Run only reviewed main/release maintenance branch")
    require(command(["git", "rev-parse", "HEAD"], source) == SOURCE, "Source checkout is not the original release commit")
    require(not command(["git", "status", "--porcelain", "--untracked-files=no"], source), "Original source has local modifications")
    require(tag_sha(api, TAG) == SOURCE, "Desktop release tag moved")
    command(["git", "fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"], source)
    command(["git", "merge-base", "--is-ancestor", SOURCE, "refs/remotes/origin/main"], source)
    require(command(["git", "rev-parse", f"refs/tags/{TAG}^{{commit}}"], source) == SOURCE, "Local release tag mismatch")
    env = {**os.environ, "GITHUB_SHA": SOURCE}
    command(["node", "scripts/release-identity.mjs"], source, env=env)


def publication_preflight(api, source, evidence):
    require(tag_sha(api, TAG) == SOURCE, "Desktop tag moved during staging")
    releases = api.listing("releases")
    write_json(evidence / "fresh-releases.json", releases)
    tags = [r["tag_name"] for r in releases if not r["draft"]]
    inventory = evidence / "published-tags.txt"
    inventory.write_text("\n".join(tags) + "\n", encoding="utf-8")
    upstream = api.api("/repos/farion1231/cc-switch/releases/tags/v4.0.21")
    official = evidence / "upstream-release.json"
    write_json(official, upstream)
    command(["git", "fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"], source)
    command(["git", "fetch", "--no-tags", "https://github.com/farion1231/cc-switch.git", "refs/tags/v4.0.21:refs/remotes/upstream/tags/v4.0.21"], source)
    command(["node", "scripts/release-identity.mjs", "--publish", "--tag", TAG, "--published-tags-file", str(inventory), "--upstream-release-file", str(official)], source, env={**os.environ, "GITHUB_SHA": SOURCE})


def find_desktop(api):
    found = [r for r in api.listing("releases") if r["tag_name"] == TAG]
    require(len(found) <= 1, "Multiple desktop releases for this tag")
    return found[0] if found else None


def owned_desktop(release):
    require(release["tag_name"] == TAG and release["target_commitish"] == SOURCE and not release["prerelease"], "Unrelated existing release")
    require(MARKER in (release.get("body") or ""), "Existing release is not owned by this recovery; refuse overwrite")


def helper_state(api):
    release = api.repo(f"releases/{HELPER_RELEASE}")
    require(release["tag_name"] == HELPER_TAG and not release["draft"] and release["prerelease"], "Unexpected helper rolling release")
    sha = tag_sha(api, HELPER_TAG)
    require(sha in (OLD_HELPER, SOURCE), "Unexpected helper rolling tag; refuse overwrite")
    release["assets"] = api.listing(f"releases/{HELPER_RELEASE}/assets")
    return {"release": release, "tagSha": sha}


def state_fingerprint(state):
    release = state["release"]
    return {"tagSha": state["tagSha"], "body": release.get("body"), "target": release["target_commitish"],
            "assets": sorted((a["id"], a["name"], a["size"], a.get("digest"), a["state"]) for a in release["assets"])}


def final_desktop_notes(original, pub_date):
    # The tag/source snapshot is immutable. Only the release body records the
    # user's later distribution-scope decision; do not rewrite the tagged JSON.
    original = re.sub(r"^\| macOS universal[^\n]*\n", "", original, flags=re.MULTILINE)
    original = original.replace("macOS 退出后替换 `.app`；", "")
    original = original.replace("MSI/macOS 系统包壳", "MSI 系统包壳").replace("MSI/macOS/Linux 安装", "Windows/Linux 安装")
    original = original.replace("Windows/macOS 目前为锁定工具链契约审查，其实际产物、签名/公证及最终跨平台发布链仍由正式流程核对；该 Linux x64 结果不代表 arm64 或最终 tag 产物已验证。", "Windows、Linux x86_64/arm64 的原 tag 同源工件已构建成功；汇总发布重新核对三份 updater 签名及上传摘要。")
    return (original + "\n\n## 用户确认的发行范围变更\n\n"
        + "**本版不提供 macOS 桌面包或 macOS Helper，后续也停止构建和发布这些包。** 已完成的 macOS 工件弃用不上架，不删除任何历史桌面 release 的 macOS 资产。本次仅提供 Windows x64、Linux x86_64/arm64 桌面包，以及 Linux x86_64/arm64 Helper。远端 macOS SSH 管理能力与历史源码不因此删除。\n\n"
        + f"该决定在原 tag 创建后由用户明确批准；tag 仍为 {TAG}，全部保留工件的源码仍为 {SOURCE}，release-identity.json 资产保持原 tag 快照，不改版本、schema 23 或 updater 公钥。\n\n"
        + f"桌面保留[原运行 45752512886](https://github.com/{REPO}/actions/runs/45752512886)的三个成功平台，不重建任何平台。三份 updater 工件（Windows MSI、两个 Linux AppImage）的文件签名和 trusted-comment 签名均用 fork 公钥 E490AF071AC1237F 验证；latest.json 仅有 Windows/Linux 三个平台，最终桌面资产共 13 个。\n\n"
        + "没有执行真实安装、SSH 登录或旧客户端迁移；旧 4.1.0 仍需一次手动重装并备份，不能降低数据库。发行范围变更的独立维护证据见仓库 docs/release-r1-artifact-recovery.md。\n\n"
        + f"{MARKER} pub_date={pub_date} -->\n")


def prepare(api, operation, source, work):
    require(not work.exists(), "Use a fresh work directory; never mix recovery runs")
    guard(api, source)
    collect(api, operation, work)
    assets, evidence = work / "assets", work / "evidence"
    expected = {n for a in ARTIFACTS[operation] for n in a[4]}
    require(set(manifest(assets)) == expected, "Incomplete platform file set")
    plan = {"operation": operation, "source": SOURCE, "tag": TAG, "runs": RUNS, "distribution": "windows-linux-only-user-approved"}
    if operation == "desktop":
        config = json.loads((source / "src-tauri/tauri.conf.json").read_text())
        proofs = [verify_minisign(p.with_suffix(""), p.read_text().strip(), config["plugins"]["updater"]["pubkey"]) for p in assets.glob("*.sig")]
        require(len(proofs) == 3, "Need three real artifact+trusted-comment signature verifications")
        write_json(evidence / "signature-verification.json", proofs)
        release = find_desktop(api)
        if release:
            owned_desktop(release)
            stamp = re.search(re.escape(MARKER) + r" pub_date=([^ ]+) -->", release["body"])
            require(stamp is not None, "Missing deterministic draft publication timestamp")
            pub_date = stamp[1]
        else:
            pub_date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        notes = final_desktop_notes((source / f"docs/release-notes/{TAG}-remote-zh.md").read_text(encoding="utf-8"), pub_date)
        if release:
            require(release["body"] == notes, "Existing desktop release notes differ; do not rewrite")
        plan["body"] = notes
        plan["existingReleaseId"] = release["id"] if release else None
        notes_file = evidence / "release-body.md"
        notes_file.write_text(notes, encoding="utf-8")
        if not release or release["draft"]:
            publication_preflight(api, source, evidence)
        command(["node", "scripts/assemble-tauri-latest-json.mjs", "--assets-dir", str(assets), "--repo", REPO, "--tag", TAG,
                 "--notes-file", str(notes_file), "--pub-date", pub_date, "--required-platforms", REQUIRED_PLATFORMS, "--output", str(assets / "latest.json")], source)
        require(set(json.loads((assets / "latest.json").read_text())["platforms"]) == set(REQUIRED_PLATFORMS.split(",")), "Unexpected platform in current updater manifest")
        shutil.copyfile(source / "release-identity.json", assets / "release-identity.json")
        require(len(manifest(assets)) == 13, "Desktop release must have exactly 13 assets")
        if release:
            validate_existing_desktop(api, release, manifest(assets), complete=not release["draft"])
    else:
        for platform in PLATFORMS:
            require(sha256(assets / f"cc-switch-remote-helper-{SOURCE[:8]}-{platform}") == sha256(assets / f"cc-switch-remote-helper-latest-{platform}"), "Helper latest and versioned bytes differ")
        state = helper_state(api)
        candidates = manifest(assets)
        old_names = set(OLD_ASSET_IDS)
        present = checked_asset_map(state["release"]["assets"])
        if state["tagSha"] == OLD_HELPER:
            require(set(OLD_ASSET_IDS) <= set(present), "Original Linux/macOS rollback assets must remain before promotion")
        require(set(present) <= set(candidates) | old_names, "Unexpected helper assets; refuse destructive cleanup")
        for name, asset in present.items():
            platform = next(p for p in LEGACY_PLATFORMS if name.endswith(p))
            if name in OLD_ASSET_IDS:
                require(asset["id"] == OLD_ASSET_IDS[name], "Old cleanup asset ID changed; review before deletion")
            expected_hashes = {OLD_HASHES[platform]} if name in old_names or "-latest-" in name else set()
            if name in candidates:
                expected_hashes.add(candidates[name]["sha256"])
            require(asset["state"] == "uploaded" and digest(asset.get("digest")) in expected_hashes, "Existing helper asset has unknown bytes/state")
        for platform in PLATFORMS:
            alias = f"cc-switch-remote-helper-latest-{platform}"
            old = f"cc-switch-remote-helper-{OLD_HELPER[:8]}-{platform}"
            require(alias in present or old in present, "Neither alias nor old helper rollback bytes exist")
        # Preserve ALL existing metadata and bytes before mutations. Workflow must
        # upload this directory durably and confirm its API digest before apply.
        backup = work / "backup"
        write_json(backup / "state.json", state)
        for asset in present.values():
            api.download(f"releases/assets/{asset['id']}", backup / "assets" / asset["name"], digest(asset["digest"]), asset["size"])
        plan["helperBefore"] = state
        plan["backupManifest"] = manifest(backup / "assets")
    plan["assets"] = manifest(assets)
    write_json(work / "plan.json", plan)
    print(json.dumps({"prepared": operation, "source": SOURCE, "assets": len(plan["assets"]), "installationPerformed": False}))


def validate_existing_desktop(api, release, expected, complete=False):
    owned_desktop(release)
    actual = checked_asset_map(api.listing(f"releases/{release['id']}/assets"))
    require(set(actual) <= set(expected), "Existing desktop release contains unrelated assets")
    for name, asset in actual.items():
        require(matches(asset, expected[name]) or (not complete and asset["state"] == "starter"), "Existing desktop asset differs; never overwrite a completed upload")
    if complete:
        require(set(actual) == set(expected), "Completed release is missing assets; refuse recreation")


def ensure_upload(api, release_id, file, expected):
    actual = checked_asset_map(api.listing(f"releases/{release_id}/assets"))
    if file.name in actual:
        if actual[file.name]["state"] == "starter":
            # Only an incomplete upload in the already-validated owned release,
            # never a valid uploaded file. Safe resume after a failed POST.
            api.repo(f"releases/assets/{actual[file.name]['id']}", method="DELETE")
        else:
            require(matches(actual[file.name], expected), "Existing upload differs; inspect before resuming")
            return
    try:
        api.upload(release_id, file)
    except Exception:
        # A network failure after server commit may still have uploaded the asset.
        actual = checked_asset_map(api.listing(f"releases/{release_id}/assets"))
        if file.name not in actual or not matches(actual[file.name], expected):
            raise
    actual = checked_asset_map(api.listing(f"releases/{release_id}/assets"))
    require(file.name in actual and matches(actual[file.name], expected), "Uploaded asset size/SHA-256/state mismatch")


def verify_set(api, release_id, expected, exact=False):
    actual = checked_asset_map(api.listing(f"releases/{release_id}/assets"))
    require(all(name in actual and matches(actual[name], item) for name, item in expected.items()), "Release asset verification failed")
    if exact:
        require(set(actual) == set(expected), "Unexpected remaining release assets")
    return actual


def apply_desktop(api, source, work, plan):
    release = find_desktop(api)
    if release:
        require(release["id"] == plan["existingReleaseId"], "Desktop release appeared/changed after prepare")
        validate_existing_desktop(api, release, plan["assets"], complete=not release["draft"])
        require(release["body"] == plan["body"], "Release body changed")
        if not release["draft"]:
            print("Existing complete desktop release matches; no mutation")
            return
    else:
        require(plan["existingReleaseId"] is None, "Prepared draft disappeared")
    publication_preflight(api, source, work / "evidence")
    if release is None:
        release = api.repo("releases", method="POST", body={"tag_name": TAG, "target_commitish": SOURCE,
            "name": "CC Switch Remote 4.0.21 · Remote r1", "body": plan["body"], "draft": True, "prerelease": False, "make_latest": "false"})
    for name, item in plan["assets"].items():
        ensure_upload(api, release["id"], work / "assets" / name, item)
    verify_set(api, release["id"], plan["assets"], exact=True)
    # Still under the desktop workflow publication lock. Do not publish an old
    # draft after another release appeared while large files were uploading.
    publication_preflight(api, source, work / "evidence")
    current = api.repo(f"releases/{release['id']}")
    owned_desktop(current)
    require(current["draft"] and current["body"] == plan["body"], "Draft was modified during staging")
    api.repo(f"releases/{release['id']}", method="PATCH", body={"draft": False, "prerelease": False, "make_latest": "true"})
    final = api.repo(f"releases/{release['id']}")
    require(not final["draft"] and not final["prerelease"], "Release was not published stable")
    verify_set(api, release["id"], plan["assets"], exact=True)
    require(api.repo("releases/latest")["id"] == release["id"], "Published desktop release is not latest")


def replace_alias(api, name, file, item, allowed_hashes, rollback=False):
    actual = checked_asset_map(api.listing(f"releases/{HELPER_RELEASE}/assets"))
    if name in actual:
        if matches(actual[name], item):
            return
        require((rollback and actual[name]["state"] == "starter") or (actual[name]["state"] == "uploaded" and digest(actual[name].get("digest")) in allowed_hashes), "Alias changed concurrently; refuse deletion")
        api.repo(f"releases/assets/{actual[name]['id']}", method="DELETE")
    ensure_upload(api, HELPER_RELEASE, file, item)


def rollback_helper(api, work, plan):
    before = plan["helperBefore"]
    require(tag_sha(api, HELPER_TAG) in (before["tagSha"], SOURCE), "Helper tag changed externally; rollback requires manual review")
    previous = checked_asset_map(before["release"]["assets"])
    for platform in PLATFORMS:
        name = f"cc-switch-remote-helper-latest-{platform}"
        if name in previous:
            replace_alias(api, name, work / "backup/assets" / name, plan["backupManifest"][name], {plan["assets"][name]["sha256"], OLD_HASHES[platform]}, rollback=True)
        else:
            actual = checked_asset_map(api.listing(f"releases/{HELPER_RELEASE}/assets"))
            if name in actual:
                require(actual[name]["state"] == "starter" or matches(actual[name], plan["assets"][name]), "Cannot rollback an unknown alias")
                api.repo(f"releases/assets/{actual[name]['id']}", method="DELETE")
    current_tag = tag_sha(api, HELPER_TAG)
    require(current_tag in (before["tagSha"], SOURCE), "Helper tag changed externally; rollback requires manual review")
    if current_tag != before["tagSha"]:
        api.repo(f"git/refs/tags/{HELPER_TAG}", method="PATCH", body={"sha": before["tagSha"], "force": True})
    api.repo(f"releases/{HELPER_RELEASE}", method="PATCH", body={"body": before["release"]["body"], "target_commitish": before["release"]["target_commitish"], "prerelease": True, "make_latest": "false"})
    # macOS was not touched before promotion commit; prove its backup state is intact too.
    verify_set(api, HELPER_RELEASE, {n: v for n, v in plan["backupManifest"].items() if "-latest-" in n or "macOS" in n})
    require(tag_sha(api, HELPER_TAG) == before["tagSha"], "Helper rollback tag verification failed")


def apply_helper(api, work, plan):
    current = helper_state(api)
    require(state_fingerprint(current) == state_fingerprint(plan["helperBefore"]), "Helper release changed since backup; re-prepare before mutation")
    expected = plan["assets"]
    present = checked_asset_map(current["release"]["assets"])
    if current["tagSha"] == SOURCE and current["release"]["target_commitish"] == SOURCE and set(present) == set(expected) and all(matches(present[n], item) for n, item in expected.items()) and MARKER in (current["release"].get("body") or ""):
        print("Existing complete helper channel matches; no mutation")
        return
    for name, item in expected.items():
        if "-latest-" not in name:
            ensure_upload(api, HELPER_RELEASE, work / "assets" / name, item)
    try:
        for platform in PLATFORMS:
            name = f"cc-switch-remote-helper-latest-{platform}"
            replace_alias(api, name, work / "assets" / name, expected[name], {OLD_HASHES[platform], expected[name]["sha256"]})
        verify_set(api, HELPER_RELEASE, expected)
        current_tag = tag_sha(api, HELPER_TAG)
        require(current_tag in (OLD_HELPER, SOURCE), "Helper tag changed during promotion")
        if current_tag != SOURCE:
            api.repo(f"git/refs/tags/{HELPER_TAG}", method="PATCH", body={"sha": SOURCE, "force": True})
        api.repo(f"releases/{HELPER_RELEASE}", method="PATCH", body={"target_commitish": SOURCE, "prerelease": True, "make_latest": "false",
            "body": f"Linux-only pure CLI helper binaries from {SOURCE}, preserved from run 45752621175. Both Linux x86_64/arm64 SHA/latest pairs verified equal. User explicitly discontinued current and future macOS desktop/helper packages; old macOS rolling assets removed only after backup and Linux verification. No real-host installation validation.\n{MARKER} helper -->"})
        require(tag_sha(api, HELPER_TAG) == SOURCE, "Helper tag promotion failed")
        verify_set(api, HELPER_RELEASE, expected)
    except Exception as promotion_error:
        try:
            rollback_helper(api, work, plan)
        except Exception as rollback_error:
            raise RuntimeError(f"Helper promotion failed and rollback incomplete; use uploaded backup. Promotion: {promotion_error}; rollback: {rollback_error}") from rollback_error
        raise RuntimeError(f"Helper promotion failed; prior aliases/tag restored; versioned candidates retained: {promotion_error}") from promotion_error
    # Commit completed. Only now remove known old versioned bytes. If cleanup
    # fails, leave the valid new channel plus old assets; rerun safely finishes.
    actual = checked_asset_map(api.listing(f"releases/{HELPER_RELEASE}/assets"))
    for name, asset_id in OLD_ASSET_IDS.items():
        if name in actual:
            platform = next(p for p in LEGACY_PLATFORMS if name.endswith(p))
            require(actual[name]["id"] == asset_id and digest(actual[name]["digest"]) == OLD_HASHES[platform], "Old cleanup asset ID/digest changed; refuse deletion")
            api.repo(f"releases/assets/{asset_id}", method="DELETE")
    verify_set(api, HELPER_RELEASE, expected, exact=True)


def verify_backup_archive(durable, work):
    files = [work / "plan.json", *[p for directory in (work / "evidence", work / "backup") if directory.exists() for p in directory.rglob("*") if p.is_file()]]
    expected = {p.relative_to(work).as_posix(): p for p in files}
    directories = {str(parent).replace("\\", "/") + "/" for name in expected for parent in Path(name).parents if str(parent) != "."}
    with zipfile.ZipFile(durable) as archive:
        entries = archive.infolist()
        require(len({i.filename for i in entries}) == len(entries), "Duplicate durable backup entry")
        actual_files = {i.filename for i in entries if not i.is_dir()}
        require(actual_files == set(expected), "Durable backup archive has incomplete file set")
        for info in entries:
            require(not info.flag_bits & 1, "Encrypted backup entry")
            if info.is_dir():
                require(info.filename in directories, "Unexpected backup directory")
                continue
            require(stat.S_IFMT(info.external_attr >> 16) in (0, stat.S_IFREG), "Special backup entry")
            path = expected[info.filename]
            require(info.file_size == path.stat().st_size, "Durable backup size mismatch")
            with archive.open(info) as stream:
                hashed = hashlib.sha256()
                size = 0
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    require(size <= MAX_BYTES, "Durable backup entry too large")
                    hashed.update(chunk)
            require(size == path.stat().st_size and hashed.hexdigest() == sha256(path), "Durable backup content differs from rollback plan")


def download_uploaded_backup(api, operation, work):
    backup_id = os.environ["RECOVERY_BACKUP_ARTIFACT_ID"]
    require(backup_id.isdigit(), "Backup artifact ID missing")
    run_id = os.environ["GITHUB_RUN_ID"]
    require(run_id.isdigit(), "Recovery workflow run ID missing")

    def validate(backup):
        require(str(backup["id"]) == backup_id, "Recovery backup artifact ID mismatch")
        require(backup["name"] == f"remote-r1-{operation}-recovery-{run_id}" and not backup["expired"], "Recovery backup artifact missing/expired")
        require(str(backup["workflow_run"]["id"]) == run_id and backup["workflow_run"]["head_sha"] == os.environ["GITHUB_SHA"], "Recovery backup belongs to another run")
        require(digest(backup["digest"]) == os.environ["RECOVERY_BACKUP_ARTIFACT_DIGEST"], "Recovery backup upload digest mismatch")
        require(0 < backup["size_in_bytes"] <= MAX_BYTES, "Recovery backup size invalid")

    # Before tolerating any 404, require independent positive API evidence that
    # this exact upload exists in THIS run, is unexpired and matches its digest.
    # Missing listing entries, other IDs/runs, permission errors and all writes
    # fail immediately. Never retry arbitrary GitHub 404s.
    deadline = time.monotonic() + 120
    api.backup_read_deadline = deadline
    try:
        listed = api.listing(f"actions/runs/{run_id}/artifacts", "artifacts")
        confirmed = [item for item in listed if str(item["id"]) == backup_id]
        require(len(confirmed) == 1, "Uploaded backup is not confirmed by the current run inventory; refusing 404 retries")
        validate(confirmed[0])
        endpoint = f"actions/artifacts/{backup_id}"
        allowed_paths = {f"/repos/{REPO}/{endpoint}", f"/repos/{REPO}/{endpoint}/zip"}
        durable = work / "durable-backup.zip"
        delay = 2
        while True:
            try:
                backup = api.repo(endpoint)
                validate(backup)
                api.download(endpoint + "/zip", durable, digest(backup["digest"]), backup["size_in_bytes"])
                return durable
            except GitHubHttpError as error:
                if error.status != 404 or error.endpoint not in allowed_paths or error.method not in ("GET", "GET redirected download"):
                    raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"Uploaded backup still unavailable after 120 seconds: {error}") from None
                wait = min(delay, remaining)
                print(f"Confirmed uploaded backup not yet readable; retry in {wait:g}s: {error}", file=sys.stderr)
                time.sleep(wait)
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Uploaded backup still unavailable after 120 seconds: {error}") from None
                delay = min(delay * 2, 30)
    finally:
        del api.backup_read_deadline


def apply(api, operation, source, work):
    guard(api, source)
    plan = json.loads((work / "plan.json").read_text(encoding="utf-8"))
    require(plan["operation"] == operation and plan["source"] == SOURCE and plan["tag"] == TAG, "Prepared plan identity mismatch")
    require(manifest(work / "assets") == plan["assets"], "Prepared assets changed")
    expected_names = {n for a in ARTIFACTS[operation] for n in a[4]}
    if operation == "desktop":
        expected_names |= {"latest.json", "release-identity.json"}
    require(set(plan["assets"]) == expected_names, "Prepared asset allowlist changed")
    if operation == "helper":
        require(manifest(work / "backup/assets") == plan["backupManifest"], "Rollback backup changed")
    # Read back the positively confirmed current-run upload with a bounded,
    # 404-only visibility retry before trusting the rollback bytes.
    durable = download_uploaded_backup(api, operation, work)
    verify_backup_archive(durable, work)
    durable.unlink()
    if operation == "desktop":
        # Verify again after durable evidence upload, immediately before mutation.
        config = json.loads((source / "src-tauri/tauri.conf.json").read_text())
        for sig in (work / "assets").glob("*.sig"):
            verify_minisign(sig.with_suffix(""), sig.read_text().strip(), config["plugins"]["updater"]["pubkey"])
        apply_desktop(api, source, work, plan)
    else:
        apply_helper(api, work, plan)
    write_json(work / "result.json", {"operation": operation, "source": SOURCE, "verifiedAssets": plan["assets"], "installationPerformed": False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "apply"))
    parser.add_argument("operation", choices=("desktop", "helper"))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    require(os.environ.get("INPUT_TAG") == TAG and os.environ.get("INPUT_SOURCE_SHA") == SOURCE, "Only approved Remote r1 tag/source is supported")
    for key, spec in RUNS.items():
        require(os.environ.get("INPUT_" + key.upper().replace("-", "_")) == str(spec[0]), "Unapproved artifact run input")
    source, work = args.source.resolve(), args.work.resolve()
    require(work != source and source not in work.parents, "Recovery output must be outside immutable source checkout")
    (prepare if args.phase == "prepare" else apply)(GitHub(), args.operation, source, work)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Recovery stopped: {error}", file=sys.stderr)
        sys.exit(1)
