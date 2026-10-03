fn main() {
    if harakiri_node::ipc::run("harakiri-node", true).is_err() {
        eprintln!("Node refused startup or input; profile preserved. No agents were started.");
        std::process::exit(1);
    }
}
