//! Bounded one-shot execution. The deadline covers stdin, both output pipes and exit.
//! It only proves that the LOCAL child was reaped, not that remote work stopped.
use serde::Serialize;
use std::process::{Output, Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOperationError {
    pub code: String,
    pub message: String,
    pub local_process_reaped: bool,
    pub remote_state_uncertain: bool,
}

impl RemoteOperationError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
            local_process_reaped: false,
            remote_state_uncertain: false,
        }
    }
}

impl std::fmt::Display for RemoteOperationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::time::Duration;

    // A child of this test executable, never a real SSH host or user directory.
    #[test]
    fn child_fixture() {
        match std::env::var("CC_SWITCH_EXECUTION_FIXTURE").as_deref() {
            Ok("hang") => std::thread::sleep(Duration::from_secs(60)),
            Ok("pipes") => {
                std::io::stdout()
                    .write_all(&vec![b'o'; 256 * 1024])
                    .unwrap();
                std::io::stderr()
                    .write_all(&vec![b'e'; 256 * 1024])
                    .unwrap();
                let mut input = Vec::new();
                std::io::stdin().read_to_end(&mut input).unwrap();
                assert_eq!(
                    input,
                    (0..=255).cycle().take(1024 * 1024).collect::<Vec<u8>>()
                );
                println!("binary-input-complete");
            }
            _ => {}
        }
    }

    fn fixture(mode: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "remote::execution::tests::child_fixture",
            "--nocapture",
        ]);
        command.env("CC_SWITCH_EXECUTION_FIXTURE", mode);
        command
    }

    #[tokio::test]
    async fn deadline_kills_and_reaps_child_instead_of_abandoning_wait() {
        let started = Instant::now();
        let error = execute(fixture("hang"), &[], started + Duration::from_millis(250))
            .await
            .unwrap_err();
        assert_eq!(error.code, "ssh-deadline");
        assert!(error.local_process_reaped);
        assert!(error.remote_state_uncertain);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn binary_stdin_and_both_output_pipes_are_drained_concurrently() {
        let input: Vec<u8> = (0..=255).cycle().take(1024 * 1024).collect();
        let output = execute(
            fixture("pipes"),
            &input,
            Instant::now() + Duration::from_secs(20),
        )
        .await
        .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.len() >= 256 * 1024);
        assert!(output.stderr.len() >= 256 * 1024);
        assert!(String::from_utf8_lossy(&output.stdout).contains("binary-input-complete"));
    }
}

pub(crate) async fn execute(
    mut command: tokio::process::Command,
    input: &[u8],
    deadline: Instant,
) -> Result<Output, RemoteOperationError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| RemoteOperationError::new("ssh-spawn", e))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut out = Vec::new();
    let mut err = Vec::new();
    let result = tokio::time::timeout_at(deadline, async {
        // Never write an entire binary before draining the remote output.
        let (status, stdout_result, stderr_result, write_result) = tokio::join!(
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            async {
                let result = stdin.write_all(input).await;
                drop(stdin);
                result
            }
        );
        let status = status?;
        stdout_result?;
        stderr_result?;
        // Preserve the remote failure diagnostic when it closed stdin early.
        if status.success() {
            write_result?;
        }
        Ok::<_, std::io::Error>(status)
    })
    .await;
    match result {
        Ok(Ok(status)) => Ok(Output {
            status,
            stdout: out,
            stderr: err,
        }),
        failure => {
            let _ = child.start_kill();
            let reaped = child.wait().await.is_ok();
            let mut error = match failure {
                Err(_) => RemoteOperationError::new(
                    "ssh-deadline",
                    "Local SSH execution deadline exceeded; remote completion is unknown",
                ),
                Ok(Err(e)) => RemoteOperationError::new("ssh-io", e),
                Ok(Ok(_)) => unreachable!(),
            };
            error.local_process_reaped = reaped;
            error.remote_state_uncertain = true;
            Err(error)
        }
    }
}
