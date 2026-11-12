use clap::Parser;
use rslack::config::Config;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("rslack=info")),
        )
        .init();
    let config = Config::parse();
    rslack::serve(config).await
}
