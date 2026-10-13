//! Runtime bridge for shared services. Desktop keeps Tauri's runtime; the helper
//! can also schedule work from synchronous JSON command handlers without an
//! entered Tokio runtime. Neither path creates a throwaway runtime per request.

#[cfg(feature = "desktop")]
pub(crate) use tauri::async_runtime::{block_on, spawn, spawn_blocking};

#[cfg(not(feature = "desktop"))]
mod headless {
    use once_cell::sync::Lazy;
    use std::future::Future;
    use tokio::runtime::{Handle, Runtime};
    use tokio::task::JoinHandle;

    static RUNTIME: Lazy<Runtime> =
        Lazy::new(|| Runtime::new().expect("failed to create shared helper runtime"));

    // As with Tauri's block_on, callers already in async code must move blocking
    // work to a blocking thread first (e.g. codex_direct::off_runtime).
    pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
        RUNTIME.block_on(future)
    }

    fn handle() -> Handle {
        Handle::try_current().unwrap_or_else(|_| RUNTIME.handle().clone())
    }

    pub(crate) fn spawn<F>(future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        handle().spawn(future)
    }

    pub(crate) fn spawn_blocking<F, T>(work: F) -> JoinHandle<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        handle().spawn_blocking(work)
    }
}

#[cfg(not(feature = "desktop"))]
pub(crate) use headless::{block_on, spawn, spawn_blocking};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_can_be_called_without_an_entered_runtime() {
        let task = spawn(async { 42 });
        assert_eq!(block_on(task).unwrap(), 42);
    }

    #[test]
    fn blocking_work_runs_from_async_and_sync_contexts() {
        assert_eq!(block_on(spawn_blocking(|| 7)).unwrap(), 7);
        assert_eq!(block_on(async { spawn_blocking(|| 9).await.unwrap() }), 9);
    }
}
