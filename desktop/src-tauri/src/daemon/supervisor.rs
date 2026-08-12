//! Daemon ownership (spec §1): probe the configured port; adopt a compatible server, otherwise
//! spawn the daemon as a supervised child inside a Job Object. Quit terminates only the tree
//! this shell launched — an adopted external server is never touched.

/// What a probe of `GET /assistant/status` concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeResult {
    Compatible,
    Incompatible,
    Absent,
}

/// Process control for the spawned daemon tree. The Windows impl wraps a Job Object so
/// termination takes the whole tree (`platform::windows::job`).
pub trait DaemonProcessControl {
    fn spawn(&mut self) -> Result<(), String>;
    fn terminate_tree(&mut self);
    fn is_running(&self) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonOwnership {
    /// A compatible external server: never terminated by this shell.
    Adopted,
    /// A child this shell spawned and supervises.
    Spawned,
    /// An incompatible server holds the port: attention state, no capture.
    Blocked,
}

#[derive(Debug)]
pub struct Supervisor {
    ownership: Option<DaemonOwnership>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self { ownership: None }
    }

    pub fn ownership(&self) -> Option<DaemonOwnership> {
        self.ownership
    }

    pub fn connect(
        &mut self,
        probe: ProbeResult,
        control: &mut dyn DaemonProcessControl,
    ) -> Result<DaemonOwnership, String> {
        let ownership = match probe {
            ProbeResult::Compatible => DaemonOwnership::Adopted,
            ProbeResult::Incompatible => DaemonOwnership::Blocked,
            ProbeResult::Absent => {
                control.spawn()?;
                DaemonOwnership::Spawned
            }
        };
        self.ownership = Some(ownership);
        Ok(ownership)
    }

    /// `Quit SiftKit Assistant`: only a shell-spawned tree dies with the shell.
    pub fn quit(&mut self, control: &mut dyn DaemonProcessControl) {
        if self.ownership == Some(DaemonOwnership::Spawned) {
            control.terminate_tree();
        }
        self.ownership = None;
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeControl {
        spawned: u32,
        terminated: u32,
        running: bool,
    }

    impl DaemonProcessControl for FakeControl {
        fn spawn(&mut self) -> Result<(), String> {
            self.spawned += 1;
            self.running = true;
            Ok(())
        }

        fn terminate_tree(&mut self) {
            self.terminated += 1;
            self.running = false;
        }

        fn is_running(&self) -> bool {
            self.running
        }
    }

    #[test]
    fn a_compatible_server_is_adopted_and_never_terminated() {
        let mut supervisor = Supervisor::new();
        let mut control = FakeControl::default();
        let ownership = supervisor.connect(ProbeResult::Compatible, &mut control).expect("adopts");
        assert_eq!(ownership, DaemonOwnership::Adopted);
        assert_eq!(control.spawned, 0);
        supervisor.quit(&mut control);
        assert_eq!(control.terminated, 0, "adopted servers outlive the shell");
    }

    #[test]
    fn an_absent_daemon_is_spawned_and_quit_kills_only_that_tree() {
        let mut supervisor = Supervisor::new();
        let mut control = FakeControl::default();
        let ownership = supervisor.connect(ProbeResult::Absent, &mut control).expect("spawns");
        assert_eq!(ownership, DaemonOwnership::Spawned);
        assert_eq!(control.spawned, 1);
        supervisor.quit(&mut control);
        assert_eq!(control.terminated, 1);
        assert!(!control.is_running());
    }

    #[test]
    fn an_incompatible_server_blocks_without_spawning_or_killing() {
        let mut supervisor = Supervisor::new();
        let mut control = FakeControl::default();
        let ownership = supervisor
            .connect(ProbeResult::Incompatible, &mut control)
            .expect("reports blocked");
        assert_eq!(ownership, DaemonOwnership::Blocked);
        assert_eq!(control.spawned, 0);
        supervisor.quit(&mut control);
        assert_eq!(control.terminated, 0);
    }
}
