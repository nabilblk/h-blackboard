//! Versioned native service IPC. Renderer input never supplies bootstrap keys or paths.
//! Keys arrive once over inherited stdin, never arguments, environment or logs.
use crate::{
    admission::Access,
    contact::NetworkConfig,
    network::Network,
    peer::{SharedStore, with_store},
    store::Store,
};
use anyhow::{Result, bail, ensure};
use harakiri_protocol::{
    Identity, MissionDefinition, Payload,
    lifecycle::{ControlAction, CoordinatorIdentity},
    limits,
    policy::Coordination,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub const IPC_VERSION: u16 = 1;
const MAX_INPUT: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    version: u16,
    profile: PathBuf,
    owner_seed: String,
    transport_seed: String,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProfileIdentity {
    version: u16,
    owner: String,
    endpoint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u32,
    pub command: Command,
}

#[derive(Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    ReserveLocal {
        mission: String,
        control: String,
        registration: String,
        grant: String,
        consent: String,
        nonce: String,
        limits: crate::governance::LocalAllowance,
    },
    Governance {
        mission: String,
    },
    Govern {
        mission: String,
        control: String,
        action: harakiri_protocol::governance::GovernanceAction,
    },
    MissionAction {
        mission: String,
        revision: String,
        action: ControlAction,
    },
    PrivateRecovery {
        mission: String,
        audience: String,
    },
    ReconcilePrivate {
        mission: String,
        audience: String,
        member: String,
        revocation: String,
        accepted: Option<String>,
    },
    Artifacts {
        mission: String,
        query: harakiri_protocol::artifacts::ArtifactQuery,
    },
    ArtifactDetail {
        mission: String,
        revision: String,
    },
    ArtifactAction {
        mission: String,
        control: String,
        conversation: String,
        action: harakiri_protocol::artifacts::ArtifactAction,
    },
    ArtifactTransfer {
        mission: String,
        transfer: harakiri_protocol::artifacts::ArtifactTransfer,
    },
    State {},
    Missions {
        before: Option<String>,
    },
    CreateMission {
        definition: MissionDefinition,
    },
    UpdateInstructions {
        mission: String,
        revision: String,
        definition: MissionDefinition,
    },
    SetCoordination {
        mission: String,
        revision: String,
        mode: Coordination,
    },
    SetPlan {
        mission: String,
        revision: String,
        text: String,
    },
    StartMission {
        mission: String,
        revision: String,
        readiness: Option<String>,
    },
    PauseMission {
        mission: String,
        revision: String,
        reason: String,
    },
    // Native host only, after checking the actual prepared contribution. The
    // derived credential is never returned through IPC or renderer preload.
    AppointCoordinator {
        mission: String,
        revision: String,
        contribution: String,
        label: String,
        runtime: String,
    },
    WorkEvidence {
        mission: String,
        event: String,
    },
    Workstreams {
        mission: String,
    },
    Tasks {
        mission: String,
        query: harakiri_protocol::work::TaskQuery,
    },
    Work {
        mission: String,
        revision: String,
        action: harakiri_protocol::work::WorkAction,
    },
    Agents {
        mission: String,
        after: Option<String>,
    },
    ShareAgent {
        mission: String,
        terms: String,
        contribution: String,
        label: String,
        contributor_name: String,
        runtime: String,
        role: harakiri_protocol::agents::AgentRole,
    },
    WithdrawAgent {
        mission: String,
        registration: String,
    },
    DirectAgent {
        mission: String,
        revision: String,
        registration: String,
        text: String,
    },
    // Host-only scoped interface. Never exposed through the renderer preload.
    AgentRequest {
        mission: String,
        contribution: String,
        registration: String,
        operation: crate::communication::AgentOperation,
    },
    OpenAgentConversation {
        mission: String,
        registration: String,
    },
    QueryMessages {
        mission: String,
        query: crate::communication::MessageQuery,
    },
    MarkMessagesRead {
        mission: String,
        ids: Vec<String>,
    },
    NetworkState {},
    ConfigureNetwork {
        config: NetworkConfig,
    },
    DiscoveryState {},
    ConfigureDiscovery {
        config: crate::discovery::DiscoveryConfig,
    },
    PublishListing {
        mission: String,
        summary: String,
        capabilities: Vec<String>,
        active: bool,
    },
    WithdrawMission {
        mission: String,
    },
    Withdrawals {},
    ReviewContribution {
        mission: String,
    },
    IssueInvitation {
        mission: String,
    },
    InspectInvitation {
        ticket: String,
    },
    RequestJoin {
        ticket: String,
        reviewed_mission: String,
        reviewed_revision: String,
    },
    LocalJoins {},
    Peers {
        mission: String,
    },
    DecideJoin {
        mission: String,
        author: String,
        admit: bool,
    },
    RevokeInvitations {
        mission: String,
    },
    RevokeMember {
        mission: String,
        author: String,
    },
    CreateAudience {
        mission: String,
        readers: Vec<String>,
    },
    Audiences {
        mission: String,
    },
    PostMessage {
        mission: String,
        audience: Option<String>,
        text: String,
        to: Option<String>,
        thread: Option<String>,
    },
    Messages {
        mission: String,
        audience: Option<String>,
        before: Option<String>,
    },
    Shutdown {},
}

fn seed(value: &str) -> Result<[u8; 32]> {
    ensure!(harakiri_protocol::event::is_hash(value), "invalid key");
    hex::decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid key"))
}

// A missing complete prefix is clean EOF only if no prefix byte was received.
fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    if input.read(&mut length[..1])? == 0 {
        return Ok(None);
    }
    input.read_exact(&mut length[1..])?;
    let length = u32::from_be_bytes(length) as usize;
    ensure!((1..=MAX_INPUT).contains(&length), "invalid frame length");
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

fn write_frame(output: &mut impl Write, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() <= limits::MAX_FRAME_BYTES, "response limit");
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}

fn regular_file(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure!(metadata.is_file(), "invalid profile file");
    }
    Ok(())
}

fn open_profile(root: &Path, identity: &ProfileIdentity) -> Result<File> {
    // The native host must create and choose the private directory. The proof
    // refuses arbitrary existing state and does not migrate the web database.
    ensure!(root.is_absolute(), "profile path must be absolute");
    let metadata = fs::symlink_metadata(root)?;
    ensure!(metadata.is_dir(), "profile must be a directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        ensure!(metadata.mode() & 0o077 == 0, "profile must be private");
        for item in fs::read_dir(root)? {
            let item = item?;
            let name = item.file_name();
            if name == "blobs" {
                ensure!(
                    fs::symlink_metadata(item.path())?.is_dir(),
                    "invalid blob directory"
                );
                continue;
            }
            ensure!(
                [
                    "identity.json",
                    "profile.lock",
                    "node.sqlite",
                    "node.sqlite-shm",
                    "node.sqlite-wal"
                ]
                .iter()
                .any(|allowed| name == *allowed),
                "not a node proof profile"
            );
            regular_file(&item.path())?;
        }
        let lock_path = root.join("profile.lock");
        regular_file(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)?;
        lock.try_lock()?;
        let path = root.join("identity.json");
        if path.exists() {
            ensure!(fs::metadata(&path)?.len() <= 1024, "invalid identity file");
            let previous: ProfileIdentity = serde_json::from_slice(&fs::read(path)?)?;
            ensure!(&previous == identity, "profile identity mismatch");
        } else {
            ensure!(
                !root.join("node.sqlite").exists(),
                "missing profile identity"
            );
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(&serde_json::to_vec(identity)?)?;
            file.sync_all()?;
            File::open(root)?.sync_all()?;
        }
        Ok(lock)
    }
    #[cfg(not(unix))]
    {
        let _ = identity;
        bail!("node proof currently requires Unix profile permissions")
    }
}

pub fn run(name: &str, require_policy: bool) -> Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments == ["--types"] {
        print!("{}", typescript());
        return Ok(());
    }
    if arguments == ["--version"] {
        println!(
            "{name} {} protocol={} ipc={IPC_VERSION}",
            env!("CARGO_PKG_VERSION"),
            limits::VERSION
        );
        return Ok(());
    }
    ensure!(
        arguments == ["--stdio"],
        "use --stdio, --types or --version"
    );
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let Some(bytes) = read_frame(&mut input)? else {
        bail!("missing bootstrap")
    };
    let bytes = zeroize::Zeroizing::new(bytes);
    let bootstrap: Bootstrap = serde_json::from_slice(&bytes)?;
    ensure!(bootstrap.version == IPC_VERSION, "unsupported IPC version");
    let identity = Identity::from_seed(seed(&bootstrap.owner_seed)?);
    let transport = iroh::SecretKey::from_bytes(&seed(&bootstrap.transport_seed)?);
    let profile = ProfileIdentity {
        version: 1,
        owner: identity.public_key(),
        endpoint: transport.public().to_string(),
    };
    let _lock = open_profile(&bootstrap.profile, &profile)?;
    let store: SharedStore = Arc::new(Mutex::new(Store::open(
        &bootstrap.profile.join("node.sqlite"),
    )?));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let root = bootstrap.profile.clone();
    drop(bootstrap);
    drop(bytes);
    write_frame(
        &mut output,
        &serde_json::json!({ "ready": true, "version": IPC_VERSION, "identity": profile, "network": "disabled", "execution": "unavailable" }),
    )?;
    let mut network = runtime.block_on(Network::open(
        &root,
        identity.clone(),
        transport,
        store.clone(),
    ))?;
    let mut artifacts = crate::artifact_io::ArtifactIo::new(&root);
    while let Some(bytes) = read_frame(&mut input)? {
        let request: Request = serde_json::from_slice(&bytes)?;
        let mut shutdown = false;
        let result: Result<serde_json::Value> = runtime.block_on(async {
            match request.command {
                Command::ArtifactTransfer{mission,transfer}=>artifacts.transfer(&network,&store,&identity,&mission,transfer).await,
                Command::AgentRequest{mission,contribution,registration,operation:crate::communication::AgentOperation::ArtifactTransfer{transfer}}=>{
                    let agent=with_store(&store,|s|s.bound_agent_identity(&identity,&mission,&contribution,&registration))?;
                    artifacts.transfer(&network,&store,&agent,&mission,transfer).await
                },
                Command::NetworkState {} => Ok(serde_json::to_value(network.view())?),
                Command::ConfigureNetwork {config} => {network.configure(config).await?;Ok(serde_json::to_value(network.view())?)},
                Command::ConfigureDiscovery{config}=>{network.configure_discovery(config).await?;Ok(serde_json::Value::Null)},
                Command::DiscoveryState{}=>with_store(&store,|s|Ok(serde_json::json!({"config":s.discovery_config()?,"listings":s.listing_views()?,"peer_ticket":if s.discovery_config()?.enabled {network.peer_ticket().ok()} else {None}}))),
                Command::PublishListing{mission,summary,capabilities,active}=>Ok(serde_json::json!({"reference":network.publish(&mission,summary,capabilities,active).await?})),
                Command::IssueInvitation {mission} => Ok(serde_json::json!({"ticket":network.issue(&mission).await?})),
                Command::InspectInvitation {ticket} => {
                    let inspection=network.active()?.inspect(&ticket,network.config()).await?;
                    Ok(serde_json::to_value(inspection.review(&ticket,None)?)?)
                }
                Command::RequestJoin {ticket,reviewed_mission,reviewed_revision} => {
                    let peer=network.active()?;
                    let invite=Access::parse(&ticket)?;
                    ensure!(invite.mission==reviewed_mission,"review does not match invitation");
                    let inspection=peer.inspect(&ticket,network.config()).await?;
                    ensure!(inspection.review(&ticket,None)?.reviewed_revision==reviewed_revision,"mission terms changed; review again");
                    let mission=with_store(&store,|s|s.remember_join(&ticket,&inspection))?;
                    // The durable request is retried by the network worker. The
                    // renderer need not wait for approval or an unbounded pull.
                    Ok(serde_json::json!({"mission":mission}))
                }
                command => with_store(&store,|store| match command {
                    Command::ReserveLocal{mission,control,registration,grant,consent,nonce,limits}=>{let e=store.reserve_local(&identity,&mission,&control,&registration,&grant,&consent,&nonce,limits)?;Ok(serde_json::json!({"event":e.id,"execution_available":false}))},
                    Command::Governance{mission}=>Ok(serde_json::to_value(store.governance(&mission,&identity.public_key())?)?),
                    Command::Govern{mission,control,action}=>{let e=store.govern(&identity,&mission,&control,action)?;Ok(serde_json::json!({"event":e.id}))},
                    Command::MissionAction{mission,revision,action}=>{let e=store.control(&identity,&mission,&revision,action)?;Ok(serde_json::json!({"event":e.id}))},
                    Command::PrivateRecovery{mission,audience}=>store.private_recovery(&mission,&audience,&identity.public_key()),
                    Command::ReconcilePrivate{mission,audience,member,revocation,accepted}=>{let e=store.append_to(&identity,&mission,&audience,Payload::AudienceFrontier{member,revocation,accepted})?;Ok(serde_json::json!({"event":e.id}))},
                    Command::Artifacts{mission,query}=>Ok(serde_json::to_value(store.artifacts(&mission,&identity.public_key(),query)?)?),
                    Command::ArtifactDetail{mission,revision}=>Ok(serde_json::to_value(store.artifact_detail(&mission,&identity.public_key(),&revision)?)?),
                    Command::ArtifactAction{mission,control,conversation,action}=>{
                        ensure!(!matches!(action,harakiri_protocol::artifacts::ArtifactAction::Publish{..}),"publication requires file transfer");
                        let e=store.artifact_action(&identity,&mission,&control,&conversation,action)?;Ok(serde_json::json!({"event":e.id}))
                    },
                    Command::State {} => Ok(serde_json::to_value(store.missions()?)?),
                    Command::Missions {before} => Ok(serde_json::to_value(store.mission_page(before)?)?),
                    Command::CreateMission {definition} => {
                        ensure!(!require_policy || definition.policy.is_some(),"mission policy required");
                        let event=store.create(&identity,profile.endpoint.clone(),definition)?;
                        Ok(serde_json::json!({"mission":event.id}))
                    }
                    Command::UpdateInstructions{mission,revision,definition}=>{
                        let e=store.control(&identity,&mission,&revision,ControlAction::UpdateInstructions{definition})?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::SetCoordination{mission,revision,mode}=>{
                        let e=store.control(&identity,&mission,&revision,ControlAction::SetCoordination{mode,coordinator:None})?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::SetPlan{mission,revision,text}=>{
                        let e=store.control(&identity,&mission,&revision,ControlAction::SetPlan{text})?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::StartMission{mission,revision,readiness}=>{
                        let participants=store.start_participants(&mission)?;
                        let e=store.control(&identity,&mission,&revision,ControlAction::Start{readiness,participants})?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::PauseMission{mission,revision,reason}=>{
                        let e=store.control(&identity,&mission,&revision,ControlAction::Pause{reason})?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::AppointCoordinator{mission,revision,contribution,label,runtime}=>{
                        let c=identity.coordinator_identity(&mission,&contribution)?;
                        let e=store.control(&identity,&mission,&revision,ControlAction::SetCoordination{mode:Coordination::Coordinated,coordinator:Some(CoordinatorIdentity{author:c.public_key(),label,runtime})})?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::PostMessage {mission,audience,text,to,thread} => {
                        let event=store.send_message(&identity,&mission,audience.as_deref().unwrap_or("main"),text,to,thread)?;
                        Ok(serde_json::json!({"event":event.id}))
                    }
                    Command::AgentRequest {mission,contribution,registration,operation} => store.agent_request(&identity,&mission,&contribution,&registration,operation),
                    Command::OpenAgentConversation {mission,registration} => Ok(serde_json::json!({"audience":store.open_agent_conversation(&identity,&mission,&registration)?})),
                    Command::QueryMessages {mission,query} => Ok(serde_json::to_value(store.query_messages(&mission,&identity.public_key(),query)?)?),
                    Command::MarkMessagesRead {mission,ids} => {store.mark_messages_read(&mission,&identity.public_key(),&ids)?;Ok(serde_json::Value::Null)},
                    Command::WorkEvidence{mission,event}=>Ok(serde_json::to_value(store.work_evidence(&mission,&identity.public_key(),&event)?)?),
                    Command::Workstreams{mission}=>Ok(serde_json::to_value(store.workstreams(&mission,&identity.public_key())?)?),
                    Command::Tasks{mission,query}=>Ok(serde_json::to_value(store.tasks(&mission,&identity.public_key(),query)?)?),
                    Command::Work{mission,revision,action}=>{let e=store.work(&identity,&mission,&revision,action)?;Ok(serde_json::json!({"event":e.id}))},
                    Command::Agents{mission,after} => Ok(serde_json::to_value(store.agent_page(&mission,after)?)?),
                    Command::ShareAgent{mission,terms,contribution,label,contributor_name,runtime,role} => {
                        let agent=identity.coordinator_identity(&mission,&contribution)?;
                        let offered=store.offer_agent(&identity,&mission,&terms,harakiri_protocol::agents::AgentIdentity{author:agent.public_key(),label,contributor_name,runtime,role})?;
                        Ok(serde_json::json!({"registration":offered.id,"author":agent.public_key()}))
                    }
                    Command::WithdrawAgent{mission,registration} => {
                        let e=store.withdraw_agent(&identity,&mission,&registration)?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::DirectAgent{mission,revision,registration,text} => {
                        let e=store.direct_agent(&identity,&mission,&revision,&registration,text)?;
                        Ok(serde_json::json!({"event":e.id}))
                    }
                    Command::Messages {mission,audience,before} => Ok(serde_json::to_value(store.query_messages(&mission,&identity.public_key(),crate::communication::MessageQuery::conversation(audience.as_deref().unwrap_or("main"),before))?)?),
                    Command::LocalJoins {} => Ok(serde_json::to_value(store.local_joins()?)?),
                    Command::Withdrawals {} => Ok(serde_json::to_value(store.withdrawal_views()?)?),
                    Command::WithdrawMission{mission}=>{store.withdraw(&identity,&mission,&profile.endpoint)?;Ok(serde_json::Value::Null)},
                    Command::ReviewContribution{mission}=>{
                        ensure!(store.can_read(&mission,&profile.endpoint)? && !store.conflicted(&mission)?,"participation unavailable");
                        let current=store.control_state(&mission)?;
                        Ok(serde_json::json!({"mission":mission,"owner":store.owner(&mission)?,"definition":current.definition,"reviewed_revision":current.lifecycle.terms_revision}))
                    }
                    Command::Peers {mission} => Ok(serde_json::json!({
                        "members":store.members(&mission)?,"delivery":store.deliveries(&mission,"main")?,
                        "requests":if store.owner(&mission)?==identity.public_key() {store.requests(&mission)?} else {vec![]}
                    })),
                    Command::DecideJoin {mission,author,admit} => {store.decide_join(&identity,&mission,&author,admit)?;Ok(serde_json::Value::Null)},
                    Command::RevokeInvitations {mission} => {store.revoke_invitations(&identity,&mission)?;Ok(serde_json::Value::Null)},
                    Command::RevokeMember {mission,author} => {
                        let accepted=store.head(&mission,&author)?.map(|h|h.id);
                        let event=store.append(&identity,&mission,Payload::MemberRevoked {member:author,accepted})?;
                        Ok(serde_json::json!({"event":event.id}))
                    }
                    Command::CreateAudience {mission,mut readers} => {
                        readers.push(identity.public_key());readers.sort();readers.dedup();
                        ensure!(readers.iter().all(|r|store.is_revoked(&mission,r).is_ok_and(|b|!b)),"revoked reader");
                        let audience=format!("private:{}",hex::encode(rand::random::<[u8;32]>()));
                        store.append_to(&identity,&mission,&audience,Payload::AudienceCreated {readers})?;
                        Ok(serde_json::json!({"audience":audience}))
                    }
                    // Revocation stops network disclosure and new writes; it
                    // cannot take away the human's previously saved history.
                    Command::Audiences {mission} => Ok(serde_json::to_value(store.local_audiences(&mission,&identity.public_key())?)?),
                    Command::Shutdown {} => {shutdown=true;Ok(serde_json::Value::Null)},
                    _ => bail!("invalid local command"),
                })
            }
        });
        // Never echo input or internal errors: they can contain paths or text.
        let response = match result {
            Ok(value) => serde_json::json!({ "id": request.id, "ok": true, "value": value }),
            Err(_) => {
                serde_json::json!({ "id": request.id, "ok": false, "error": "operation_rejected" })
            }
        };
        write_frame(&mut output, &response)?;
        if shutdown {
            break;
        }
    }
    runtime.block_on(network.stop())?;
    Ok(())
}

impl Drop for Bootstrap {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.owner_seed.zeroize();
        self.transport_seed.zeroize();
    }
}

pub fn typescript() -> String {
    use crate::store::{MessagePage, MessageView, MissionPage, MissionView};
    use harakiri_protocol::lifecycle::{
        ControlAction, CoordinatorIdentity, CoordinatorView, LifecycleView, MissionPhase, PlanView,
        ReadinessView,
    };
    use harakiri_protocol::policy::{Coordination, MissionBudget, MissionPolicy, Participation};
    use ts_rs::TS;
    let cfg = ts_rs::Config::default().with_large_int("number");
    let declarations = [
        Coordination::decl(&cfg),
        Participation::decl(&cfg),
        MissionBudget::decl(&cfg),
        MissionPolicy::decl(&cfg),
        MissionDefinition::decl(&cfg),
        CoordinatorIdentity::decl(&cfg),
        CoordinatorView::decl(&cfg),
        PlanView::decl(&cfg),
        ReadinessView::decl(&cfg),
        LifecycleView::decl(&cfg),
        MissionPhase::decl(&cfg),
        ControlAction::decl(&cfg),
        harakiri_protocol::agents::AgentRole::decl(&cfg),
        harakiri_protocol::agents::AgentIdentity::decl(&cfg),
        harakiri_protocol::agents::AgentStatus::decl(&cfg),
        harakiri_protocol::agents::DirectionView::decl(&cfg),
        harakiri_protocol::agents::AgentView::decl(&cfg),
        harakiri_protocol::agents::AgentPage::decl(&cfg),
        MissionView::decl(&cfg),
        MessageView::decl(&cfg),
        MessagePage::decl(&cfg),
        MissionPage::decl(&cfg),
        crate::contact::NetworkMode::decl(&cfg),
        NetworkConfig::decl(&cfg),
        crate::network::NetworkView::decl(&cfg),
        crate::admission::InvitationReview::decl(&cfg),
        crate::admission::JoinView::decl(&cfg),
        crate::admission::LocalJoinView::decl(&cfg),
        crate::scope::MemberView::decl(&cfg),
        crate::scope::DeliveryView::decl(&cfg),
        crate::scope::AudienceView::decl(&cfg),
        crate::discovery::DiscoveryConfig::decl(&cfg),
        crate::contact::Contact::decl(&cfg),
        crate::discovery::Advertisement::decl(&cfg),
        crate::discovery::ListingView::decl(&cfg),
        crate::withdrawal::WithdrawalView::decl(&cfg),
        crate::communication::MessageFeed::decl(&cfg),
        crate::communication::MessageQuery::decl(&cfg),
        crate::communication::AgentOperation::decl(&cfg),
        crate::communication::AgentContext::decl(&cfg),
        harakiri_protocol::ArtifactFile::decl(&cfg),
        harakiri_protocol::work::WorkEvidence::decl(&cfg),
        harakiri_protocol::work::WorkLink::decl(&cfg),
        harakiri_protocol::work::TaskDefinition::decl(&cfg),
        harakiri_protocol::work::AttemptStatus::decl(&cfg),
        harakiri_protocol::work::WorkAction::decl(&cfg),
        harakiri_protocol::work::WorkstreamRevision::decl(&cfg),
        harakiri_protocol::work::WorkstreamView::decl(&cfg),
        harakiri_protocol::work::WorkstreamAssignmentView::decl(&cfg),
        harakiri_protocol::work::TaskRevision::decl(&cfg),
        harakiri_protocol::work::AttemptReport::decl(&cfg),
        harakiri_protocol::work::AttemptView::decl(&cfg),
        harakiri_protocol::work::TaskView::decl(&cfg),
        harakiri_protocol::work::TaskQuery::decl(&cfg),
        harakiri_protocol::work::TaskPage::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactKind::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactStage::decl(&cfg),
        harakiri_protocol::artifacts::ReviewVerdict::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactDocument::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactAction::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactQuery::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactSummary::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactPage::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactRevisionSummary::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactReviewView::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactDecision::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactDetail::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactFileRef::decl(&cfg),
        harakiri_protocol::artifacts::ArtifactTransfer::decl(&cfg),
        harakiri_protocol::governance::GovernanceAction::decl(&cfg),
        harakiri_protocol::governance::GovernanceView::decl(&cfg),
        harakiri_protocol::governance::AllocationView::decl(&cfg),
        harakiri_protocol::governance::GrantView::decl(&cfg),
        harakiri_protocol::governance::ReservationView::decl(&cfg),
        harakiri_protocol::governance::CriterionView::decl(&cfg),
        crate::governance::LocalAllowance::decl(&cfg),
        Command::decl(&cfg),
    ];
    format!(
        "// Generated from Rust. Run npm run node:types; do not edit.\n{}\n",
        declarations
            .iter()
            .map(|d| format!("export {d}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
