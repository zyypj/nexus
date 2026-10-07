//! Tiny in-memory token-bucket limiter. A few dozen users do not justify Redis.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::error::ApiError;

#[derive(Clone, Copy, Debug)]
pub struct Rule {
    /// Bucket size (burst).
    pub capacity: f64,
    /// Tokens added per second.
    pub refill_per_sec: f64,
}

impl Rule {
    pub const fn per_minute(capacity: u32, per_minute: u32) -> Self {
        Self {
            capacity: capacity as f64,
            refill_per_sec: per_minute as f64 / 60.0,
        }
    }

    pub const fn per_second(capacity: u32, per_second: u32) -> Self {
        Self {
            capacity: capacity as f64,
            refill_per_sec: per_second as f64,
        }
    }
}

pub mod rules {
    use super::Rule;
    /// Login / register / refresh per IP.
    pub const AUTH: Rule = Rule::per_minute(10, 10);
    pub const MESSAGE: Rule = Rule::per_second(10, 5);
    pub const UPLOAD: Rule = Rule::per_minute(20, 20);
    pub const CALL: Rule = Rule::per_minute(20, 20);
    pub const GENERAL: Rule = Rule::per_second(60, 30);
    pub const FRIEND: Rule = Rule::per_minute(20, 10);
}

struct Bucket {
    tokens: f64,
    updated: Instant,
}

pub struct RateLimiter {
    enabled: bool,
    buckets: Mutex<HashMap<String, Bucket>>,
}

const MAX_KEYS: usize = 10_000;

impl RateLimiter {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, scope: &str, key: &str, rule: Rule) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if buckets.len() > MAX_KEYS {
            // Drop buckets that are full again; they carry no information.
            buckets.retain(|_, b| now.duration_since(b.updated) < Duration::from_secs(600));
        }
        let bucket = buckets.entry(format!("{scope}:{key}")).or_insert(Bucket {
            tokens: rule.capacity,
            updated: now,
        });
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rule.refill_per_sec).min(rule.capacity);
        bucket.updated = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - bucket.tokens) / rule.refill_per_sec).ceil() as u64;
            Err(ApiError::RateLimited {
                retry_after_secs: wait.max(1),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_then_block() {
        let rl = RateLimiter::new(true);
        let rule = Rule::per_minute(3, 1);
        for _ in 0..3 {
            rl.check("t", "k", rule).unwrap();
        }
        assert!(rl.check("t", "k", rule).is_err());
        // Other keys are independent.
        rl.check("t", "other", rule).unwrap();
    }

    #[test]
    fn disabled_never_blocks() {
        let rl = RateLimiter::new(false);
        for _ in 0..100 {
            rl.check("t", "k", Rule::per_minute(1, 1)).unwrap();
        }
    }
}
