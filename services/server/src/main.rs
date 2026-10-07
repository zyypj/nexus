use clap::{Parser, Subcommand};
use nexus_server::{Config, admin_cli};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "nexus-server", version, about = "Nexus API + gateway server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP API and WebSocket gateway (default)
    Serve,
    /// Administrative commands (invites, users)
    Admin {
        #[command(subcommand)]
        cmd: admin_cli::AdminCommand,
    },
}

fn init_tracing(level: &str) {
    // sqlx logs every statement at info; keep it quiet unless asked.
    let filter =
        EnvFilter::try_new(format!("{level},sqlx=warn,tower_http=warn")).unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        // A few dozen users never need one thread per core on big hosts.
        .worker_threads(std::thread::available_parallelism().map_or(2, |n| n.get().min(4)))
        .enable_all()
        .build()?;

    runtime.block_on(async move {
        match cli.command.unwrap_or(Command::Serve) {
            Command::Serve => {
                let config = Config::from_env()?;
                init_tracing(&config.log_level);
                nexus_server::serve(config).await
            }
            Command::Admin { cmd } => {
                init_tracing("warn");
                admin_cli::run(cmd).await
            }
        }
    })
}
