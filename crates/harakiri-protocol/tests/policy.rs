use harakiri_protocol::policy::MissionPolicy;
use serde_json::json;

#[test]
fn unknown_terms_never_downgrade_to_unlimited_or_peer_mode() {
    let base = json!({"coordination":"coordinated","participation":"private","budget":{"mode":"unlimited"}});
    serde_json::from_value::<MissionPolicy>(base.clone())
        .unwrap()
        .validate()
        .unwrap();
    for (field, value) in [
        ("coordination", json!("automatic_election")),
        ("participation", json!("open")),
        ("budget", json!({"mode":"unlimited","turns":20})),
        ("budget", json!({"mode":"unrecognized"})),
    ] {
        let mut policy = base.clone();
        policy[field] = value;
        assert!(serde_json::from_value::<MissionPolicy>(policy).is_err());
    }
}

#[test]
fn bounded_policy_requires_positive_safe_limits() {
    let mut policy = json!({"coordination":"peer","participation":"approval","budget":{"mode":"limited","turns":null,"concurrency":null,"deadline_ms":null,"tokens":null,"model_cost_microusd":null}});
    assert!(
        serde_json::from_value::<MissionPolicy>(policy.clone())
            .unwrap()
            .validate()
            .is_err()
    );
    policy["budget"]["turns"] = json!(20);
    serde_json::from_value::<MissionPolicy>(policy.clone())
        .unwrap()
        .validate()
        .unwrap();
    for (field, value) in [
        ("tokens", 0u64),
        ("deadline_ms", 9_007_199_254_740_992),
        ("concurrency", 1025),
    ] {
        let mut invalid = policy.clone();
        invalid["budget"][field] = json!(value);
        assert!(
            serde_json::from_value::<MissionPolicy>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    policy["budget"]["turns"] = json!(-1);
    assert!(serde_json::from_value::<MissionPolicy>(policy).is_err());
}
