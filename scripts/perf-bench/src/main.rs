//! nexus-bench: resource usage of a whole process tree (the app plus every
//! child process, e.g. WebView2 or Electron helpers), sampled with native
//! Windows APIs so Nexus and Discord are measured exactly the same way.
//!
//! RAM is reported two ways:
//! - working set: physical memory currently mapped (what Task Manager's
//!   "Memory" column approximates, includes shared pages);
//! - private bytes: committed memory owned by the processes (no sharing).
//!
//! CPU is % of ONE logical core summed over the tree (100% = one full core),
//! plus the same value normalised to the whole machine.

use std::{
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "nexus-bench", about = "Measure RAM/CPU/startup of a process tree")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Sample an already running app (all instances of the executable + children)
    Measure {
        /// Executable name, e.g. nexus-desktop.exe or Discord.exe
        #[arg(long)]
        process: String,
        /// Seconds to sample
        #[arg(long, default_value_t = 60)]
        duration: u64,
        /// Seconds between samples
        #[arg(long, default_value_t = 1.0)]
        interval: f64,
        /// Scenario label written to the output (e.g. "idle", "call-2")
        #[arg(long, default_value = "run")]
        label: String,
        /// Optional CSV with one row per sample
        #[arg(long)]
        csv: Option<PathBuf>,
    },
    /// Launch the app N times and measure time until the UI reports ready
    Startup {
        /// Path to the app executable
        #[arg(long)]
        exe: PathBuf,
        #[arg(long, default_value_t = 5)]
        runs: u32,
        /// Seconds to wait for each run
        #[arg(long, default_value_t = 30)]
        timeout: u64,
    },
}

#[derive(Clone, Copy, Debug, Default)]
struct Sample {
    processes: usize,
    working_set: u64,
    private_bytes: u64,
    /// Sum of kernel+user time over the tree, 100 ns units.
    cpu_time: u64,
}

#[cfg(windows)]
mod win {
    use std::collections::HashSet;

    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
            },
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX},
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ},
        },
    };

    use super::Sample;

    pub struct Proc {
        pub pid: u32,
        pub parent: u32,
        pub name: String,
    }

    pub fn processes() -> Vec<Proc> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut e = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    out.push(Proc {
                        pid: e.th32ProcessID,
                        parent: e.th32ParentProcessID,
                        name: String::from_utf16_lossy(&e.szExeFile[..len]),
                    });
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    /// Every process named `exe` plus all descendants.
    pub fn tree(exe: &str) -> HashSet<u32> {
        let procs = processes();
        let mut set: HashSet<u32> = procs
            .iter()
            .filter(|p| p.name.eq_ignore_ascii_case(exe))
            .map(|p| p.pid)
            .collect();
        loop {
            let before = set.len();
            for p in &procs {
                if set.contains(&p.parent) && p.pid != 0 {
                    set.insert(p.pid);
                }
            }
            if set.len() == before {
                return set;
            }
        }
    }

    fn ft(f: FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    pub fn sample(pids: &HashSet<u32>) -> Sample {
        let mut s = Sample::default();
        for &pid in pids {
            unsafe {
                let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid) else {
                    continue;
                };
                let mut mem = PROCESS_MEMORY_COUNTERS_EX {
                    cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                    ..Default::default()
                };
                if GetProcessMemoryInfo(h, &mut mem as *mut _ as *mut PROCESS_MEMORY_COUNTERS, mem.cb).is_ok() {
                    s.working_set += mem.WorkingSetSize as u64;
                    s.private_bytes += mem.PrivateUsage as u64;
                    s.processes += 1;
                }
                let (mut c, mut e, mut k, mut u) = (
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                );
                if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok() {
                    s.cpu_time += ft(k) + ft(u);
                }
                let _ = CloseHandle(h);
            }
        }
        s
    }
}

fn mb(bytes: f64) -> f64 {
    bytes / (1024.0 * 1024.0)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

#[cfg(windows)]
fn measure(process: &str, duration: u64, interval: f64, label: &str, csv: Option<PathBuf>) -> anyhow::Result<()> {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    let mut pids = win::tree(process);
    if pids.is_empty() {
        anyhow::bail!("no running process named {process}");
    }
    let mut csv_out = match &csv {
        Some(p) => {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::File::create(p)?;
            writeln!(f, "t_s,processes,working_set_mb,private_mb,cpu_core_pct")?;
            Some(f)
        }
        None => None,
    };
    let start = Instant::now();
    let mut prev = win::sample(&pids);
    let mut prev_t = Instant::now();
    let (mut ws, mut pb, mut cpu) = (Vec::new(), Vec::new(), Vec::new());
    let mut procs = prev.processes;
    eprintln!("sampling {process} ({} processes) for {duration}s...", pids.len());
    while start.elapsed() < Duration::from_secs(duration) {
        std::thread::sleep(Duration::from_secs_f64(interval));
        // Children come and go (WebView2 utility processes): refresh the tree.
        pids = win::tree(process);
        let s = win::sample(&pids);
        let dt = prev_t.elapsed().as_secs_f64();
        // cpu_time is in 100 ns units; 1e7 per second of one core.
        let cpu_pct = (s.cpu_time.saturating_sub(prev.cpu_time)) as f64 / 1e7 / dt * 100.0;
        prev = s;
        prev_t = Instant::now();
        procs = procs.max(s.processes);
        ws.push(mb(s.working_set as f64));
        pb.push(mb(s.private_bytes as f64));
        cpu.push(cpu_pct);
        if let Some(f) = csv_out.as_mut() {
            writeln!(
                f,
                "{:.1},{},{:.1},{:.1},{:.2}",
                start.elapsed().as_secs_f64(),
                s.processes,
                mb(s.working_set as f64),
                mb(s.private_bytes as f64),
                cpu_pct
            )?;
        }
    }
    let avg = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    let max = |v: &[f64]| v.iter().copied().fold(0.0, f64::max);
    let mut sorted_cpu = cpu.clone();
    sorted_cpu.sort_by(|a, b| a.total_cmp(b));
    println!("scenario:        {label}");
    println!("process:         {process} (+children, up to {procs} processes)");
    println!("samples:         {} x {interval}s", cpu.len());
    println!("working set MB:  avg {:.1}  max {:.1}", avg(&ws), max(&ws));
    println!("private MB:      avg {:.1}  max {:.1}", avg(&pb), max(&pb));
    println!(
        "CPU (% of 1 core): avg {:.2}  p95 {:.2}  max {:.2}   (machine: avg {:.2}% of {} cores)",
        avg(&cpu),
        percentile(&sorted_cpu, 0.95),
        max(&cpu),
        avg(&cpu) / cores,
        cores
    );
    println!(
        "markdown: | {label} | {:.0} | {:.0} | {:.2} | {:.2} |",
        avg(&ws),
        avg(&pb),
        avg(&cpu),
        percentile(&sorted_cpu, 0.95)
    );
    Ok(())
}

#[cfg(windows)]
fn startup(exe: &std::path::Path, runs: u32, timeout: u64) -> anyhow::Result<()> {
    let name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid exe path"))?
        .to_string();
    if !win::tree(&name).is_empty() {
        anyhow::bail!("{name} is already running; close it first (also from the tray)");
    }
    let mut results = Vec::new();
    for i in 1..=runs {
        let marker = std::env::temp_dir().join(format!("nexus-startup-{}-{i}.txt", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let t0 = Instant::now();
        let mut child = std::process::Command::new(exe)
            .env("NEXUS_BENCH_STARTUP_FILE", &marker)
            .spawn()?;
        let mut ready = None;
        while t0.elapsed() < Duration::from_secs(timeout) {
            if let Ok(v) = std::fs::read_to_string(&marker)
                && let Ok(ms) = v.trim().parse::<u64>()
            {
                ready = Some((ms, t0.elapsed().as_millis() as u64));
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Measure idle memory right after startup settles.
        std::thread::sleep(Duration::from_secs(3));
        let s = win::sample(&win::tree(&name));
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &child.id().to_string()])
            .output();
        let _ = child.wait();
        let _ = std::fs::remove_file(&marker);
        match ready {
            Some((in_app, wall)) => {
                println!(
                    "run {i}: ready after {wall} ms (in-app {in_app} ms), working set {:.0} MB, private {:.0} MB",
                    mb(s.working_set as f64),
                    mb(s.private_bytes as f64)
                );
                results.push(wall as f64);
            }
            None => println!("run {i}: no ready signal within {timeout}s"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    if !results.is_empty() {
        results.sort_by(|a, b| a.total_cmp(b));
        println!(
            "startup ms: median {:.0}  min {:.0}  max {:.0}  (n={})",
            percentile(&results, 0.5),
            results[0],
            results[results.len() - 1],
            results.len()
        );
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    #[cfg(windows)]
    match cli.cmd {
        Cmd::Measure {
            process,
            duration,
            interval,
            label,
            csv,
        } => measure(&process, duration, interval, &label, csv),
        Cmd::Startup { exe, runs, timeout } => startup(&exe, runs, timeout),
    }
    #[cfg(not(windows))]
    {
        let _ = cli;
        anyhow::bail!("nexus-bench only supports Windows")
    }
}
