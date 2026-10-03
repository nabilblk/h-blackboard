fn main() {
    if harakiri_node::ipc::run("harakiri-node-proof", false).is_err() {
        eprintln!(
            "Node proof refused startup or input; profile preserved. No agents were started."
        );
        std::process::exit(1);
    }
}
