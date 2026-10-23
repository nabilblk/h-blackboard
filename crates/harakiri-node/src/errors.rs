//! Only stable, allowlisted failures cross the local application boundary.
use std::sync::LazyLock;

static CATALOG: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/node-errors.json"))
        .expect("valid error catalog")
});

pub fn public_code(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        let text = cause.to_string();
        for (code, definition) in CATALOG.as_object().expect("error catalog object") {
            if definition["internal"].as_array().is_some_and(|aliases| {
                aliases
                    .iter()
                    .any(|alias| alias.as_str() == Some(text.as_str()))
            }) {
                return code;
            }
        }
    }
    "operation_rejected"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_errors_never_disclose_payloads_or_paths() {
        assert_eq!(
            public_code(&anyhow::anyhow!("private /Users/person token=secret")),
            "operation_rejected"
        );
        assert_eq!(
            public_code(&anyhow::anyhow!("execution capacity busy").context("sensitive input")),
            "capacity_busy"
        );
        assert_eq!(
            public_code(&anyhow::anyhow!("execution capacity busy: secret")),
            "operation_rejected"
        );
        assert_eq!(
            public_code(&anyhow::anyhow!(
                "message recipient is an agent registration; use identity.author"
            )),
            "recipient_registration"
        );
    }
}
