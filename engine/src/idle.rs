//! Inference activity only: status/metrics polling must never keep weights loaded.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;

struct IdleState {
    active: usize,
    idle_since: Instant,
    closing: bool,
}

impl IdleState {
    fn begin(&mut self) -> bool {
        if self.closing {
            return false;
        }
        self.active += 1;
        true
    }

    fn finish(&mut self, now: Instant) {
        self.active -= 1;
        if self.active == 0 {
            self.idle_since = now;
        }
    }

    fn close_if_idle(&mut self, now: Instant, timeout: Duration) -> bool {
        if !timeout.is_zero() && self.active == 0 && now.duration_since(self.idle_since) >= timeout
        {
            self.closing = true;
        }
        self.closing
    }
}

pub struct IdleActivity(Mutex<IdleState>);

impl IdleActivity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(IdleState {
            active: 0,
            idle_since: Instant::now(),
            closing: false,
        })))
    }

    pub fn begin(self: &Arc<Self>) -> Option<ActivityGuard> {
        self.0
            .lock()
            .unwrap()
            .begin()
            .then(|| ActivityGuard(self.clone()))
    }

    pub fn close_if_idle(&self, timeout: Duration) -> bool {
        self.0
            .lock()
            .unwrap()
            .close_if_idle(Instant::now(), timeout)
    }
}

/// Follows queued and blocking work as well as the HTTP response body.
/// Dropping a client connection must not mark a still-running GPU job idle.
pub struct ActivityGuard(Arc<IdleActivity>);

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().finish(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(now: Instant) -> IdleState {
        IdleState {
            active: 0,
            idle_since: now,
            closing: false,
        }
    }

    #[test]
    fn unused_engine_exits_at_deadline_and_refuses_new_work() {
        let now = Instant::now();
        let mut s = state(now);
        let timeout = Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS);
        assert!(!s.close_if_idle(now + timeout - Duration::from_nanos(1), timeout));
        assert!(s.close_if_idle(now + timeout, timeout));
        assert!(!s.begin());
    }

    #[test]
    fn queued_generation_and_response_each_hold_engine_until_last_finishes() {
        let now = Instant::now();
        let mut s = state(now);
        let timeout = Duration::from_secs(300);
        assert!(s.begin());
        assert!(s.begin());
        assert!(!s.close_if_idle(now + timeout * 2, timeout));
        s.finish(now + timeout * 2);
        assert!(!s.close_if_idle(now + timeout * 3, timeout));
        s.finish(now + timeout * 3);
        assert!(!s.close_if_idle(now + timeout * 4 - Duration::from_nanos(1), timeout));
        assert!(s.close_if_idle(now + timeout * 4, timeout));
    }

    #[test]
    fn explicit_keep_loaded_disables_deadline() {
        let now = Instant::now();
        let mut s = state(now);
        assert!(!s.close_if_idle(now + Duration::from_secs(86400), Duration::ZERO));
        assert!(s.begin());
    }

    #[test]
    fn cancellation_and_errors_release_guards() {
        let activity = IdleActivity::new();
        let generation = activity.begin().unwrap();
        let response = activity.begin().unwrap();
        assert_eq!(activity.0.lock().unwrap().active, 2);
        drop(response);
        assert_eq!(activity.0.lock().unwrap().active, 1);
        drop(generation);
        assert_eq!(activity.0.lock().unwrap().active, 0);
    }
}
