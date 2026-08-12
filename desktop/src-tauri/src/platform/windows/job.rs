//! Job-Object supervision for a shell-spawned daemon (spec §1): the whole child tree dies with
//! `TerminateJobObject`, and `KILL_ON_JOB_CLOSE` guarantees cleanup even if the shell crashes.

use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use crate::daemon::supervisor::DaemonProcessControl;

pub struct JobObjectDaemonControl {
    program: String,
    arguments: Vec<String>,
    working_directory: Option<String>,
    job: Option<HANDLE>,
    child: Option<Child>,
}

// A job handle is process-global and valid from any thread; nothing here is thread-affine.
unsafe impl Send for JobObjectDaemonControl {}

impl JobObjectDaemonControl {
    pub fn new(
        program: impl Into<String>,
        arguments: Vec<String>,
        working_directory: Option<String>,
    ) -> Self {
        Self {
            program: program.into(),
            arguments,
            working_directory,
            job: None,
            child: None,
        }
    }
}

impl DaemonProcessControl for JobObjectDaemonControl {
    fn spawn(&mut self) -> Result<(), String> {
        let job = unsafe { CreateJobObjectW(None, None) }
            .map_err(|error| format!("CreateJobObjectW failed: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .expect("limit struct fits u32"),
            )
        }
        .map_err(|error| format!("SetInformationJobObject failed: {error}"))?;

        let mut command = Command::new(&self.program);
        command.args(&self.arguments);
        if let Some(directory) = self.working_directory.as_deref() {
            command.current_dir(directory);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("spawning the daemon failed: {error}"))?;
        unsafe { AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) }
            .map_err(|error| format!("AssignProcessToJobObject failed: {error}"))?;
        self.job = Some(job);
        self.child = Some(child);
        Ok(())
    }

    fn terminate_tree(&mut self) {
        if let Some(job) = self.job.take() {
            unsafe {
                let _ = TerminateJobObject(job, 1);
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
    }

    fn is_running(&self) -> bool {
        self.child.is_some()
    }
}
