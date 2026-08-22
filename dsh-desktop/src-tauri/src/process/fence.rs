use std::path::Path;
use std::process::Child;

#[cfg(target_os = "linux")]
mod linux {
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::Child;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use serde::{Deserialize, Serialize};

    const TERM_GRACE: Duration = Duration::from_secs(3);
    const POLL: Duration = Duration::from_millis(50);

    #[derive(Clone, Debug, Deserialize, Serialize)]
    struct Lease {
        pid: i32,
        pgid: i32,
        proc_start_time: String,
        executable_path: String,
        host_entry: String,
        created_at: u64,
    }

    #[derive(Clone, Debug)]
    struct Identity {
        pid: i32,
        pgid: i32,
        proc_start_time: String,
        executable_path: String,
        argv: Vec<String>,
    }

    pub struct Fence {
        pgid: i32,
        lease_path: PathBuf,
    }

    impl Fence {
        pub fn prepare(host_entry: &Path, executable: &Path) -> Result<PathBuf, String> {
            let lease_path = lease_path();
            reclaim_stale(&lease_path, host_entry, executable)?;
            Ok(lease_path)
        }

        pub fn attach(
            child: &Child,
            host_entry: &Path,
            executable: &Path,
            lease_path: PathBuf,
        ) -> Result<Self, String> {
            let pid = child.id() as i32;
            let expected_entry = canonical(host_entry);
            let expected_executable = canonical(executable);
            let deadline = Instant::now() + Duration::from_secs(1);
            let identity = loop {
                let identity = read_identity(pid).ok_or_else(|| {
                    format!("cannot read desktop-host /proc identity (pid={pid})")
                })?;
                if identity.pid != pid || identity.pgid != pid {
                    return Err(format!(
                        "desktop-host did not create an independent process group (pid={pid}, pgid={})",
                        identity.pgid
                    ));
                }
                let entry_matches = identity
                    .argv
                    .iter()
                    .skip(1)
                    .any(|arg| canonical(Path::new(arg)) == expected_entry);
                let executable_matches =
                    canonical(Path::new(&identity.executable_path)) == expected_executable;
                if entry_matches && executable_matches {
                    break identity;
                }
                if Instant::now() >= deadline {
                    if !entry_matches {
                        return Err(
                            "desktop-host command line does not contain the expected entry"
                                .to_owned(),
                        );
                    }
                    return Err(
                        "desktop-host is not using the configured bundled Node runtime".to_owned(),
                    );
                }
                thread::sleep(Duration::from_millis(10));
            };
            let lease = Lease {
                pid,
                pgid: identity.pgid,
                proc_start_time: identity.proc_start_time,
                executable_path: expected_executable,
                host_entry: expected_entry,
                created_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            };
            write_lease(&lease_path, &lease)?;
            Ok(Self {
                pgid: identity.pgid,
                lease_path,
            })
        }
    }

    impl Drop for Fence {
        fn drop(&mut self) {
            let _ = terminate_group(self.pgid);
            let _ = fs::remove_file(&self.lease_path);
        }
    }

    fn lease_path() -> PathBuf {
        if let Some(path) = std::env::var_os("DSH_DESKTOP_LEASE") {
            return PathBuf::from(path);
        }
        let base = std::env::var_os("DSH_DESKTOP_USERDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("dsh-desktop"));
        base.join("desktop-host.lease.json")
    }

    fn canonical(path: &Path) -> String {
        fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned()
    }

    fn read_identity(pid: i32) -> Option<Identity> {
        if pid <= 0 {
            return None;
        }
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let close = stat.rfind(')')?;
        let fields: Vec<&str> = stat[close + 2..].split_whitespace().collect();
        let pgid = fields.get(2)?.parse().ok()?;
        let proc_start_time = fields.get(19)?.to_string();
        let mut cmdline = Vec::new();
        let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        for arg in raw.split(|byte| *byte == 0).filter(|arg| !arg.is_empty()) {
            cmdline.push(String::from_utf8_lossy(arg).into_owned());
        }
        let executable_path = fs::read_link(format!("/proc/{pid}/exe"))
            .ok()?
            .to_string_lossy()
            .into_owned();
        Some(Identity {
            pid,
            pgid,
            proc_start_time,
            executable_path,
            argv: cmdline,
        })
    }

    fn parse_lease(path: &Path) -> Result<Lease, String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut raw = String::new();
        file.read_to_string(&mut raw)
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| format!("invalid host lease: {error}"))
    }

    fn write_lease(path: &Path, lease: &Lease) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        let temp = path.with_extension(format!("tmp-{}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|error| format!("cannot create host lease: {error}"))?;
        let body = serde_json::to_vec(lease).map_err(|error| error.to_string())?;
        file.write_all(&body).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|error| {
            let _ = fs::remove_file(&temp);
            error.to_string()
        })?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn reclaim_stale(path: &Path, host_entry: &Path, executable: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let lease = parse_lease(path)?;
        let Some(identity) = read_identity(lease.pid) else {
            if process_group_exists(lease.pgid) {
                return Err(format!(
                        "refusing to reclaim a host lease whose leader exited while process group {} remains",
                        lease.pgid
                    ));
            }
            fs::remove_file(path).map_err(|error| error.to_string())?;
            return Ok(());
        };
        let expected_entry = canonical(host_entry);
        let expected_executable = canonical(executable);
        let identity_matches = lease.pid == lease.pgid
            && identity.pid == lease.pid
            && identity.pgid == lease.pgid
            && identity.proc_start_time == lease.proc_start_time
            && canonical(Path::new(&lease.host_entry)) == expected_entry
            && identity
                .argv
                .iter()
                .skip(1)
                .any(|arg| canonical(Path::new(arg)) == expected_entry)
            && canonical(Path::new(&lease.executable_path)) == expected_executable
            && canonical(Path::new(&identity.executable_path)) == expected_executable;
        if !identity_matches {
            return Err(format!(
                "refusing to reclaim an identity-mismatched host lease: {}",
                path.display()
            ));
        }
        terminate_group(lease.pgid)?;
        fs::remove_file(path).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn process_group_exists(pgid: i32) -> bool {
        if pgid <= 0 {
            return false;
        }
        unsafe { libc::kill(-pgid, 0) == 0 || *libc::__errno_location() != libc::ESRCH }
    }

    fn terminate_group(pgid: i32) -> Result<(), String> {
        if pgid <= 0 {
            return Ok(());
        }
        if !process_group_exists(pgid) {
            return Ok(());
        }
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + TERM_GRACE;
        while process_group_exists(pgid) && std::time::Instant::now() < deadline {
            thread::sleep(POLL);
        }
        if process_group_exists(pgid) {
            unsafe {
                let _ = libc::kill(-pgid, libc::SIGKILL);
            }
            let hard_deadline = std::time::Instant::now() + TERM_GRACE;
            while process_group_exists(pgid) && std::time::Instant::now() < hard_deadline {
                thread::sleep(POLL);
            }
        }
        if process_group_exists(pgid) {
            return Err(format!(
                "process group {pgid} remained alive after bounded cleanup"
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::process::Child;

    type Handle = *mut c_void;
    type Bool = i32;

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32)
            -> Bool;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
    }

    pub struct Fence {
        handle: Handle,
    }

    unsafe impl Send for Fence {}

    impl Fence {
        pub fn prepare(_host_entry: &Path, _executable: &Path) -> Result<(), String> {
            Ok(())
        }

        pub fn attach(
            child: &Child,
            _host_entry: &Path,
            _executable: &Path,
        ) -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if handle.is_null() {
                return Err("CreateJobObjectW failed".to_owned());
            }
            let mut limits: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &mut limits as *mut _ as *mut c_void,
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                )
            };
            if configured == 0 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err("SetInformationJobObject failed".to_owned());
            }
            let assigned =
                unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as Handle) };
            if assigned == 0 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err("AssignProcessToJobObject failed".to_owned());
            }
            Ok(Self { handle })
        }
    }

    impl Drop for Fence {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod other {
    use std::path::Path;
    use std::process::Child;

    pub struct Fence;

    impl Fence {
        pub fn prepare(_host_entry: &Path, _executable: &Path) -> Result<(), String> {
            Ok(())
        }

        pub fn attach(
            _child: &Child,
            _host_entry: &Path,
            _executable: &Path,
        ) -> Result<Self, String> {
            Ok(Self)
        }
    }
}

pub struct ProcessFencePlan {
    #[cfg(target_os = "linux")]
    lease_path: std::path::PathBuf,
}

impl ProcessFencePlan {
    #[cfg(target_os = "linux")]
    pub fn lease_path(&self) -> Option<&std::path::Path> {
        Some(&self.lease_path)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn lease_path(&self) -> Option<&std::path::Path> {
        None
    }
}

pub struct ProcessFence {
    #[cfg(target_os = "linux")]
    inner: linux::Fence,
    #[cfg(target_os = "windows")]
    inner: windows::Fence,
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    inner: other::Fence,
}

impl Drop for ProcessFence {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        let _ = &self.inner;
        #[cfg(target_os = "windows")]
        let _ = &self.inner;
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let _ = &self.inner;
    }
}

impl ProcessFence {
    pub fn prepare(host_entry: &Path, executable: &Path) -> Result<ProcessFencePlan, String> {
        #[cfg(target_os = "linux")]
        {
            let lease_path = linux::Fence::prepare(host_entry, executable)?;
            Ok(ProcessFencePlan { lease_path })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (host_entry, executable);
            Ok(ProcessFencePlan {})
        }
    }

    pub fn attach(
        child: &Child,
        host_entry: &Path,
        executable: &Path,
        plan: ProcessFencePlan,
    ) -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                inner: linux::Fence::attach(child, host_entry, executable, plan.lease_path)?,
            })
        }
        #[cfg(target_os = "windows")]
        {
            let _ = plan;
            return Ok(Self {
                inner: windows::Fence::attach(child, host_entry, executable)?,
            });
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = plan;
            Ok(Self {
                inner: other::Fence::attach(child, host_entry, executable)?,
            })
        }
    }
}

#[cfg(target_os = "linux")]
#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    use super::ProcessFence;

    // These integration tests set a process-global lease location. Rust runs
    // unit tests concurrently, so serialize only the environment mutation.
    static USERDATA_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn linux_fence_writes_private_lease_and_reclaims_process_group() {
        let _environment = USERDATA_ENV_LOCK.lock().expect("userdata environment lock");
        let root =
            std::env::temp_dir().join(format!("dsh-tauri-fence-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("test directory");
        let entry = root.join("desktop-host-main.js");
        fs::write(&entry, b"#!/bin/sh\nsleep 30\n").expect("test entry");
        let mut permissions = fs::metadata(&entry).expect("entry metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&entry, permissions).expect("entry permissions");
        std::env::set_var("DSH_DESKTOP_USERDATA", &root);

        let executable = PathBuf::from("/bin/sh");
        let plan = ProcessFence::prepare(&entry, &executable).expect("prepare fence");
        let mut command = Command::new(&executable);
        command
            .arg(entry.to_str().expect("entry path"))
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn process group");
        let fence = ProcessFence::attach(&child, &entry, &executable, plan).expect("attach fence");

        let lease = root.join("desktop-host.lease.json");
        let mode = fs::metadata(&lease)
            .expect("lease exists")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        drop(fence);
        let _ = child.wait();
        assert!(child.try_wait().expect("wait status").is_some());
        assert!(!lease.exists());

        std::env::remove_var("DSH_DESKTOP_USERDATA");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn linux_fence_reaps_descendants_after_group_leader_exits() {
        let _environment = USERDATA_ENV_LOCK.lock().expect("userdata environment lock");
        let root = std::env::temp_dir().join(format!(
            "dsh-tauri-fence-descendant-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("test directory");
        let entry = root.join("desktop-host-main.sh");
        let child_pid = root.join("child.pid");
        fs::write(
            &entry,
            format!(
                "#!/bin/sh\n( trap '' TERM; sleep 30 ) &\necho $! > '{}'\nsleep 0.2\n",
                child_pid.display()
            ),
        )
        .expect("test entry");
        let mut permissions = fs::metadata(&entry).expect("entry metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&entry, permissions).expect("entry permissions");

        std::env::set_var("DSH_DESKTOP_USERDATA", &root);
        let executable = PathBuf::from("/bin/sh");
        let plan = ProcessFence::prepare(&entry, &executable).expect("prepare fence");
        let mut command = Command::new(&executable);
        command
            .arg(entry.to_str().expect("entry path"))
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn process group");
        let fence = ProcessFence::attach(&child, &entry, &executable, plan).expect("attach fence");

        for _ in 0..100 {
            if child_pid.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let descendant: i32 = fs::read_to_string(&child_pid)
            .expect("descendant pid")
            .trim()
            .parse()
            .expect("numeric descendant pid");
        let _ = child.wait();
        assert!(unsafe { libc::kill(descendant, 0) == 0 });

        drop(fence);
        for _ in 0..100 {
            if unsafe { libc::kill(descendant, 0) != 0 } {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(unsafe { libc::kill(descendant, 0) != 0 });

        std::env::remove_var("DSH_DESKTOP_USERDATA");
        let _ = fs::remove_dir_all(root);
    }
}
